"""The backbone.

    Capture -> Pre-process -> Detect -> Identify -> Count -> Output

That sequence is the product. It does not change when a capability is added;
capabilities attach to it as plugins through the hooks fired below. If you
find yourself editing this file to add a feature, the feature is a plugin.
"""

from __future__ import annotations

import logging
import time
from collections import defaultdict
from pathlib import Path

from .catalog import Catalog
from .config import Config
from .context import RunContext
from .plugins import base as plugin_base
from .stages import capture, count, detect, identify, motion, output, preprocess
from .store.db import Store
from .types import CountResult, Item

log = logging.getLogger(__name__)


class Pipeline:
    """Runs one video to one result.

    A Pipeline is reusable across runs: the per-run state lives in the
    RunContext, not on self.
    """

    def __init__(self, config: Config | None = None, store: Store | None = None) -> None:
        self.config = config or Config()
        self.catalog = Catalog.load(self.config.identify.catalog)
        self.detector = detect.build(self.config.detect)
        self.identifier = identify.build(self.config.identify, self.catalog)
        self.plugins = plugin_base.build(self.config.plugins)
        self.store = store
        if store is None and self.config.output.sqlite:
            self.store = Store(self.config.output.sqlite)
        log.info(
            "pipeline ready: detect=%s identify=%s count=%s plugins=[%s]",
            self.config.detect.backend,
            self.config.identify.backend,
            self.config.count.strategy,
            ", ".join(p.name for p in self.plugins),
        )

    # -- public API ------------------------------------------------------
    def run(self, source: str | int, run_id: str | None = None) -> CountResult:
        ctx = RunContext(config=self.config, source=str(source), store=self.store)
        if run_id:
            ctx.run_id = run_id
        result: CountResult | None = None
        try:
            result = self._run(ctx, source)
            return result
        finally:
            plugin_base.fire(self.plugins, "on_run_end", ctx, result)

    # -- the six stages --------------------------------------------------
    def _run(self, ctx: RunContext, source: str | int) -> CountResult:
        cfg = self.config
        started = time.time()
        result = CountResult(run_id=ctx.run_id, source=str(source), started_at=started)

        try:
            result.meta["source_info"] = capture.probe(source)
        except capture.CaptureError:
            raise
        except Exception as exc:  # noqa: BLE001 - probing is best effort
            ctx.warn(f"could not probe source: {exc}")

        # Plugins get the catalog through the context rather than a constructor
        # argument, so a plugin can be written without touching the backbone.
        ctx.state["catalog"] = self.catalog
        plugin_base.fire(self.plugins, "on_run_start", ctx)

        tracker = count.Tracker(
            iou_threshold=cfg.count.track_iou, max_gap=cfg.count.track_max_gap
        )
        camera = motion.MotionEstimator()
        per_frame: dict[int, list[Item]] = defaultdict(list)
        # Only the frame-tally strategies need every sighting kept; tracking
        # does not, and on a long run that is a lot of objects held for nothing.
        needs_per_frame = cfg.count.strategy in ("peak_frame", "median_frame")

        for frame in capture.frames(source, cfg.capture):          # 1. Capture
            result.frames_read += 1

            frame = preprocess.apply(frame, cfg.preprocess)         # 2. Pre-process
            # Estimated before the quality gate can drop the frame, so a
            # dropped frame still contributes its share of camera movement.
            frame.meta["motion"] = camera.update(frame.image)

            # Capture-layer plugins may reject a frame outright.
            kept = plugin_base.fire(
                self.plugins, "on_frame", ctx, frame, transform=True, allow_drop=True
            )
            if kept is None:
                result.frames_dropped += 1
                # The frame is gone, its camera movement is not (see Tracker).
                tracker.observe_motion(frame.meta.get("motion"))
                continue
            frame = kept
            result.frames_used += 1

            detections = self.detector.detect(frame)                # 3. Detect
            detections = plugin_base.fire(
                self.plugins, "on_detections", ctx, frame, detections, transform=True
            )
            result.detections += len(detections)

            items = self.identifier.identify(frame, detections)     # 4. Identify
            items = plugin_base.fire(
                self.plugins, "on_items", ctx, frame, items, transform=True
            )

            if needs_per_frame:
                per_frame[frame.index] = items
            tracker.update(frame.index, items, frame.meta.get("motion"))  # 5. Count

        tracks = plugin_base.fire(
            self.plugins, "on_tracks", ctx, tracker.tracks, transform=True
        )
        result = count.finalise(result, tracks, dict(per_frame), cfg.count, self.catalog)
        result = plugin_base.fire(
            self.plugins, "on_counts", ctx, result, transform=True
        )

        result.warnings = list(dict.fromkeys(result.warnings + ctx.warnings))
        result.finished_at = time.time()
        result.meta["config_fingerprint"] = cfg.fingerprint()
        result.meta["plugins"] = [p.name for p in self.plugins]
        result.meta["artifacts_dir"] = str(ctx.artifacts_dir)

        written = output.emit(ctx, result, cfg.output)               # 6. Output
        result.meta["outputs"] = written
        plugin_base.fire(self.plugins, "on_output", ctx, result)
        # Persist last: output plugins add artifacts and metadata, and a run
        # should become visible to readers only once all of it exists.
        written.update(output.persist(ctx, result))
        return result


def run_video(
    source: str | Path,
    config: Config | None = None,
    run_id: str | None = None,
) -> CountResult:
    """One-call entry point: video in, result out."""
    return Pipeline(config).run(str(source), run_id=run_id)
