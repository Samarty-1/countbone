"""HTTP API and dashboard.

Deliberately thin: routes check who is asking and hand off to the pipeline
(counting), the store (reading) and countbone.ops (business rules). No
counting logic and no business rules live in the routes.
"""

from __future__ import annotations

import logging
import secrets
import threading
from collections.abc import Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from ..catalog import Catalog
from ..config import Config
from ..ops import Forbidden, OpsError, Services
from ..ops import catalog as catalog_ops
from ..pipeline import Pipeline
from ..security import Keyring, LoginThrottle
from ..store.db import Store
from . import telemetry
from .jobs import JobRunner, RunTracker

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


class CatalogCache:
    """The live catalog, rebuilt only when products or photos change.

    Loading every enrolled vector and recalibrating the index is cheap for a
    pilot and not for a thousand products, so it is keyed on a fingerprint
    of the catalog tables and reused while that is unchanged.
    """

    def __init__(self, base: Catalog, services: Services) -> None:
        self.base = base
        self.services = services
        self._lock = threading.Lock()
        self._key: tuple | None = None
        self._catalog: Catalog | None = None

    def _fingerprint(self) -> tuple:
        store = self.services.store
        v = store._one("SELECT COUNT(*) AS n, MAX(id) AS m FROM sku_vectors") or {}
        s = store._one("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(label) + unit_value * 100 "
                       "+ archived * 7 + achromatic * 3 + LENGTH(COALESCE(barcodes, '')) "
                       "+ LENGTH(COALESCE(hue, ''))), 0) AS h, "
                       "GROUP_CONCAT(COALESCE(hue, '-'), '|') AS hues FROM skus") or {}
        return (v.get("n"), v.get("m"), s.get("n"), s.get("h"), s.get("hues"))

    def __call__(self) -> Catalog:
        key = self._fingerprint()
        with self._lock:
            if self._catalog is None or key != self._key:
                self._catalog = catalog_ops.load_catalog(self.base, self.services.store)
                self._key = key
            return self._catalog


@dataclass
class ApiContext:
    cfg: Config
    store: Store
    services: Services
    pipeline: Pipeline
    runner: JobRunner
    tracker: RunTracker
    keyring: Keyring
    throttle: LoginThrottle
    uploads_dir: Path
    auth_enabled: bool
    setup_token: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


def create_app(
    config: Config | None = None,
    store: Store | None = None,
    allow_origins: Sequence[str] = (),
    auth: bool = True,
    data_dir: str | Path | None = None,
    http_client: Any = None,
    resume_jobs: bool = True,
) -> FastAPI:
    cfg = config or Config()
    db = store or Store(cfg.output.sqlite or "countbone.db")
    output_dir = Path(cfg.output.dir)
    data = Path(data_dir) if data_dir else (
        Path(db.path).resolve().parent / "countbone-data" if db.path != ":memory:"
        else output_dir / "_data")
    data.mkdir(parents=True, exist_ok=True)
    keyring = Keyring(data / "keys")
    services = Services(store=db, keyring=keyring, data_dir=data, output_dir=output_dir,
                        http_client=http_client,
                        extra={"unknown_sku": cfg.identify.unknown_sku,
                               "resize_width": cfg.capture.resize_width})
    base_catalog = Catalog.load(cfg.identify.catalog)
    services.catalog = CatalogCache(base_catalog, services)
    tracker = RunTracker()
    # Built once: a Pipeline holds no per-run state, and rebuilding it per
    # request would reload the detector's weights every time.
    pipeline = Pipeline(cfg, store=db, catalog_provider=services.catalog)
    pipeline.plugins = telemetry.attach(pipeline.plugins, tracker.set)
    runner = JobRunner(pipeline, services, tracker)
    uploads = output_dir / "_uploads"
    uploads.mkdir(parents=True, exist_ok=True)

    setup_token = None
    if auth and db.count_users() == 0:
        # First run: whoever holds this (printed on the server's console) may
        # create the first admin. Without it, anyone who reached the server
        # before its owner could claim it.
        setup_token = secrets.token_urlsafe(9)
        log.warning("countbone first-run setup code: %s (enter it in the dashboard)", setup_token)
        print(f"\n  countbone: no accounts yet. Open the dashboard and use setup code {setup_token}\n",
              flush=True)

    ctx = ApiContext(cfg=cfg, store=db, services=services, pipeline=pipeline, runner=runner,
                     tracker=tracker, keyring=keyring, throttle=LoginThrottle(),
                     uploads_dir=uploads, auth_enabled=auth, setup_token=setup_token)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        if resume_jobs:
            resumed = runner.resume()
            if resumed:
                log.info("resumed %d queued run(s) from before the restart", resumed)
        db.purge_expired_sessions()
        yield
        runner.shutdown()

    app = FastAPI(
        lifespan=lifespan,
        title="countbone",
        version="0.2.0",
        description="Video in, counts out. Everything else is a plugin.",
    )
    app.state.config = cfg
    app.state.store = db
    app.state.tracker = tracker
    app.state.ctx = ctx
    app.state.auth_enabled = auth
    if allow_origins:
        # Only for browser apps on another origin (the mobile app's web
        # preview). Native apps and the bundled dashboard never need it, so it
        # is off unless origins are named; "*" is deliberately not special.
        from fastapi.middleware.cors import CORSMiddleware

        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(allow_origins),
            allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
            allow_headers=["Content-Type", "Authorization", "Upload-Offset", "X-Countbone"],
            expose_headers=["Upload-Offset"],
        )

    @app.exception_handler(Forbidden)
    async def _forbidden(_: Request, exc: Forbidden):
        return JSONResponse({"detail": str(exc)}, status_code=403)

    @app.exception_handler(OpsError)
    async def _ops_error(_: Request, exc: OpsError):
        return JSONResponse({"detail": str(exc)}, status_code=400)

    from . import routes_admin, routes_auth, routes_ops, routes_runs

    app.include_router(routes_auth.router(ctx))
    app.include_router(routes_runs.router(ctx))
    app.include_router(routes_ops.router(ctx))
    app.include_router(routes_admin.router(ctx))

    @app.get("/api/{rest:path}", include_in_schema=False)
    def _api_404(rest: str):
        raise HTTPException(404, f"no API route /api/{rest}")

    if STATIC_DIR.is_dir():
        app.mount("/", DashboardFiles(directory=STATIC_DIR, html=True), name="dashboard")
    else:  # pragma: no cover - only if the package was installed without data
        @app.get("/")
        def no_dashboard() -> JSONResponse:
            return JSONResponse({"detail": "dashboard assets missing"}, status_code=404)

    return app


def _default_app() -> FastAPI:  # pragma: no cover - for `uvicorn countbone.api.app:app`
    return create_app()


def __getattr__(name: str):  # pragma: no cover
    # `app` is created on first access, not at import: importing this module
    # (the CLI, the tests) must not open countbone.db in the working directory.
    if name == "app":
        globals()["app"] = _default_app()
        return globals()["app"]
    raise AttributeError(name)
