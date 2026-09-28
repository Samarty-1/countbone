"""The backbone.

    Capture -> Pre-process -> Detect -> Identify -> Count -> Output

That sequence is the product. It does not change when a capability is added;
capabilities attach to it as plugins through the hooks fired below. If you
find yourself editing this file to add a feature, the feature is a plugin.
"""

from __future__ import annotations

import logging
import math
import statistics
import time
from collections import defaultdict, deque
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .catalog import Catalog
from .config import Config
from .context import RunContext
from .plugins import base as plugin_base
from .stages import capture, count, detect, identify, motion, output, preprocess
from .store.db import Store
from .types import CountResult, Item

log = logging.getLogger(__name__)

CatalogProvider = Callable[[], Catalog]


class Continuity:
    """How well the tracker could follow the scene between usable frames.

    Confidence used to measure only how sure identification was, so a count
    that lost objects between frames was reported as certain. This measures
    the thing that actually breaks tracking: how far the scene moved between
    two consecutive *kept* frames, in object widths. Dropped frames widen that
    gap; the adaptive sampler narrows it; this records what was achieved.
    """

    RISKY = 0.5   # beyond this, association starts to rely on motion compensation
    BROKEN = 1.0  # beyond this, an object can pass between kept frames unseen

    def __init__(self) -> None:
        self.ratios: list[float] = []
        self.unknown_gaps = 0
        self._last_cum: tuple[float, float] | None = None
        self._cum = (0.0, 0.0)
        self._unknown = False

    def observe(self, motion_: dict[str, float] | None) -> None:
        if motion_ and motion_.get("estimated"):
            self._cum = (self._cum[0] + motion_["dx"], self._cum[1] + motion_["dy"])
        elif self._last_cum is not None:
            self._unknown = True

    def kept(self, box_px: float | None) -> None:
        if self._last_cum is not None and box_px:
            if self._unknown:
                self.unknown_gaps += 1
            else:
                moved = math.hypot(self._cum[0] - self._last_cum[0], self._cum[1] - self._last_cum[1])
                self.ratios.append(moved / box_px)
        self._last_cum = self._cum
        self._unknown = False

    def summary(self) -> dict[str, Any]:
        worst = max(self.ratios, default=0.0)
        risky = sum(r > self.RISKY for r in self.ratios)
        broken = sum(r > self.BROKEN for r in self.ratios)
        # 1.0 while every gap is comfortably followable, falling to 0 as the
        # worst gap approaches three object widths.
        score = 1.0 if worst <= self.RISKY else max(0.0, 1.0 - (worst - self.RISKY) / 2.5)
        if self.unknown_gaps:
            score = min(score, 0.8)
        return {
            "gaps": len(self.ratios),
            "max_shift_objects": round(worst, 3),
            "risky_gaps": int(risky),
            "broken_gaps": int(broken),
            "unknown_gaps": self.unknown_gaps,
            "score": round(score, 4),
        }


class Pipeline:
    """Runs one video to one result.

    A Pipeline is reusable across runs: the per-run state lives in the
    RunContext, not on self.
    """

    def __init__(
        self,
        config: Config | None = None,
        store: Store | None = None,
        catalog_provider: CatalogProvider | None = None,
    ) -> None:
        self.config = config or Config()
        self._catalog_provider = catalog_provider
        self.catalog = catalog_provider() if catalog_provider else Catalog.load(
            self.config.identify.catalog
        )
        self.detector = detect.build(self.config.detect)
        self.identifier = identify.build(self.config.identify, self.catalog)
        self.plugins = plugin_base.build(self.config.plugins)
        self.store = store
        if store is None and self.config.output.sqlite:
            self.store = Store(self.config.output.sqlite)
        log.info(
            "pipeline ready: detect=%s identify=%s count=%s plugins=[%s]",
            self.config.detect.backend,
            self.identifier.name,
            self.config.count.strategy,
            ", ".join(p.name for p in self.plugins),
        )

    def refresh_catalog(self) -> None:
        """Pick up catalog edits (new SKUs, enrolled photos) before a run."""
        if self._catalog_provider is None:
            return
        self.catalog = self._catalog_provider()
        self.identifier = identify.build(self.config.identify, self.catalog)

    # -- public API ------------------------------------------------------
    def run(
        self,
        source: str | int,
        run_id: str | None = None,
        expected: dict[str, int] | None = None,
        context: dict[str, Any] | None = None,
    ) -> CountResult:
        """Count one video.

        `expected` replaces the configured expectations for this run (a
        location's book stock, a purchase order). `context` describes why the
        run exists (location, kind, who filmed it); plugins read and may fill
        it, and it is kept on the result.
        """
        self.refresh_catalog()
        ctx = RunContext(config=self.config, source=str(source), store=self.store)
        if run_id:
            ctx.run_id = run_id
        ctx.state["run_context"] = dict(context or {})
        ctx.state["expected"] = dict(expected) if expected is not None else None
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
        sampler = capture.Sampler(cfg.capture)
        continuity = Continuity()
        widths: deque[float] = deque(maxlen=400)  # recent object widths, for scale
        per_frame: dict[int, list[Item]] = defaultdict(list)
        # Only the frame-tally strategies need every sighting kept; tracking
        # does not, and on a long run that is a lot of objects held for nothing.
        needs_per_frame = cfg.count.strategy in ("peak_frame", "median_frame")

        def box_px() -> float | None:
            return statistics.median(widths) if widths else None

        for frame in capture.frames(source, cfg.capture, sampler):  # 1. Capture
            result.frames_read += 1

            frame = preprocess.apply(frame, cfg.preprocess)         # 2. Pre-process
            # Estimated before the quality gate can drop the frame, so a
            # dropped frame still contributes its share of camera movement.
            frame.meta["motion"] = camera.update(frame.image)
            continuity.observe(frame.meta["motion"])

            # Capture-layer plugins may reject a frame outright.
            kept = plugin_base.fire(
                self.plugins, "on_frame", ctx, frame, transform=True, allow_drop=True
            )
            if kept is None:
                result.frames_dropped += 1
                # The frame is gone, its camera movement is not (see Tracker).
                tracker.observe_motion(frame.meta.get("motion"))
                sampler.feedback(kept=False)
                continue
            frame = kept
            result.frames_used += 1

            detections = self.detector.detect(frame)                # 3. Detect
            detections = plugin_base.fire(
                self.plugins, "on_detections", ctx, frame, detections, transform=True
            )
            result.detections += len(detections)
            widths.extend(d.bbox[2] - d.bbox[0] for d in detections)

            items = self.identifier.identify(frame, detections)     # 4. Identify
            items = plugin_base.fire(
                self.plugins, "on_items", ctx, frame, items, transform=True
            )

            if needs_per_frame:
                per_frame[frame.index] = items
            tracker.update(frame.index, items, frame.meta.get("motion"))  # 5. Count
            frame.meta["offset"] = tracker.offset
            # Track ids are known now and the pixels are still in hand.
            plugin_base.fire(self.plugins, "on_frame_tracked", ctx, frame, items)
            continuity.kept(box_px())
            sampler.feedback(kept=True, box_px=box_px())

        result.meta["sampling"] = {**sampler.stats, "base_step": sampler.base,
                                   "adaptive": sampler.adaptive}
        result.meta["continuity"] = continuity.summary()
        ctx.state["continuity"] = result.meta["continuity"]
        if sampler.truncated:
            ctx.warn(
                f"video longer than the {cfg.capture.max_frames}-frame cap: the end of "
                "it was not counted"
            )
            result.needs_review = True
        broken = result.meta["continuity"]["broken_gaps"]
        if broken:
            ctx.warn(
                f"camera moved more than an object's width between usable frames "
                f"{broken} time(s); items may have been missed (film more slowly)"
            )
            result.needs_review = True

        tracks = plugin_base.fire(
            self.plugins, "on_tracks", ctx, tracker.tracks, transform=True
        )
        result = count.finalise(
            result, tracks, dict(per_frame), cfg.count, self.catalog,
            expected=ctx.state.get("expected"),
        )
        result.meta["tracks_world"] = [
            {"track_id": t.track_id, "sku": t.sku, "hits": t.hits, **w}
            for t in tracks
            if t.hits >= cfg.count.min_hits and (w := count.track_world(t)) is not None
        ]
        result = plugin_base.fire(
            self.plugins, "on_counts", ctx, result, transform=True
        )

        result.meta["context"] = ctx.state.get("run_context", {})
        result.warnings = list(dict.fromkeys(result.warnings + ctx.warnings))
        result.finished_at = time.time()
        result.meta["config_fingerprint"] = cfg.fingerprint()
        result.meta["plugins"] = [p.name for p in self.plugins]
        result.meta["artifacts_dir"] = str(ctx.artifacts_dir)
        result.meta["identifier"] = self.identifier.name

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
