"""HTTP API and dashboard.

Deliberately thin: it submits videos to the pipeline, reads the store, and
records review decisions. No counting logic lives here.
"""

from __future__ import annotations

import logging
import shutil
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from ..config import Config
from ..pipeline import Pipeline
from ..plugins import base as plugin_base
from ..store.db import Store
from ..types import new_id

log = logging.getLogger(__name__)
STATIC_DIR = Path(__file__).parent / "static"


class ReviewDecision(BaseModel):
    status: str = Field(description="accepted | rejected | corrected")
    resolved_sku: str | None = None
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
    # than contention between two runs writing artifacts at once.
    pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="countbone")
    uploads = Path(cfg.output.dir) / "_uploads"
    uploads.mkdir(parents=True, exist_ok=True)

    app = FastAPI(
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
                result = Pipeline(cfg, store=db).run(source, run_id=run_id)
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
            "plugins": [p.name for p in plugin_base.build(cfg.plugins)],
        }

    @app.get("/api/plugins")
    def plugins() -> list[dict[str, Any]]:
        enabled = {p.name for p in cfg.plugins if p.enabled}
        return [
            {"name": name, "layer": cls.layer, "priority": cls.priority,
             "enabled": name in enabled, "doc": (cls.__doc__ or "").strip().split("\n")[0]}
            for name, cls in sorted(plugin_base.available().items())
        ]

    @app.post("/api/runs/upload", status_code=202)
    async def upload_run(file: UploadFile) -> dict[str, Any]:
        run_id = new_id("run")
        suffix = Path(file.filename or "upload.mp4").suffix or ".mp4"
        target = uploads / f"{run_id}{suffix}"
        with target.open("wb") as fh:
            shutil.copyfileobj(file.file, fh)
        submit(str(target), run_id)
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
        if not str(target).startswith(str(root)) or not target.is_file():
            raise HTTPException(404, "artifact not found")
        return FileResponse(target)

    @app.get("/api/reviews")
    def reviews(status: str | None = "pending", limit: int = 200) -> list[dict[str, Any]]:
        return db.reviews(status=status, limit=limit)

    @app.post("/api/reviews/{review_id}")
    def resolve(review_id: str, decision: ReviewDecision) -> dict[str, Any]:
        if decision.status not in {"accepted", "rejected", "corrected"}:
            raise HTTPException(400, "status must be accepted, rejected or corrected")
        if decision.status == "corrected" and not decision.resolved_sku:
            raise HTTPException(400, "a corrected review needs resolved_sku")
        ok = db.resolve_review(
            review_id, decision.status, decision.resolved_sku, decision.reviewer
        )
        if not ok:
            raise HTTPException(404, f"unknown review {review_id}")
        return {"review_id": review_id, "status": decision.status}

    @app.get("/api/skus/{sku}/history")
    def sku_history(sku: str, limit: int = 100) -> list[dict[str, Any]]:
        return db.sku_history(sku, limit)

    if STATIC_DIR.is_dir():
        app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="dashboard")
    else:  # pragma: no cover - only if the package was installed without data
        @app.get("/")
        def no_dashboard() -> JSONResponse:
            return JSONResponse({"detail": "dashboard assets missing"}, status_code=404)

    return app


app = create_app()
