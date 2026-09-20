"""Output-layer plugin: route what the system is unsure about to a person.

The queue is the honest half of the product. Every item it raises carries the
crop the model saw, so the reviewer decides from evidence rather than from
trust.
"""

from __future__ import annotations

from typing import Any

import cv2

from ..context import RunContext
from ..types import CountResult, ReviewItem, new_id
from .base import Plugin, register


@register
class ReviewQueue(Plugin):
    """Route low-confidence items to a human, with the evidence attached."""

    name = "review_queue"
    layer = "output"
    priority = 50

    def configure(
        self,
        sku_threshold: float = 0.60,
        item_threshold: float = 0.55,
        max_items: int = 40,
        save_crops: bool = True,
        review_unknown: bool = True,
        **_: Any,
    ) -> None:
        self.sku_threshold = float(sku_threshold)
        self.item_threshold = float(item_threshold)
        self.max_items = int(max_items)
        self.save_crops = bool(save_crops)
        self.review_unknown = bool(review_unknown)

    def on_items(self, ctx: RunContext, frame, items):
        """Collect low-confidence sightings as they go past.

        Done here rather than at the end because the frame is still in hand;
        by on_counts the pixels may have aged out of the cache.
        """
        pending: list[dict[str, Any]] = ctx.setdefault("review_candidates", list)
        unknown_sku = ctx.config.identify.unknown_sku
        for item in items:
            is_unknown = self.review_unknown and item.sku == unknown_sku
            if item.confidence >= self.item_threshold and not is_unknown:
                continue
            pending.append(
                {
                    "sku": item.sku,
                    "reason": "unidentified" if is_unknown else "low_item_confidence",
                    "confidence": item.confidence,
                    "frame_index": frame.index,
                    "bbox": item.detection.bbox,
                    "crop": self._crop(frame, item) if self.save_crops else None,
                    "meta": {"id_source": item.id_source, **item.meta},
                }
            )
        return items

    def on_counts(self, ctx: RunContext, result: CountResult) -> CountResult:
        candidates = sorted(
            ctx.state.get("review_candidates", []), key=lambda c: c["confidence"]
        )
        reviews: list[ReviewItem] = []

        # A whole SKU whose count is doubtful is one review task, not N.
        for sku_count in result.counts:
            if sku_count.confidence >= self.sku_threshold:
                continue
            reviews.append(
                ReviewItem(
                    review_id=new_id("rev"),
                    run_id=result.run_id,
                    sku=sku_count.sku,
                    reason="low_sku_confidence",
                    confidence=sku_count.confidence,
                    frame_index=-1,
                    meta={
                        "count": sku_count.count,
                        "expected": sku_count.expected,
                        "scope": "sku",
                    },
                )
            )

        for cand in candidates[: self.max_items]:
            reviews.append(
                ReviewItem(
                    review_id=new_id("rev"),
                    run_id=result.run_id,
                    sku=cand["sku"],
                    reason=cand["reason"],
                    confidence=cand["confidence"],
                    frame_index=cand["frame_index"],
                    bbox=cand["bbox"],
                    crop_path=self._write_crop(ctx, cand),
                    meta={**cand["meta"], "scope": "item"},
                )
            )

        result.reviews.extend(reviews)
        if reviews:
            result.needs_review = True
        result.meta["review_queue"] = {
            "raised": len(reviews),
            "candidates_seen": len(candidates),
            "truncated": max(0, len(candidates) - self.max_items),
        }
        return result

    # -- crops -----------------------------------------------------------
    @staticmethod
    def _crop(frame, item):
        h, w = frame.image.shape[:2]
        x1, y1, x2, y2 = item.detection.bbox
        pad = 8
        xi1, yi1 = max(0, int(x1) - pad), max(0, int(y1) - pad)
        xi2, yi2 = min(w, int(x2) + pad), min(h, int(y2) + pad)
        if xi2 <= xi1 or yi2 <= yi1:
            return None
        return frame.image[yi1:yi2, xi1:xi2].copy()

    def _write_crop(self, ctx: RunContext, cand: dict[str, Any]) -> str | None:
        image = cand.get("crop")
        if image is None or not self.save_crops:
            return None
        crops_dir = ctx.artifacts_dir / "crops"
        crops_dir.mkdir(parents=True, exist_ok=True)
        name = f"f{cand['frame_index']:05d}_{cand['sku']}_{int(cand['confidence'] * 100):03d}.jpg"
        path = crops_dir / name
        cv2.imwrite(str(path), image)
        return str(path.relative_to(ctx.artifacts_dir))
