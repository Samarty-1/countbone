"""Counting: submit videos (in one go or resumably), follow them, read and
review the results, and merge several videos of one place."""

from __future__ import annotations

import colorsys
import hashlib
import re
import shutil
import threading
import time
from pathlib import Path
from typing import Any

from anyio import to_thread
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from ..catalog import SkuEntry
from ..ops import catalog as catalog_ops
from ..ops import postrun
from ..ops.final import final_counts
from ..ops.merge import merge, objects_from_run
from ..plugins import base as plugin_base
from ..types import new_id
from . import telemetry
from .app import VIDEO_SUFFIXES
from .auth import current_principal, require

MAX_UPLOAD_BYTES = 8 * 1024**3        # 8 GiB: a long 4K walk, not a disk-filling attack
CHUNK_LIMIT = 64 * 1024**2            # per resumable PUT
UPLOAD_TTL_S = 7 * 86400              # an upload untouched this long is abandoned


def _swatch(entry: SkuEntry) -> str | None:
    """A display colour for a catalog entry: its hue band's centre."""
    if entry.achromatic:
        return "#9ca3af"
    centre = entry.hue_center()
    if centre is None:
        return None
    r, g, b = colorsys.hsv_to_rgb(centre / 180.0, 0.75, 0.9)  # OpenCV hue is 0-179
    return f"#{int(r * 255):02x}{int(g * 255):02x}{int(b * 255):02x}"


def _safe_stem(filename: str | None) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", Path(filename or "").stem).strip("._")[:80]


class RunRequest(BaseModel):
    path: str = Field(description="Server-side path to a video file")
    location: str | None = None


class ReviewDecision(BaseModel):
    status: str = Field(description="accepted | rejected | corrected | pending (reopen)")
    resolved_sku: str | None = None
    resolved_count: int | None = Field(
        default=None, ge=0, description="A reviewer's recount, for a whole-SKU review"
    )
    # Accepted for compatibility with older clients; the signed-in user is recorded.
    reviewer: str | None = None


class UploadStart(BaseModel):
    filename: str = Field(max_length=200)
    size: int = Field(gt=0)
    sha256: str | None = Field(default=None, pattern=r"^[0-9a-fA-F]{64}$")
    client_id: str | None = Field(default=None, max_length=80,
                                  description="The device's id for this recording; retries reuse it")
    location: str | None = Field(default=None, max_length=64)
    kind: str = "count"
    receipt_id: str | None = None
    task_id: str | None = None
    walk_id: str | None = None
    job_id: str | None = None


class UploadComplete(BaseModel):
    sha256: str | None = Field(default=None, pattern=r"^[0-9a-fA-F]{64}$")


class WalkCreate(BaseModel):
    location: str | None = None
    name: str | None = Field(default=None, max_length=120)


def router(ctx) -> APIRouter:
    r = APIRouter(tags=["counting"])
    store, cfg, tracker = ctx.store, ctx.cfg, ctx.tracker
    counter = require("counter")

    # -- context a run may be filed under -------------------------------------
    def _params(kind: str, location: str | None, receipt_id: str | None, task_id: str | None,
                walk_id: str | None, job_id: str | None) -> dict[str, Any]:
        if kind not in ("count", "receive", "recount"):
            raise HTTPException(400, "kind must be count, receive or recount")
        location = (location or "").strip() or None
        if location and store.get_location(location) is None:
            raise HTTPException(404, f"unknown location {location}; add it under Locations first")
        if kind == "receive":
            receipt = store.get_receipt(receipt_id or "")
            if receipt is None:
                raise HTTPException(404, "a receiving video needs an open receipt")
            if receipt["status"] == "closed":
                raise HTTPException(409, "that receipt is closed")
        if kind == "recount":
            task = store.get_task(task_id or "")
            if task is None or task["status"] not in ("open", "escalated"):
                raise HTTPException(404, "a recount video needs an open recount task")
            location = location or task["location"]
        if walk_id:
            walk = store.get_walk(walk_id)
            if walk is None or walk["status"] != "open":
                raise HTTPException(404, "no open walk with that id")
            location = location or walk["location"]
        if job_id and store.get_service_job(job_id) is None:
            raise HTTPException(404, "no such service job")
        return {k: v for k, v in {"kind": kind, "location": location, "receipt_id": receipt_id,
                                  "task_id": task_id, "walk_id": walk_id, "job_id": job_id}.items()
                if v}

    # -- reference -------------------------------------------------------------
    @r.get("/api/health")
    def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "version": "0.2.0",
            "detect": cfg.detect.backend,
            "identify": ctx.pipeline.identifier.name,
            "count": cfg.count.strategy,
            "unknown_sku": cfg.identify.unknown_sku,
            "auth": ctx.auth_enabled,
            "plugins": [p.name for p in ctx.pipeline.plugins if not isinstance(
                p, (telemetry.TelemetryIntake, telemetry.TelemetryTail))],
        }

    @r.get("/api/catalog")
    def catalog(_: dict = Depends(counter)) -> list[dict[str, Any]]:
        live = ctx.services.current_catalog()
        enrolled = set(live.index().skus) if live.exemplars else set()
        return [
            {"sku": e.sku, "label": e.label, "hue": list(e.hue) if e.hue else None,
             "achromatic": e.achromatic, "min_saturation": e.min_saturation,
             "unit_value": e.unit_value, "expected": e.expected, "swatch": _swatch(e),
             "barcodes": e.barcodes, "source": e.source, "enrolled": e.sku in enrolled}
            for e in live.entries
        ]

    @r.get("/api/plugins")
    def plugins(_: dict = Depends(counter)) -> list[dict[str, Any]]:
        enabled = {p.name for p in cfg.plugins if p.enabled}
        return [
            {"name": name, "layer": cls.layer, "priority": cls.priority,
             "enabled": name in enabled, "doc": (cls.__doc__ or "").strip().split("\n")[0]}
            for name, cls in sorted(plugin_base.available().items())
        ]

    # -- submitting ----------------------------------------------------------------
    def _submit(source: Path, filename: str | None, params: dict[str, Any], who: dict[str, Any],
                run_id: str) -> dict[str, Any]:
        ctx.runner.submit(run_id, str(source), params, filename, who["user_id"])
        store.add_audit(run_id, "run_submitted", {"filename": filename, **params},
                        actor=who["username"])
        return {"run_id": run_id, "status": "queued", "source": str(source), **params}

    @r.post("/api/runs/upload", status_code=202)
    # Sync on purpose: FastAPI runs it in a worker thread. As `async def`, the
    # blocking copy below stalls the event loop, and every progress poll with
    # it, for as long as a large aisle video takes to write.
    def upload_run(
        file: UploadFile = File(...),
        location: str | None = Form(None),
        kind: str = Form("count"),
        receipt_id: str | None = Form(None),
        task_id: str | None = Form(None),
        walk_id: str | None = Form(None),
        job_id: str | None = Form(None),
        who: dict = Depends(counter),
    ) -> dict[str, Any]:
        suffix = (Path(file.filename or "upload.mp4").suffix or ".mp4").lower()
        if suffix not in VIDEO_SUFFIXES:
            raise HTTPException(
                415, f"unsupported file type {suffix}; expected {', '.join(VIDEO_SUFFIXES)}"
            )
        params = _params(kind, location, receipt_id, task_id, walk_id, job_id)
        run_id = new_id("run")
        # The original name rides in the stored filename, so the run is still
        # recognisable on disk. Reduced to a safe charset: it is user input and
        # becomes part of a path.
        stem = _safe_stem(file.filename)
        target = ctx.uploads_dir / (f"{run_id}__{stem}{suffix}" if stem else f"{run_id}{suffix}")
        if file.size is not None and file.size > MAX_UPLOAD_BYTES:
            raise HTTPException(413, "video is larger than 8 GB")  # before copying any of it
        with target.open("wb") as fh:
            shutil.copyfileobj(file.file, fh)
        if target.stat().st_size > MAX_UPLOAD_BYTES:
            target.unlink(missing_ok=True)
            raise HTTPException(413, "video is larger than 8 GB")
        return _submit(target, file.filename, params, who, run_id)

    @r.post("/api/runs", status_code=202)
    def start_run(req: RunRequest, who: dict = Depends(require("admin"))) -> dict[str, Any]:
        # A server-side path is a read of the server's disk: admins only.
        if not Path(req.path).is_file():
            raise HTTPException(404, f"no such video: {req.path}")
        params = _params("count", req.location, None, None, None, None)
        return _submit(Path(req.path), Path(req.path).name, params, who, new_id("run"))

    # -- resumable uploads (the phone's offline queue) -----------------------------------
    @r.post("/api/uploads", status_code=201)
    def upload_start(body: UploadStart, who: dict = Depends(counter)) -> dict[str, Any]:
        """Begin (or resume) an upload. The same client_id always gets the same upload."""
        _expire_stale_uploads()
        if body.client_id:
            existing = store.upload_by_client(body.client_id)
            if existing is not None:
                if existing["created_by"] != who["user_id"] and who["role"] != "admin":
                    # 403, not 409: this will never succeed however often it is retried.
                    raise HTTPException(403, "that recording id belongs to someone else")
                if existing["status"] == "expired":
                    # Abandoned long enough that the partial file was cleared:
                    # the same recording starts again from zero.
                    Path(existing["path"]).touch()
                    store.set_upload(existing["upload_id"], received=0, status="open")
                    existing = store.get_upload(existing["upload_id"]) or existing
                return _upload_view(existing)
        suffix = (Path(body.filename).suffix or ".mp4").lower()
        if suffix not in VIDEO_SUFFIXES:
            raise HTTPException(415, f"unsupported file type {suffix}")
        if body.size > MAX_UPLOAD_BYTES:
            raise HTTPException(413, "video is larger than 8 GB")
        params = _params(body.kind, body.location, body.receipt_id, body.task_id, body.walk_id,
                         body.job_id)
        partial = ctx.uploads_dir / f"{new_id('part')}{suffix}"
        partial.touch()
        up = store.create_upload(body.client_id, body.filename, body.size,
                                 body.sha256.lower() if body.sha256 else None, params,
                                 str(partial), who["user_id"])
        return _upload_view(up)

    # One lock per upload: a phone that retries a chunk while the first try
    # is still arriving, or taps complete twice, must not interleave writes or
    # submit the same video twice.
    upload_locks: dict[str, threading.Lock] = {}
    locks_guard = threading.Lock()

    def _upload_lock(upload_id: str) -> threading.Lock:
        with locks_guard:
            return upload_locks.setdefault(upload_id, threading.Lock())

    last_sweep = [0.0]

    def _expire_stale_uploads(force: bool = False) -> None:
        now = time.time()
        if not force and now - last_sweep[0] < 3600:
            return
        last_sweep[0] = now
        for up in store.stale_uploads(now - UPLOAD_TTL_S):
            with _upload_lock(up["upload_id"]):
                Path(up["path"]).unlink(missing_ok=True)
                store.set_upload(up["upload_id"], status="expired", received=0)
            with locks_guard:
                upload_locks.pop(up["upload_id"], None)

    ctx.extra["expire_stale_uploads"] = _expire_stale_uploads

    def _upload_view(up: dict[str, Any]) -> dict[str, Any]:
        return {"upload_id": up["upload_id"], "offset": up["received"], "size": up["size"],
                "status": up["status"], "run_id": up["run_id"]}

    def _own_upload(upload_id: str, who: dict[str, Any]) -> dict[str, Any]:
        up = store.get_upload(upload_id)
        if up is None:
            raise HTTPException(404, "no such upload")
        if up["created_by"] != who["user_id"] and who["role"] != "admin":
            raise HTTPException(404, "no such upload")
        return up

    @r.get("/api/uploads/{upload_id}")
    def upload_status(upload_id: str, who: dict = Depends(counter)) -> dict[str, Any]:
        return _upload_view(_own_upload(upload_id, who))

    @r.put("/api/uploads/{upload_id}")
    async def upload_chunk(upload_id: str, request: Request,
                           who: dict = Depends(counter)) -> Response:
        """Append a chunk at Upload-Offset. A retried chunk the server already
        has is acknowledged, not appended twice; a gap is refused with the
        offset to resume from."""
        up = _own_upload(upload_id, who)
        if up["status"] != "open":
            raise HTTPException(409, "upload already complete")
        try:
            offset = int(request.headers.get("upload-offset", ""))
        except ValueError:
            raise HTTPException(400, "Upload-Offset header required") from None
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > CHUNK_LIMIT:
            raise HTTPException(413, "chunks are at most 64 MB")
        # Streamed with a hard cap: the proxy allows multi-GB bodies, and
        # reading one whole before checking it would take the server down.
        parts: list[bytes] = []
        size = 0
        async for piece in request.stream():
            size += len(piece)
            if size > CHUNK_LIMIT:
                raise HTTPException(413, "chunks are at most 64 MB")
            parts.append(piece)
        body = b"".join(parts)

        def write() -> Response:
            with _upload_lock(upload_id):
                current = store.get_upload(upload_id)
                if current is None or current["status"] != "open":
                    raise HTTPException(409, "upload already complete")
                received = current["received"]
                if offset > received:
                    return Response(status_code=409, headers={"Upload-Offset": str(received)},
                                    content=f'{{"detail":"resume from {received}"}}',
                                    media_type="application/json")
                new = body[received - offset:]  # skip bytes the server already has
                if received + len(new) > current["size"]:
                    raise HTTPException(400, "more data than the declared size")
                if new:
                    with open(current["path"], "r+b") as fh:
                        fh.seek(received)
                        fh.write(new)
                    store.set_upload(upload_id, received=received + len(new))
                return Response(status_code=204,
                                headers={"Upload-Offset": str(received + len(new))})

        # File and database work off the event loop, so one slow disk write
        # does not stall every other request.
        return await to_thread.run_sync(write)

    @r.post("/api/uploads/{upload_id}/complete", status_code=202)
    def upload_complete(upload_id: str, body: UploadComplete | None = None,
                        who: dict = Depends(counter)) -> dict[str, Any]:
        _own_upload(upload_id, who)
        with _upload_lock(upload_id):
            return _complete(upload_id, who, body.sha256.lower() if body and body.sha256 else None)

    def _complete(upload_id: str, who: dict[str, Any], sha256: str | None) -> dict[str, Any]:
        up = store.get_upload(upload_id)
        assert up is not None  # checked by the caller under the same lock
        if sha256 and up["sha256"] and sha256 != up["sha256"]:
            raise HTTPException(400, "the checksum differs from the one given at the start")
        # The phone hashes as it sends, so it only knows the digest at the end.
        up["sha256"] = up["sha256"] or sha256
        if up["status"] == "expired":
            raise HTTPException(409, "this upload was abandoned and cleared; start it again")
        if up["status"] == "complete":
            return {"run_id": up["run_id"], "status": "queued", "duplicate": True}
        if up["received"] != up["size"]:
            raise HTTPException(409, f"only {up['received']} of {up['size']} bytes received")
        path = Path(up["path"])
        if up["sha256"]:
            digest = hashlib.sha256()
            with path.open("rb") as fh:
                while block := fh.read(1 << 20):
                    digest.update(block)
            if digest.hexdigest() != up["sha256"]:
                # The file is damaged: start again rather than count garbage.
                store.set_upload(upload_id, received=0)
                path.write_bytes(b"")
                raise HTTPException(422, "checksum mismatch; the upload restarts from zero")
        run_id = new_id("run")
        stem = _safe_stem(up["filename"])
        final = ctx.uploads_dir / (f"{run_id}__{stem}{path.suffix}" if stem else f"{run_id}{path.suffix}")
        path.replace(final)
        store.set_upload(upload_id, status="complete", run_id=run_id)
        user = store.get_user(up["created_by"]) or who
        return _submit(final, up["filename"], up["params"],
                       {"user_id": up["created_by"], "username": user.get("username", who["username"])},
                       run_id)

    # -- reading ----------------------------------------------------------------------
    @r.get("/api/runs")
    def list_runs(limit: int = 50, location: str | None = None, kind: str | None = None,
                  _: dict = Depends(counter)) -> dict[str, Any]:
        runs = store.list_runs(min(limit, 500), location=location, kind=kind)
        done = {x["run_id"] for x in runs}
        live = [t for t in tracker.all() if t["run_id"] not in done]
        live_ids = {t["run_id"] for t in live}
        # Failures from before a restart are only in the jobs table.
        for job in store.list_jobs(20):
            if job["status"] == "failed" and job["run_id"] not in live_ids and job["run_id"] not in done:
                live.append({"run_id": job["run_id"], "status": "failed", "error": job["error"],
                             "source": job["source"], "filename": job["filename"]})
        return {"in_flight": live, "runs": runs}

    @r.get("/api/runs/{run_id}")
    def get_run(run_id: str, _: dict = Depends(counter)) -> dict[str, Any]:
        run = store.get_run(run_id)
        if run is None:
            live = tracker.get(run_id)
            if live:
                return {"run_id": run_id, "pending": live}
            job = store.get_job(run_id)
            if job:
                return {"run_id": run_id, "pending": {"run_id": run_id, "status": job["status"],
                                                      "error": job["error"], "source": job["source"],
                                                      "filename": job["filename"]}}
            raise HTTPException(404, f"unknown run {run_id}")
        run["live"] = tracker.get(run_id)
        run["audit"] = store.audit_trail(run_id)
        run["final"] = final_counts(run)
        creator = store.get_user(run["created_by"]) if run.get("created_by") else None
        run["created_by_name"] = creator["display_name"] if creator else None
        return run

    @r.get("/api/runs/{run_id}/artifacts/{path:path}")
    def artifact(run_id: str, path: str, _: dict = Depends(counter)) -> FileResponse:
        root = (Path(cfg.output.dir) / run_id).resolve()
        target = (root / path).resolve()
        # is_relative_to, not startswith: "runs/run_1" is a string prefix of
        # "runs/run_10", so a prefix check would let one run read another's.
        if not target.is_relative_to(root) or not target.is_file():
            raise HTTPException(404, "artifact not found")
        return FileResponse(target)

    @r.get("/api/runs/{run_id}/video")
    def video(run_id: str, _: dict = Depends(counter)) -> FileResponse:
        # Only the source of a run that completed, and only if it is a video.
        # A run submitted by path records whatever path it was given, and a
        # failed one never proves the file was a video; serving either would
        # turn this into a read-any-file endpoint.
        run = store.get_run(run_id)
        source = run["source"] if run else None
        if (
            not source
            or Path(source).suffix.lower() not in VIDEO_SUFFIXES
            or not Path(source).is_file()
        ):
            raise HTTPException(404, "source video not available")
        # FileResponse answers Range requests, which the player needs to seek.
        return FileResponse(source)

    # -- reviews ----------------------------------------------------------------------
    @r.get("/api/reviews")
    def reviews(status: str | None = "pending", limit: int = 200,
                _: dict = Depends(counter)) -> list[dict[str, Any]]:
        return store.reviews(status=status, limit=min(limit, 1000))

    @r.post("/api/reviews/{review_id}")
    def resolve(review_id: str, decision: ReviewDecision,
                who: dict = Depends(counter)) -> dict[str, Any]:
        # "pending" reopens a decision (the dashboard's undo); the audit trail
        # keeps both the decision and its reversal.
        if decision.status not in {"accepted", "rejected", "corrected", "pending"}:
            raise HTTPException(400, "status must be accepted, rejected, corrected or pending")
        if decision.status == "corrected" and not decision.resolved_sku:
            raise HTTPException(400, "a corrected review needs resolved_sku")
        ok = store.resolve_review(
            review_id, decision.status, decision.resolved_sku, who["username"],
            resolved_count=decision.resolved_count,
        )
        if not ok:
            raise HTTPException(404, f"unknown review {review_id}")
        review = store.review(review_id)
        learned = None
        if decision.status in ("accepted", "corrected"):
            try:
                learned = catalog_ops.learn_from_review(ctx.services, review, who)
            except Exception:  # noqa: BLE001 - learning is a bonus, never a failure
                learned = None
        follow = postrun.after_review(ctx.services, review["run_id"])
        return {"review_id": review_id, "status": decision.status,
                "resolved_count": decision.resolved_count, "learned_photo": learned,
                "followup": follow}

    @r.get("/api/skus/{sku}/history")
    def sku_history(sku: str, limit: int = 100, _: dict = Depends(counter)) -> list[dict[str, Any]]:
        return store.sku_history(sku, min(limit, 1000))

    # -- walks: several videos of one place, merged ---------------------------------------
    @r.post("/api/walks", status_code=201)
    def create_walk(body: WalkCreate, who: dict = Depends(counter)) -> dict[str, Any]:
        if body.location and store.get_location(body.location) is None:
            raise HTTPException(404, "unknown location")
        walk = store.create_walk(body.location, body.name, who["user_id"])
        store.add_audit(walk["walk_id"], "walk_created", {"location": body.location},
                        actor=who["username"])
        return walk

    @r.get("/api/walks")
    def list_walks(location: str | None = None, _: dict = Depends(counter)) -> list[dict[str, Any]]:
        return store.list_walks(location)

    @r.get("/api/walks/{walk_id}")
    def get_walk(walk_id: str, _: dict = Depends(counter)) -> dict[str, Any]:
        walk = store.get_walk(walk_id)
        if walk is None:
            raise HTTPException(404, "no such walk")
        runs = [store.get_run(x["run_id"]) for x in store.walk_runs(walk_id)]
        runs = [x for x in runs if x]
        merged = merge([(x["run_id"], objects_from_run(x)) for x in runs])
        naive: dict[str, int] = {}
        for x in runs:
            for row in final_counts(x)["rows"]:
                naive[row["sku"]] = naive.get(row["sku"], 0) + row["final"]
        return {**walk, "runs": [x["run_id"] for x in runs], "counts": merged.counts(),
                "total": sum(merged.counts().values()), "naive_total": sum(naive.values()),
                "duplicates_removed": merged.duplicates, "alignments": merged.alignments,
                "needs_review": any(a.get("status") == "ambiguous" for a in merged.alignments)}

    @r.post("/api/walks/{walk_id}/close")
    def close_walk(walk_id: str, who: dict = Depends(counter)) -> dict[str, Any]:
        if not store.close_walk(walk_id):
            raise HTTPException(404, "no such walk")
        store.add_audit(walk_id, "walk_closed", {}, actor=who["username"])
        return store.get_walk(walk_id)  # type: ignore[return-value]

    @r.get("/api/audit/recent")
    def recent_audit(limit: int = 100, kind: str | None = None,
                     _: dict = Depends(require("manager"))) -> list[dict[str, Any]]:
        return store.recent_audit(min(limit, 1000), kind)

    @r.get("/api/time")
    def server_time() -> dict[str, float]:
        return {"now": time.time()}

    return r


# `current_principal` is re-exported for routes that only need "signed in".
__all__ = ["router", "current_principal"]
