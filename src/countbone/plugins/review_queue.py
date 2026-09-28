"""Output-layer plugin: route what the system is unsure about to a person.

The queue is the honest half of the product. Every item it raises carries the
crop the model saw, so the reviewer decides from evidence rather than from
trust.

Three kinds of question are raised:

  low_sku_confidence   a whole SKU's number is doubtful (one task, not N)
  low_item_confidence  one object's identity is doubtful
  unidentified         an object nobody could name
  possible_missed_item an object seen clearly but only once, which the
                       counter discards as noise; usually a real carton at
                       the edge of the walk, occasionally a reflection

Item-level questions are asked once per tracked object, not once per frame,
and carry the track id, so a decision can change the count (ops.final).
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
        review_single_sightings: bool = True,
        single_min_confidence: float = 0.6,
        settled_agreement: float = 0.7,
        **_: Any,
    ) -> None:
        # An object seen 3+ times whose sightings agree at least this much is
        # settled by its own vote; its odd doubtful frame raises no question.
        self.settled_agreement = float(settled_agreement)
        self.sku_threshold = float(sku_threshold)
        self.item_threshold = float(item_threshold)
        self.max_items = int(max_items)
        # Headroom above max_items, so trimming is occasional rather than
        # every frame, while the buffer stays bounded.
        self.candidate_cap = max(self.max_items * 2, self.max_items + 20)
        self.save_crops = bool(save_crops)
        self.review_unknown = bool(review_unknown)
        self.review_single_sightings = bool(review_single_sightings)
        self.single_min_confidence = float(single_min_confidence)

    def on_items(self, ctx: RunContext, frame, items):
        """Collect low-confidence sightings as they go past.

        Done here rather than at the end because the frame is still in hand;
        by on_counts the pixels may have aged out of the cache.
        """
        pending: list[dict[str, Any]] = ctx.setdefault("review_candidates", list)
        unknown_sku = ctx.config.identify.unknown_sku
        for index, item in enumerate(items):
            is_unknown = self.review_unknown and item.sku == unknown_sku
            if item.confidence >= self.item_threshold and not is_unknown:
                continue
            pending.append(
                {
                    "sku": item.sku,
                    "reason": "unidentified" if is_unknown else "low_item_confidence",
                    "confidence": item.confidence,
                    "frame_index": frame.index,
                    "index_in_frame": index,
                    "bbox": item.detection.bbox,
                    "crop": self._crop(frame, item) if self.save_crops else None,
                    # The tracker writes track_id onto this same object later.
                    "item": item,
                    "meta": {"id_source": item.id_source, **_public_meta(item.meta)},
                }
            )
        self._trim(pending)
        return items

    def on_frame_tracked(self, ctx: RunContext, frame, items) -> None:
        """Remember the one sighting of objects seen once so far.

        Most tracks get a second sighting a frame later and are forgotten
        here; what is left at the end is exactly the set of objects the
        counter will discard for being seen only once.
        """
        if not self.review_single_sightings:
            return
        hits: dict[int, int] = ctx.setdefault("review_track_hits", dict)
        singles: dict[int, dict[str, Any]] = ctx.setdefault("review_singles", dict)
        for index, item in enumerate(items):
            tid = item.track_id
            if tid is None:
                continue
            hits[tid] = hits.get(tid, 0) + 1
            if hits[tid] == 1 and item.confidence >= self.single_min_confidence:
                singles[tid] = {
                    "sku": item.sku,
                    "reason": "possible_missed_item",
                    "confidence": item.confidence,
                    "frame_index": frame.index,
                    "index_in_frame": index,
                    "bbox": item.detection.bbox,
                    "crop": self._crop(frame, item) if self.save_crops else None,
                    "item": item,
                    "meta": {"id_source": item.id_source, **_public_meta(item.meta)},
                }
                if len(singles) > self.candidate_cap:
                    # Oldest first: a long-open track is likely to be seen again.
                    del singles[next(iter(singles))]
            elif hits[tid] >= 2:
                singles.pop(tid, None)

    def on_tracks(self, ctx: RunContext, tracks):
        ctx.state["review_track_index"] = {t.track_id: (t.sku, t.hits) for t in tracks}
        # How firmly each object's sightings agree on what it is. One doubtful
        # frame of an object seen ten times, nine of them clearly, is settled
        # by the vote; asking a person about it is noise.
        ctx.state["review_track_agreement"] = {
            t.track_id: (sum(i.sku == t.sku for i in t.items) / len(t.items)) if t.items else 0.0
            for t in tracks
        }
        return tracks

    def _trim(self, pending: list[dict[str, Any]]) -> None:
        """Keep only the least confident candidates.

        Every candidate holds a decoded crop, so on a long run with poor
        footage an untrimmed list is unbounded memory. Only `max_items` can
        ever be raised, so holding a small multiple of that is enough to keep
        the eventual selection identical.
        """
        if len(pending) <= self.candidate_cap:
            return
        pending.sort(key=lambda c: c["confidence"])
        del pending[self.max_items :]

    def _one_per_track(self, candidates: list[dict[str, Any]], index) -> list[dict[str, Any]]:
        """Ask about each object once.

        The object's least confident sighting ranks it (how doubtful it is),
        but the picture shown is its most complete view: the largest box.
        The least confident sighting is often a partial or odd detection
        (a label patch, an object half out of frame), and a reviewer shown
        that would be deciding about the wrong thing.
        """
        by_track: dict[int, list[dict[str, Any]]] = {}
        out = []
        for cand in candidates:
            tid = cand["item"].track_id
            if tid is None:
                out.append(cand)
            else:
                by_track.setdefault(tid, []).append(cand)

        def area(c: dict[str, Any]) -> float:
            x1, y1, x2, y2 = c["bbox"]
            return (x2 - x1) * (y2 - y1)

        for group in by_track.values():
            shown = dict(max(group, key=area))
            shown["confidence"] = min(c["confidence"] for c in group)
            out.append(shown)
        return sorted(out, key=lambda c: c["confidence"])

    def on_counts(self, ctx: RunContext, result: CountResult) -> CountResult:
        index: dict[int, tuple[str, int]] = ctx.state.get("review_track_index", {})
        agreement: dict[int, float] = ctx.state.get("review_track_agreement", {})
        min_hits = ctx.config.count.min_hits
        unknown_sku = ctx.config.identify.unknown_sku

        def settled(cand: dict[str, Any]) -> bool:
            tid = cand["item"].track_id
            if tid is None or tid not in index:
                return False
            sku, hits = index[tid]
            return (sku != unknown_sku and hits >= max(min_hits, 3)
                    and agreement.get(tid, 0.0) >= self.settled_agreement)

        candidates = self._one_per_track(
            [c for c in ctx.state.get("review_candidates", []) if not settled(c)], index
        )
        singles = [
            c for tid, c in ctx.state.get("review_singles", {}).items()
            if index.get(tid, ("", 0))[1] < min_hits
        ]
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

        # Unsure identities first (they can move units between SKUs), then
        # possible misses, highest-confidence first (most likely real).
        ranked = candidates[: self.max_items]
        room = max(0, self.max_items - len(ranked))
        ranked += sorted(singles, key=lambda c: -c["confidence"])[:room]
        for cand in ranked:
            tid = cand["item"].track_id
            track_sku, hits = index.get(tid, (None, 0)) if tid is not None else (None, 0)
            reviews.append(
                ReviewItem(
                    review_id=new_id("rev"),
                    run_id=result.run_id,
                    sku=track_sku or cand["sku"],
                    reason=cand["reason"],
                    confidence=cand["confidence"],
                    frame_index=cand["frame_index"],
                    bbox=cand["bbox"],
                    crop_path=self._write_crop(ctx, cand),
                    meta={
                        **cand["meta"],
                        "scope": "item",
                        "track_id": tid,
                        "track_sku": track_sku,
                        "counted": hits >= min_hits,
                        "sighting_sku": cand["sku"],
                    },
                )
            )

        result.reviews.extend(reviews)
        if reviews:
            result.needs_review = True
        result.meta["review_queue"] = {
            "raised": len(reviews),
            "candidates_seen": len(candidates),
            "possible_misses": len(singles),
            "truncated": max(0, len(candidates) + len(singles) - self.max_items),
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
        # The index within the frame is part of the name: without it, two
        # identical cartons in one frame overwrite each other's crop and a
        # reviewer is shown evidence belonging to a different item.
        name = (
            f"f{cand['frame_index']:05d}_{cand['index_in_frame']:02d}"
            f"_{cand['sku']}_{int(cand['confidence'] * 100):03d}.jpg"
        )
        path = crops_dir / name
        cv2.imwrite(str(path), image)
        return str(path.relative_to(ctx.artifacts_dir))


def _public_meta(meta: dict[str, Any]) -> dict[str, Any]:
    """Item metadata worth showing a reviewer (not internal bookkeeping)."""
    return {k: v for k, v in meta.items() if k not in ("world", "embedding", "low_confidence")}
