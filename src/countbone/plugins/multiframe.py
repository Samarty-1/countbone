"""Pipeline-layer plugin: an object must be seen more than once to be real.

A single-frame sighting is usually a reflection, a shadow edge, or a hand.
This plugin discards tracks with too little corroboration and flags tracks
whose identity kept changing between frames.
"""

from __future__ import annotations

from collections import Counter
from typing import Any

from ..context import RunContext
from ..types import Track
from .base import Plugin, register


@register
class MultiFrameValidation(Plugin):
    """Require corroboration across frames before an object counts."""

    name = "multiframe"
    layer = "pipeline"
    priority = 20

    def configure(
        self,
        min_frames: int = 2,
        min_agreement: float = 0.6,
        drop_unstable: bool = False,
        **_: Any,
    ) -> None:
        self.min_frames = int(min_frames)
        self.min_agreement = float(min_agreement)
        # Unstable identity is usually a real object seen badly, so the default
        # is to flag it for review rather than throw the object away.
        self.drop_unstable = bool(drop_unstable)

    def on_tracks(self, ctx: RunContext, tracks: list[Track]) -> list[Track]:
        kept: list[Track] = []
        rejected: list[dict[str, Any]] = []
        unstable: list[int] = []

        for track in tracks:
            votes = Counter(i.sku for i in track.items)
            agreement = votes[track.sku] / track.hits if track.hits else 0.0
            for item in track.items:
                item.meta["agreement"] = round(agreement, 3)

            if track.hits < self.min_frames:
                rejected.append(
                    {"track_id": track.track_id, "sku": track.sku,
                     "reason": "single_frame", "hits": track.hits}
                )
                continue
            if agreement < self.min_agreement:
                unstable.append(track.track_id)
                if self.drop_unstable:
                    rejected.append(
                        {"track_id": track.track_id, "sku": track.sku,
                         "reason": "identity_flicker", "agreement": round(agreement, 3)}
                    )
                    continue
                for item in track.items:
                    item.meta["identity_flicker"] = True
            kept.append(track)

        ctx.state["multiframe"] = {
            "kept": len(kept),
            "rejected": rejected,
            "unstable_tracks": unstable,
        }
        return kept

    def on_counts(self, ctx: RunContext, result):
        stats = ctx.state.get("multiframe", {})
        if not stats:
            return result
        result.meta["multiframe"] = {
            "tracks_kept": stats["kept"],
            "tracks_rejected": len(stats["rejected"]),
            "rejected_detail": stats["rejected"][:50],
            "unstable_tracks": stats["unstable_tracks"],
        }
        if stats["unstable_tracks"]:
            result.warnings.append(
                f"{len(stats['unstable_tracks'])} object(s) changed identity between frames"
            )
        return result
