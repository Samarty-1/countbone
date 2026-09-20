"""Capture-layer plugin: refuse frames the detector cannot work with.

Counting from a blurred or blown-out frame produces a confident wrong answer,
which is worse than no answer. This gate drops those frames and records why,
so the capture app can tell the operator to slow down or turn a light on.
"""

from __future__ import annotations

from typing import Any

from ..context import RunContext
from ..types import Frame
from .base import Plugin, register


@register
class QualityGate(Plugin):
    """Drop frames too blurred or badly lit to count from."""

    name = "quality_gate"
    layer = "capture"
    priority = 10

    def configure(
        self,
        min_blur: float = 45.0,
        min_brightness: float = 35.0,
        max_brightness: float = 225.0,
        max_clipped_frac: float = 0.28,
        max_drop_rate: float = 0.5,
        **_: Any,
    ) -> None:
        self.min_blur = float(min_blur)
        self.min_brightness = float(min_brightness)
        self.max_brightness = float(max_brightness)
        self.max_clipped_frac = float(max_clipped_frac)
        self.max_drop_rate = float(max_drop_rate)

    def on_run_start(self, ctx: RunContext) -> None:
        ctx.state["quality"] = {"seen": 0, "dropped": 0, "reasons": {}, "scores": []}

    def on_frame(self, ctx: RunContext, frame: Frame) -> Frame | None:
        stats = ctx.state.setdefault(
            "quality", {"seen": 0, "dropped": 0, "reasons": {}, "scores": []}
        )
        stats["seen"] += 1

        q = frame.meta.get("quality")
        if not q:  # preprocess.grayscale_stats disabled: nothing to judge on
            return frame

        reason = self._reject_reason(q)
        stats["scores"].append(q["blur"])
        if reason is None:
            return frame

        stats["dropped"] += 1
        stats["reasons"][reason] = stats["reasons"].get(reason, 0) + 1
        return None  # dropping the frame

    def _reject_reason(self, q: dict[str, float]) -> str | None:
        if q["blur"] < self.min_blur:
            return "blurred"
        if q["brightness"] < self.min_brightness:
            return "too_dark"
        if q["brightness"] > self.max_brightness:
            return "too_bright"
        if q["clipped_frac"] > self.max_clipped_frac:
            return "clipped"
        return None

    def on_counts(self, ctx: RunContext, result):
        stats = ctx.state.get("quality", {})
        seen = stats.get("seen", 0)
        if not seen:
            return result
        rate = stats.get("dropped", 0) / seen
        result.meta["capture_quality"] = {
            "frames_seen": seen,
            "frames_dropped": stats.get("dropped", 0),
            "drop_rate": round(rate, 4),
            "reasons": stats.get("reasons", {}),
        }
        if rate > self.max_drop_rate:
            # Not an error: the count may still be right. But a human should
            # know most of the footage was unusable before they sign it off.
            result.warnings.append(
                f"{rate:.0%} of frames failed the quality gate "
                f"({stats.get('reasons')}); re-shoot recommended"
            )
            result.needs_review = True
        return result
