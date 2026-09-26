"""Live progress and the frame inspector, for the dashboard.

Two plugins rather than one, because a plugin has a single priority and these
need opposite ends of the chain: the intake must see every frame before the
quality gate can drop it, and the tail must see detections, items and tracks
after every other plugin has had its say.

Both are attached by the API, never named in a config: they exist to feed the
dashboard, and a CLI run has no one to report progress to.
"""

from __future__ import annotations

import json
import math
import time
from collections.abc import Callable
from typing import Any

from ..context import RunContext
from ..plugins.base import Plugin
from ..stages import capture
from ..types import CountResult, Frame, Item, Track

Report = Callable[..., None]

# Frames arrive far faster than anyone reads a dashboard; publishing every one
# only buys lock contention with the request threads.
PUBLISH_EVERY_S = 0.25


def _state(ctx: RunContext) -> dict[str, Any]:
    return ctx.state["telemetry"]


def _publish(ctx: RunContext, report: Report, force: bool = False) -> None:
    t = _state(ctx)
    now = time.time()
    if not force and now - t["published_at"] < PUBLISH_EVERY_S:
        return
    t["published_at"] = now
    elapsed = max(now - t["started_at"], 1e-6)
    blur = t["blur"]
    bright = t["brightness"]
    report(
        ctx.run_id,
        phase=t["phase"],
        telemetry={
            "frames_expected": t["frames_expected"],
            "frames_read": t["frames_read"],
            "frames_kept": t["frames_kept"],
            "frames_dropped": t["frames_read"] - t["frames_kept"],
            "detections": t["detections"],
            "items": t["items"],
            "tracks": t["tracks"],
            "fps": round(t["frames_read"] / elapsed, 2),
            "elapsed_s": round(elapsed, 2),
            "blur": round(blur[-1], 1) if blur else None,
            "blur_avg": round(sum(blur) / len(blur), 1) if blur else None,
            "brightness": round(bright[-1], 1) if bright else None,
            "brightness_avg": round(sum(bright) / len(bright), 1) if bright else None,
        },
    )


class TelemetryIntake(Plugin):
    """Sees every frame, before anything can drop it."""

    name = "dashboard_intake"
    layer = "capture"
    priority = 0

    def __init__(self, report: Report) -> None:
        super().__init__()
        self.report = report

    def on_run_start(self, ctx: RunContext) -> None:
        cap = ctx.config.capture
        try:
            probe = capture.probe(ctx.source)
        except Exception:  # noqa: BLE001 - progress is best effort, the run is not
            probe = {}
        expected = None
        if probe.get("frame_count"):
            expected = math.ceil(probe["frame_count"] / max(1, cap.every_n_frames))
            if cap.max_frames:
                expected = min(expected, cap.max_frames)
        ctx.state["telemetry"] = {
            "started_at": time.time(),
            "published_at": 0.0,
            "phase": "frames",
            "frames_expected": expected,
            "frames_read": 0,
            "frames_kept": 0,
            "detections": 0,
            "items": 0,
            "tracks": 0,
            "blur": [],
            "brightness": [],
            "frames": {},
            "sightings": [],
            "frame_size": None,
        }
        _publish(ctx, self.report, force=True)

    def on_frame(self, ctx: RunContext, frame: Frame) -> Frame:
        t = _state(ctx)
        t["frames_read"] += 1
        q = frame.meta.get("quality") or {}
        if "blur" in q:
            t["blur"].append(q["blur"])
            t["brightness"].append(q["brightness"])
        t["frames"][frame.index] = {
            "index": frame.index,
            "source_index": frame.source_index,
            "t": frame.timestamp_s,
            "kept": False,
            "quality": {k: round(v, 3) for k, v in q.items()},
        }
        if t["frame_size"] is None:
            t["frame_size"] = list(frame.shape)
        _publish(ctx, self.report)
        return frame


class TelemetryTail(Plugin):
    """Sees the final word on every frame, and writes the inspector file.

    Priority 85 puts on_output after the exception report and before the
    audit pack, so inspector.json is hashed into the manifest like any other
    artifact.
    """

    name = "dashboard_tail"
    layer = "output"
    priority = 85

    def __init__(self, report: Report) -> None:
        super().__init__()
        self.report = report

    def on_detections(self, ctx: RunContext, frame: Frame, detections):
        t = _state(ctx)
        t["frames_kept"] += 1
        t["detections"] += len(detections)
        if frame.index in t["frames"]:
            t["frames"][frame.index]["kept"] = True
        return detections

    def on_items(self, ctx: RunContext, frame: Frame, items: list[Item]) -> list[Item]:
        t = _state(ctx)
        t["items"] += len(items)
        # References, not copies: the tracker writes track_id onto these same
        # objects after this hook, and an Item holds no pixels.
        t["sightings"].extend(items)
        _publish(ctx, self.report)
        return items

    def on_tracks(self, ctx: RunContext, tracks: list[Track]) -> list[Track]:
        t = _state(ctx)
        t["phase"] = "count"
        t["tracks"] = len(tracks)
        t["counted_tracks"] = {tr.track_id for tr in tracks}
        # A track's SKU is the majority vote of its sightings; that is what
        # was counted, so it is what the inspector should label the box with.
        t["track_sku"] = {tr.track_id: tr.sku for tr in tracks}
        _publish(ctx, self.report, force=True)
        return tracks

    def on_counts(self, ctx: RunContext, result: CountResult) -> CountResult:
        _state(ctx)["phase"] = "output"
        _publish(ctx, self.report, force=True)
        return result

    def on_output(self, ctx: RunContext, result: CountResult) -> None:
        t = _state(ctx)
        counted = t.get("counted_tracks", set())
        track_sku = t.get("track_sku", {})
        boxes = [
            {
                "frame": item.frame_index,
                "bbox": [round(v, 1) for v in item.detection.bbox],
                "sku": item.sku,  # this frame's guess
                "track_sku": track_sku.get(item.track_id),  # what the object was counted as
                "label": item.label,
                "confidence": round(item.confidence, 4),
                "track_id": item.track_id,
                "counted": item.track_id is not None and item.track_id in counted,
            }
            for item in t["sightings"]
        ]
        doc = {
            "run_id": result.run_id,
            "frame_size": t["frame_size"],
            "source_info": result.meta.get("source_info"),
            "frames": sorted(t["frames"].values(), key=lambda f: f["index"]),
            "boxes": boxes,
        }
        path = ctx.artifacts_dir / "inspector.json"
        path.write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
        result.meta.setdefault("outputs", {})["inspector"] = str(path)

    def on_run_end(self, ctx: RunContext, result: CountResult | None) -> None:
        if "telemetry" not in ctx.state:
            return
        _state(ctx)["phase"] = "done" if result is not None else "failed"
        _publish(ctx, self.report, force=True)
        # The sightings list is the one large thing held here; let it go now
        # rather than whenever the context is collected.
        _state(ctx)["sightings"] = []


def attach(plugins: list[Plugin], report: Report) -> list[Plugin]:
    """Return the plugin list with both telemetry plugins in priority order."""
    out = [*plugins, TelemetryIntake(report), TelemetryTail(report)]
    out.sort(key=lambda p: p.priority)
    return out
