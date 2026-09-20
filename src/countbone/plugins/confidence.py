"""Pipeline-layer plugin: say how sure the system is, per item and per SKU.

Without this the product is a number with no error bar, and a number with no
error bar cannot be signed off by a finance team. Confidence is what makes
the difference between "the AI said 48" and "the AI said 48, and here are the
three it was unsure about".
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ..context import RunContext
from ..types import CountResult, Frame, Item
from .base import Plugin, register


@register
class ConfidenceScoring(Plugin):
    """Score how sure the system is, per item, per SKU and per run."""

    name = "confidence"
    layer = "pipeline"
    priority = 30

    def configure(
        self,
        detect_weight: float = 0.45,
        identify_weight: float = 0.40,
        quality_weight: float = 0.15,
        item_threshold: float = 0.55,
        sku_threshold: float = 0.60,
        run_threshold: float = 0.65,
        **_: Any,
    ) -> None:
        total = detect_weight + identify_weight + quality_weight
        if total <= 0:
            raise ValueError("confidence weights must sum to something positive")
        # Normalised so a user editing one weight cannot silently rescale the
        # whole score.
        self.w_detect = detect_weight / total
        self.w_identify = identify_weight / total
        self.w_quality = quality_weight / total
        self.item_threshold = float(item_threshold)
        self.sku_threshold = float(sku_threshold)
        self.run_threshold = float(run_threshold)

    # -- per item --------------------------------------------------------
    def on_items(self, ctx: RunContext, frame: Frame, items: list[Item]) -> list[Item]:
        """Score each sighting from what is knowable within this frame.

        Cross-frame signals (identity flicker, persistence) deliberately do
        not appear here: they are not known until every frame has been read,
        and they are folded in at track level by count._track_confidence.
        """
        quality = self._frame_quality(frame)
        for item in items:
            score = (
                self.w_detect * item.detection.score
                + self.w_identify * item.id_confidence
                + self.w_quality * quality
            )
            item.confidence = float(np.clip(score, 0.0, 1.0))
            item.meta["low_confidence"] = item.confidence < self.item_threshold
        return items

    @staticmethod
    def _frame_quality(frame: Frame) -> float:
        """Map the raw quality metrics onto 0-1, saturating at "good enough"."""
        q = frame.meta.get("quality")
        if not q:
            return 0.7  # no metrics available; assume workable, do not reward
        sharp = min(1.0, q["blur"] / 150.0)
        lit = 1.0 - min(1.0, abs(q["brightness"] - 128.0) / 128.0)
        clean = 1.0 - min(1.0, q["clipped_frac"] / 0.3)
        return float(np.clip(0.5 * sharp + 0.3 * lit + 0.2 * clean, 0.0, 1.0))

    # -- per SKU and per run ---------------------------------------------
    def on_counts(self, ctx: RunContext, result: CountResult) -> CountResult:
        for sku_count in result.counts:
            # The count stage already scored track quality; fold in how well
            # the whole capture went so a good count off bad footage is not
            # reported as certain.
            capture_term = self._capture_term(ctx)
            blended = 0.75 * sku_count.confidence + 0.25 * capture_term
            sku_count.confidence = float(np.clip(blended, 0.0, 1.0))
            sku_count.evidence["below_threshold"] = (
                sku_count.confidence < self.sku_threshold
            )

        if result.counts:
            total = result.total or 1
            result.overall_confidence = float(
                sum(c.confidence * c.count for c in result.counts) / total
            )
        low = [c.sku for c in result.counts if c.confidence < self.sku_threshold]
        if low or result.overall_confidence < self.run_threshold:
            result.needs_review = True
        result.meta["confidence"] = {
            "item_threshold": self.item_threshold,
            "sku_threshold": self.sku_threshold,
            "run_threshold": self.run_threshold,
            "low_confidence_skus": low,
        }
        return result

    @staticmethod
    def _capture_term(ctx: RunContext) -> float:
        stats = ctx.state.get("quality") or {}
        scores = stats.get("scores") or []
        if not scores:
            return 0.7
        sharpness = min(1.0, float(np.mean(scores)) / 150.0)
        seen = max(stats.get("seen", 1), 1)
        usable = 1.0 - stats.get("dropped", 0) / seen
        return float(np.clip(0.6 * sharpness + 0.4 * usable, 0.0, 1.0))
