"""HTTP API and dashboard.

Deliberately thin: it submits videos to the pipeline, reads the store, and
records review decisions. No counting logic lives here.
"""

from __future__ import annotations

import colorsys
import logging
import re
import shutil
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from ..catalog import SkuEntry
from ..config import Config
from ..pipeline import Pipeline
from ..plugins import base as plugin_base
from ..store.db import Store
from ..types import new_id
from . import telemetry

log = logging.getLogger(__name__)
STATIC_DIR = Path(__file__).parent / "static"
# .webm: the demo writes VP8 WebM, and browsers (incl. the mobile app's web
# preview) record WebM.
VIDEO_SUFFIXES = (".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm")


class DashboardFiles(StaticFiles):
    """The built dashboard, cached correctly.

    Vite fingerprints everything under assets/, so those never change and can
    be cached forever. index.html is the one file that names the current
    fingerprints: it must be revalidated, or a browser keeps running the old
    dashboard against a new API after an upgrade.
    """

    async def get_response(self, path: str, scope):  # type: ignore[override]
        response = await super().get_response(path, scope)
        if path.startswith("assets/"):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            response.headers["Cache-Control"] = "no-cache"
        return response


def _swatch(entry: SkuEntry) -> str | None:
    """A display colour for a catalog entry: its hue band's centre.

    The colour identifier matches on hue, so this is the colour the model
    is actually looking for, not decoration.
    """
    if entry.achromatic:
        return "#9ca3af"
    centre = entry.hue_center()
    if centre is None:
        return None
    r, g, b = colorsys.hsv_to_rgb(centre / 180.0, 0.75, 0.9)  # OpenCV hue is 0-179
    return f"#{int(r * 255):02x}{int(g * 255):02x}{int(b * 255):02x}"


class ReviewDecision(BaseModel):
    status: str = Field(description="accepted | rejected | corrected | pending (reopen)")
    resolved_sku: str | None = None
    resolved_count: int | None = Field(
        default=None, ge=0, description="A reviewer's recount, for a whole-SKU review"
    )
    reviewer: str = "anonymous"


class RunRequest(BaseModel):
    path: str = Field(description="Server-side path to a video file")


class RunTracker:
    """Which runs are in flight. Small enough to keep in memory."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._state: dict[str, dict[str, Any]] = {}

    def set(self, run_id: str, **fields: Any) -> None:
        with self._lock:
            self._state.setdefault(run_id, {"run_id": run_id}).update(fields)

    def get(self, run_id: str) -> dict[str, Any] | None:
        with self._lock:
            return dict(self._state[run_id]) if run_id in self._state else None

    def all(self) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(v) for v in self._state.values()]


def create_app(config: Config | None = None, store: Store | None = None) -> FastAPI:
    cfg = config or Config()
    db = store or Store(cfg.output.sqlite or "countbone.db")
    tracker = RunTracker()
    # One worker: counting is CPU-bound, and a queue is easier to reason about
    # than contention between two runs writing artifacts at once. One worker
    # also means the single Pipeline below is never entered concurrently.
    pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="countbone")
    # Built once: a Pipeline holds no per-run state, and rebuilding it per
    # request would reload the detector's weights every time.
    pipeline = Pipeline(cfg, store=db)
    pipeline.plugins = telemetry.attach(pipeline.plugins, tracker.set)
    uploads = Path(cfg.output.dir) / "_uploads"
    uploads.mkdir(parents=True, exist_ok=True)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        yield
        pool.shutdown(wait=False, cancel_futures=True)

    app = FastAPI(
        lifespan=lifespan,
        title="countbone",
        version="0.1.0",
        description="Video in, counts out. Everything else is a plugin.",
    )
    app.state.config = cfg
    app.state.store = db
    app.state.tracker = tracker

    # -- helpers ---------------------------------------------------------
    def submit(source: str, run_id: str) -> None:
        tracker.set(run_id, status="queued", source=source, error=None)

        def work() -> None:
            tracker.set(run_id, status="running")
            try:
                result = pipeline.run(source, run_id=run_id)
                tracker.set(
                    run_id,
                    status="done",
                    total=result.total,
                    needs_review=result.needs_review,
                    confidence=round(result.overall_confidence, 4),
                )
            except Exception as exc:  # noqa: BLE001 - surfaced to the client
                log.exception("run %s failed", run_id)
                tracker.set(run_id, status="failed", error=str(exc))

        pool.submit(work)

    # -- routes ----------------------------------------------------------
    @app.get("/api/health")
    def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "detect": cfg.detect.backend,
            "identify": cfg.identify.backend,
            "count": cfg.count.strategy,
            "unknown_sku": cfg.identify.unknown_sku,
            "plugins": [p.name for p in pipeline.plugins if not isinstance(
                p, (telemetry.TelemetryIntake, telemetry.TelemetryTail))],
        }

    @app.get("/api/catalog")
    def catalog() -> list[dict[str, Any]]:
        return [
            {"sku": e.sku, "label": e.label, "hue": list(e.hue) if e.hue else None,
             "achromatic": e.achromatic, "min_saturation": e.min_saturation,
             "unit_value": e.unit_value,
             "expected": e.expected, "swatch": _swatch(e)}
            for e in pipeline.catalog.entries
        ]

    @app.get("/api/plugins")
    def plugins() -> list[dict[str, Any]]:
        enabled = {p.name for p in cfg.plugins if p.enabled}
        return [
            {"name": name, "layer": cls.layer, "priority": cls.priority,
             "enabled": name in enabled, "doc": (cls.__doc__ or "").strip().split("\n")[0]}
            for name, cls in sorted(plugin_base.available().items())
        ]

    @app.post("/api/runs/upload", status_code=202)
    # Sync on purpose: FastAPI runs it in a worker thread. As `async def`, the
    # blocking copy below stalls the event loop, and every progress poll with
    # it, for as long as a large aisle video takes to write.
    def upload_run(file: UploadFile) -> dict[str, Any]:
        run_id = new_id("run")
        suffix = (Path(file.filename or "upload.mp4").suffix or ".mp4").lower()
        if suffix not in VIDEO_SUFFIXES:
            raise HTTPException(
                415, f"unsupported file type {suffix}; expected {', '.join(VIDEO_SUFFIXES)}"
            )
        # The original name rides in the stored filename, so the run is still
        # recognisable after a restart (the tracker is memory-only). Reduced to
        # a safe charset: it is user input and becomes part of a path.
        stem = re.sub(r"[^A-Za-z0-9._-]+", "_", Path(file.filename or "").stem).strip("._")[:80]
        target = uploads / (f"{run_id}__{stem}{suffix}" if stem else f"{run_id}{suffix}")
        with target.open("wb") as fh:
            shutil.copyfileobj(file.file, fh)
        submit(str(target), run_id)
        tracker.set(run_id, filename=file.filename)
        return {"run_id": run_id, "status": "queued", "source": str(target)}

    @app.post("/api/runs", status_code=202)
    def start_run(req: RunRequest) -> dict[str, Any]:
        if not Path(req.path).exists():
            raise HTTPException(404, f"no such video: {req.path}")
        run_id = new_id("run")
        submit(req.path, run_id)
        return {"run_id": run_id, "status": "queued", "source": req.path}

    @app.get("/api/runs")
    def list_runs(limit: int = 50) -> dict[str, Any]:
        return {"in_flight": tracker.all(), "runs": db.list_runs(limit)}

    @app.get("/api/runs/{run_id}")
    def get_run(run_id: str) -> dict[str, Any]:
        run = db.get_run(run_id)
        if run is None:
            live = tracker.get(run_id)
            if live:
                return {"run_id": run_id, "pending": live}
            raise HTTPException(404, f"unknown run {run_id}")
        run["live"] = tracker.get(run_id)
        run["audit"] = db.audit_trail(run_id)
        return run

    @app.get("/api/runs/{run_id}/artifacts/{path:path}")
    def artifact(run_id: str, path: str) -> FileResponse:
        root = (Path(cfg.output.dir) / run_id).resolve()
        target = (root / path).resolve()
        # is_relative_to, not startswith: "runs/run_1" is a string prefix of
        # "runs/run_10", so a prefix check would let one run read another's.
        if not target.is_relative_to(root) or not target.is_file():
            raise HTTPException(404, "artifact not found")
        return FileResponse(target)

    @app.get("/api/runs/{run_id}/video")
    def video(run_id: str) -> FileResponse:
        # Only the source of a run that completed, and only if it is a video.
        # A run submitted by path records whatever path it was given, and a
        # failed one never proves the file was a video; serving either would
        # turn this into a read-any-file endpoint.
        run = db.get_run(run_id)
        source = run["source"] if run else None
        if (
            not source
            or Path(source).suffix.lower() not in VIDEO_SUFFIXES
            or not Path(source).is_file()
        ):
            raise HTTPException(404, "source video not available")
        # FileResponse answers Range requests, which the player needs to seek.
        return FileResponse(source)

    @app.get("/api/reviews")
    def reviews(status: str | None = "pending", limit: int = 200) -> list[dict[str, Any]]:
        return db.reviews(status=status, limit=limit)

    @app.post("/api/reviews/{review_id}")
    def resolve(review_id: str, decision: ReviewDecision) -> dict[str, Any]:
        # "pending" reopens a decision (the dashboard's undo); the audit trail
        # keeps both the decision and its reversal.
        if decision.status not in {"accepted", "rejected", "corrected", "pending"}:
            raise HTTPException(400, "status must be accepted, rejected, corrected or pending")
        if decision.status == "corrected" and not decision.resolved_sku:
            raise HTTPException(400, "a corrected review needs resolved_sku")
        ok = db.resolve_review(
            review_id, decision.status, decision.resolved_sku, decision.reviewer,
            resolved_count=decision.resolved_count,
        )
        if not ok:
            raise HTTPException(404, f"unknown review {review_id}")
        return {"review_id": review_id, "status": decision.status,
                "resolved_count": decision.resolved_count}

    @app.get("/api/skus/{sku}/history")
    def sku_history(sku: str, limit: int = 100) -> list[dict[str, Any]]:
        return db.sku_history(sku, limit)

    if STATIC_DIR.is_dir():
        app.mount("/", DashboardFiles(directory=STATIC_DIR, html=True), name="dashboard")
    else:  # pragma: no cover - only if the package was installed without data
        @app.get("/")
        def no_dashboard() -> JSONResponse:
            return JSONResponse({"detail": "dashboard assets missing"}, status_code=404)

    return app


app = create_app()
