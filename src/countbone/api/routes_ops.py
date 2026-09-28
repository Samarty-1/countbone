"""Operations: locations, recount tasks, reconcile, receive, evidence,
the catalog studio, and service jobs. Each route checks the caller's role
and hands off to countbone.ops, where the rules live."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, Response
from pydantic import BaseModel, Field

from .. import integrations
from ..integrations import csvio
from ..ops import OpsError, evidence, labels, receive, reconcile, tasks
from ..ops import catalog as catalog_ops
from ..ops.dataset import export_coco
from .auth import require

CODE_RE = r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,39}$"
MAX_CSV = 5 * 1024 * 1024


async def _read_text(file: UploadFile) -> str:
    data = await file.read(MAX_CSV + 1)
    if len(data) > MAX_CSV:
        raise HTTPException(413, "CSV files are limited to 5 MB")
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return data.decode("latin-1")


class LocationIn(BaseModel):
    code: str = Field(pattern=CODE_RE)
    name: str | None = Field(default=None, max_length=120)
    site_id: str | None = None
    zone: str | None = Field(default=None, max_length=60)


class ExpectedIn(BaseModel):
    quantities: dict[str, int]
    replace: bool = False


class PlanogramIn(BaseModel):
    rows: list[list[str]]


class TaskAssign(BaseModel):
    assignee: str | None = None
    due_at: float | None = None


class TaskComplete(BaseModel):
    count: int = Field(ge=0)
    note: str | None = Field(default=None, max_length=500)


class TaskCancel(BaseModel):
    note: str = Field(min_length=1, max_length=500)


class Decision(BaseModel):
    note: str | None = Field(default=None, max_length=500)


class BulkDecision(BaseModel):
    adjustment_ids: list[str]
    note: str | None = Field(default=None, max_length=500)


class PostRequest(BaseModel):
    adjustment_ids: list[str] | None = None
    integration: str | None = None


class ExportMark(BaseModel):
    adjustment_ids: list[str]
    reference: str = Field(min_length=1, max_length=120)


class ReceiptIn(BaseModel):
    po_number: str = Field(min_length=1, max_length=60)
    supplier: str | None = Field(default=None, max_length=120)
    dock: str | None = Field(default=None, max_length=40)
    lines: dict[str, dict[str, Any]] = Field(description="sku -> {qty, unit_cost}")
    note: str | None = Field(default=None, max_length=500)


class ReceiptPull(BaseModel):
    integration: str
    po_number: str
    dock: str | None = None


class ClaimIn(BaseModel):
    kind: str
    run_ids: list[str] = []
    receipt_id: str | None = None
    counterparty: str | None = Field(default=None, max_length=120)
    amount: float = 0.0
    currency: str = Field(default="USD", max_length=8)
    note: str | None = Field(default=None, max_length=2000)


class ClaimPatch(BaseModel):
    status: str | None = None
    counterparty: str | None = None
    amount: float | None = None
    recovered_amount: float | None = None
    note: str | None = None


class SkuIn(BaseModel):
    sku: str
    label: str | None = Field(default=None, max_length=120)
    unit_value: float | None = None
    hue: list[int] | None = None
    achromatic: bool | None = None
    barcodes: list[str] | None = None
    archived: bool | None = None


class SiteIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    customer: str | None = Field(default=None, max_length=120)
    address: str | None = Field(default=None, max_length=300)
    timezone: str | None = Field(default=None, max_length=60)


class ServiceJobIn(BaseModel):
    site_id: str | None = None
    title: str = Field(min_length=1, max_length=120)
    scheduled_for: float | None = None
    crew: list[str] = []
    locations: list[str] = []
    data_consent: bool = False
    notes: str | None = Field(default=None, max_length=2000)


class ServiceJobPatch(BaseModel):
    status: str | None = None
    title: str | None = None
    scheduled_for: float | None = None
    crew: list[str] | None = None
    locations: list[str] | None = None
    data_consent: bool | None = None
    notes: str | None = None


def router(ctx) -> APIRouter:
    r = APIRouter(tags=["operations"])
    store, services = ctx.store, ctx.services
    counter, manager, admin = require("counter"), require("manager"), require("admin")

    # == locations ==========================================================================
    @r.get("/api/locations")
    def list_locations(site_id: str | None = None, _: dict = Depends(counter)):
        return store.list_locations(site_id)

    @r.post("/api/locations", status_code=201)
    def save_location(body: LocationIn, who: dict = Depends(manager)):
        if body.site_id and store.get_site(body.site_id) is None:
            raise HTTPException(404, "no such site")
        loc = store.upsert_location(body.code, body.name, body.site_id, body.zone, who["user_id"])
        store.add_audit(f"loc:{body.code}", "location_saved", body.model_dump(), actor=who["username"])
        return loc

    @r.post("/api/locations/bulk", status_code=201)
    async def bulk_locations(file: UploadFile = File(...), who: dict = Depends(manager)):
        """A CSV of location,name[,zone] rows; also accepts location,sku,qty to load book stock."""
        text = await _read_text(file)
        try:
            expected = csvio.parse_expected(text)
        except integrations.IntegrationError:
            expected = None
        created = 0
        if expected is not None:
            for code, qtys in expected.items():
                if not _valid_code(code):
                    raise HTTPException(400, f"invalid location code {code!r}")
                store.upsert_location(code, None, None, None, who["user_id"])
                store.set_expected(code, qtys, "csv", who["user_id"])
                created += 1
            store.add_audit("locations", "book_stock_imported",
                            {"locations": created, "rows": sum(len(q) for q in expected.values())},
                            actor=who["username"])
            return {"locations": created, "book_stock_rows": sum(len(q) for q in expected.values())}
        import csv
        import io
        reader = csv.DictReader(io.StringIO(text))
        cols = {c.strip().lower(): c for c in reader.fieldnames or []}
        key = cols.get("location") or cols.get("code") or cols.get("bay")
        if not key:
            raise HTTPException(400, "need a location (or code) column")
        for row in reader:
            code = (row.get(key) or "").strip()
            if not code:
                continue
            if not _valid_code(code):
                raise HTTPException(400, f"invalid location code {code!r}")
            store.upsert_location(code, (row.get(cols.get("name", ""), "") or None),
                                  None, (row.get(cols.get("zone", ""), "") or None), who["user_id"])
            created += 1
        return {"locations": created}

    @r.get("/api/locations/{code:path}/detail")
    def location_detail(code: str, _: dict = Depends(counter)):
        loc = store.get_location(code)
        if loc is None:
            raise HTTPException(404, "no such location")
        return {**loc, "expected": store.expected_rows(code), "planogram": store.get_planogram(code),
                "runs": store.list_runs(20, location=code), "walks": store.list_walks(code),
                "tasks": store.list_tasks(location=code, limit=50),
                "adjustments": store.list_adjustments(location=code, limit=50)}

    @r.delete("/api/locations/{code:path}")
    def archive_location(code: str, who: dict = Depends(manager)):
        if not store.archive_location(code):
            raise HTTPException(404, "no such location")
        store.add_audit(f"loc:{code}", "location_archived", {}, actor=who["username"])
        return {"ok": True}

    @r.put("/api/locations/{code:path}/expected")
    def set_expected(code: str, body: ExpectedIn, who: dict = Depends(manager)):
        if store.get_location(code) is None:
            raise HTTPException(404, "no such location")
        if any(q < 0 for q in body.quantities.values()):
            raise HTTPException(400, "quantities cannot be negative")
        store.set_expected(code, body.quantities, "manual", who["user_id"], replace=body.replace)
        store.add_audit(f"loc:{code}", "book_stock_set", body.model_dump(), actor=who["username"])
        return store.expected_rows(code)

    @r.put("/api/locations/{code:path}/planogram")
    def set_planogram(code: str, body: PlanogramIn, who: dict = Depends(manager)):
        if store.get_location(code) is None:
            raise HTTPException(404, "no such location")
        rows = [[s.strip() for s in row if s.strip()] for row in body.rows]
        store.set_planogram(code, rows, who["user_id"])
        store.add_audit(f"loc:{code}", "planogram_set", {"rows": rows}, actor=who["username"])
        return {"rows": rows}

    @r.get("/api/labels/{code:path}.svg")
    def label_svg(code: str, _: dict = Depends(counter)):
        if store.get_location(code) is None:
            raise HTTPException(404, "no such location")
        return Response(labels.qr_svg(code), media_type="image/svg+xml")

    @r.get("/api/labels-sheet")
    def label_sheet(codes: str | None = None, site_id: str | None = None, _: dict = Depends(counter)):
        locs = store.list_locations(site_id)
        if codes:
            wanted = set(codes.split(","))
            locs = [loc for loc in locs if loc["code"] in wanted]
        if not locs:
            raise HTTPException(404, "no locations to print")
        return HTMLResponse(labels.sheet_html(locs))

    # == recount tasks ============================================================================
    @r.get("/api/tasks")
    def list_tasks(status: str | None = None, mine: bool = False, location: str | None = None,
                   who: dict = Depends(counter)):
        # "Mine" is what this person can do now: assigned to them, or an
        # unassigned recount of someone else's count.
        return store.list_tasks(status=status, for_user=who["user_id"] if mine else None,
                                location=location)

    @r.get("/api/tasks/{task_id}")
    def get_task(task_id: str, _: dict = Depends(counter)):
        task = store.get_task(task_id)
        if task is None:
            raise HTTPException(404, "no such task")
        return {**task, "audit": store.audit_trail(task_id)}

    @r.post("/api/tasks/{task_id}/assign")
    def assign_task(task_id: str, body: TaskAssign, who: dict = Depends(manager)):
        return tasks.assign(services, task_id, body.assignee, who, body.due_at)

    @r.post("/api/tasks/{task_id}/complete")
    def complete_task(task_id: str, body: TaskComplete, who: dict = Depends(counter)):
        return tasks.complete(services, task_id, body.count, who, body.note)

    @r.post("/api/tasks/{task_id}/cancel")
    def cancel_task(task_id: str, body: TaskCancel, who: dict = Depends(manager)):
        return tasks.cancel(services, task_id, who, body.note)

    # == reconcile ================================================================================
    @r.get("/api/adjustments")
    def list_adjustments(status: str | None = None, location: str | None = None,
                         _: dict = Depends(counter)):
        return store.list_adjustments(status=status, location=location)

    @r.get("/api/adjustments/summary")
    def adjustments_summary(_: dict = Depends(counter)):
        rows = store.list_adjustments(status="blocked,proposed,approved,failed", limit=100000)
        out: dict[str, Any] = {}
        for a in rows:
            s = out.setdefault(a["status"], {"count": 0, "value": 0.0})
            s["count"] += 1
            s["value"] = round(s["value"] + abs(a["value"] or 0), 2)
        return {"by_status": out, "rules": reconcile.rules(services)}

    @r.post("/api/adjustments/{adjustment_id}/approve")
    def approve(adjustment_id: str, body: Decision, who: dict = Depends(counter)):
        return reconcile.approve(services, adjustment_id, who, body.note)

    @r.post("/api/adjustments/approve")
    def approve_many(body: BulkDecision, who: dict = Depends(counter)):
        done, errors = [], {}
        for adj_id in body.adjustment_ids:
            try:
                done.append(reconcile.approve(services, adj_id, who, body.note)["adjustment_id"])
            except OpsError as exc:
                errors[adj_id] = str(exc)
        return {"approved": done, "errors": errors}

    @r.post("/api/adjustments/{adjustment_id}/reject")
    def reject(adjustment_id: str, body: Decision, who: dict = Depends(manager)):
        return reconcile.reject(services, adjustment_id, who, body.note or "")

    @r.post("/api/adjustments/post")
    def post_adjustments(body: PostRequest, who: dict = Depends(manager)):
        return reconcile.post(services, body.adjustment_ids, who, body.integration)

    @r.get("/api/adjustments/export.csv")
    def export_adjustments(status: str = "approved", _: dict = Depends(manager)):
        rows = store.list_adjustments(status=status, limit=100000)
        cols = ["adjustment_id", "location", "sku", "system_qty", "counted_qty", "delta",
                "unit_value", "value", "status", "rule", "decided_by_name", "decided_at",
                "run_id", "task_id", "note"]
        return Response(csvio.write_rows(rows, cols), media_type="text/csv",
                        headers={"Content-Disposition": f'attachment; filename="adjustments-{status}.csv"'})

    @r.post("/api/adjustments/mark-exported")
    def mark_exported(body: ExportMark, who: dict = Depends(manager)):
        return {"marked": reconcile.mark_exported(services, body.adjustment_ids, who, body.reference)}

    @r.get("/api/reconcile/rules")
    def get_rules(_: dict = Depends(counter)):
        return reconcile.rules(services)

    @r.put("/api/reconcile/rules")
    def put_rules(body: dict[str, Any], who: dict = Depends(admin)):
        return reconcile.set_rules(services, body, who)

    @r.get("/api/reconcile/report")
    def report(since: float | None = None, until: float | None = None, _: dict = Depends(manager)):
        until = until or time.time()
        since = since if since is not None else until - 30 * 86400
        return reconcile.period_report(services, since, until)

    # == receive ==================================================================================
    @r.get("/api/receipts")
    def list_receipts(status: str | None = None, _: dict = Depends(counter)):
        return store.list_receipts(status)

    @r.post("/api/receipts", status_code=201)
    def create_receipt(body: ReceiptIn, who: dict = Depends(manager)):
        return receive.create(services, body.po_number, body.lines, who, body.supplier, body.dock,
                              "manual", body.note)

    @r.post("/api/receipts/import", status_code=201)
    async def import_receipt(po_number: str = Form(...), supplier: str | None = Form(None),
                             dock: str | None = Form(None), file: UploadFile = File(...),
                             who: dict = Depends(manager)):
        try:
            lines = csvio.parse_po_lines(await _read_text(file))
        except integrations.IntegrationError as exc:
            raise HTTPException(400, str(exc)) from None
        return receive.create(services, po_number, lines, who, supplier, dock, "csv")

    @r.post("/api/receipts/pull", status_code=201)
    def pull_receipt(body: ReceiptPull, who: dict = Depends(manager)):
        try:
            po = reconcile.connector_for(services, body.integration).pull_purchase_order(body.po_number)
        except integrations.IntegrationError as exc:
            raise HTTPException(502, str(exc)) from None
        row = store.get_integration(body.integration)
        return receive.create(services, po.po_number, po.lines, who, po.supplier, body.dock,
                              row["kind"] if row else body.integration)

    @r.get("/api/receipts/{receipt_id}")
    def get_receipt(receipt_id: str, _: dict = Depends(counter)):
        receipt = store.get_receipt(receipt_id)
        if receipt is None:
            raise HTTPException(404, "no such receipt")
        claims = [c for c in store.list_claims() if c["receipt_id"] == receipt_id]
        return {**receipt, "discrepancies": receive.discrepancies(receipt), "claims": claims,
                "audit": store.audit_trail(receipt_id)}

    @r.post("/api/receipts/{receipt_id}/close")
    def close_receipt(receipt_id: str, body: Decision, who: dict = Depends(counter)):
        return receive.close(services, receipt_id, who, body.note)

    # == evidence ===================================================================================
    @r.get("/api/claims")
    def list_claims(status: str | None = None, _: dict = Depends(counter)):
        return store.list_claims(status)

    @r.post("/api/claims", status_code=201)
    def create_claim(body: ClaimIn, who: dict = Depends(manager)):
        return evidence.create_claim(services, who, body.kind, body.run_ids, body.counterparty,
                                     body.receipt_id, body.amount, body.note, body.currency)

    @r.get("/api/claims/{claim_id}")
    def get_claim(claim_id: str, _: dict = Depends(counter)):
        claim = store.get_claim(claim_id)
        if claim is None:
            raise HTTPException(404, "no such claim")
        receipt = store.get_receipt(claim["receipt_id"]) if claim.get("receipt_id") else None
        return {**claim, "receipt": receipt,
                "discrepancies": receive.discrepancies(receipt) if receipt else [],
                "audit": store.audit_trail(claim_id)}

    @r.patch("/api/claims/{claim_id}")
    def patch_claim(claim_id: str, body: ClaimPatch, who: dict = Depends(manager)):
        return evidence.update_claim(services, claim_id, who, **body.model_dump())

    @r.post("/api/claims/{claim_id}/pack")
    def build_pack(claim_id: str, include_video: bool = False, who: dict = Depends(manager)):
        return evidence.build_pack(services, claim_id, who, include_video)

    @r.get("/api/claims/{claim_id}/pack.zip")
    def download_pack(claim_id: str, _: dict = Depends(counter)):
        claim = store.get_claim(claim_id)
        if claim is None or not claim.get("pack_path") or not Path(claim["pack_path"]).is_file():
            raise HTTPException(404, "no pack built for this claim yet")
        return FileResponse(claim["pack_path"], media_type="application/zip",
                            filename=f"countbone-{claim_id}.zip")

    @r.post("/api/evidence/verify")
    async def verify(file: UploadFile = File(...), _: dict = Depends(counter)):
        data = await file.read(512 * 1024 * 1024 + 1)
        if len(data) > 512 * 1024 * 1024:
            raise HTTPException(413, "packs over 512 MB cannot be verified here; use verify.py")
        return evidence.verify_pack(data, services.keyring.public_key_pem())

    @r.get("/api/evidence/public-key")
    def public_key():
        # Deliberately public: anyone holding a pack may check who signed it.
        return {"key_id": services.keyring.key_id(), "public_key_pem": services.keyring.public_key_pem()}

    @r.get("/api/audit/verify")
    def verify_chain(_: dict = Depends(manager)):
        return store.verify_audit_chain()

    # == catalog studio =========================================================================
    @r.get("/api/studio/skus")
    def studio_skus(_: dict = Depends(counter)):
        live = services.current_catalog()
        rows = {s["sku"]: s for s in store.list_skus(include_archived=True)}
        out = []
        for e in live.entries:
            row = rows.pop(e.sku, None)
            out.append({"sku": e.sku, "label": e.label, "unit_value": e.unit_value,
                        "hue": list(e.hue) if e.hue else None, "barcodes": e.barcodes,
                        "source": e.source, "photos": row["photos"] if row else 0,
                        "archived": bool(row["archived"]) if row else False})
        for row in rows.values():  # archived studio products are not in the live catalog
            out.append({"sku": row["sku"], "label": row["label"], "unit_value": row["unit_value"],
                        "hue": row["hue"], "barcodes": row["barcodes"], "source": "studio",
                        "photos": row["photos"], "archived": bool(row["archived"])})
        return sorted(out, key=lambda x: x["sku"])

    @r.post("/api/studio/skus", status_code=201)
    def studio_save(body: SkuIn, who: dict = Depends(manager)):
        fields = {k: v for k, v in body.model_dump().items() if v is not None and k != "sku"}
        if "archived" in fields:
            fields["archived"] = int(bool(fields["archived"]))
        return catalog_ops.save_sku(services, body.sku, fields, who)

    @r.post("/api/studio/skus/import", status_code=201)
    async def studio_import(file: UploadFile = File(...), who: dict = Depends(manager)):
        try:
            items = csvio.parse_skus(await _read_text(file))
        except integrations.IntegrationError as exc:
            raise HTTPException(400, str(exc)) from None
        for item in items:
            sku = item.pop("sku")
            catalog_ops.save_sku(services, sku, item, who)
        return {"imported": len(items)}

    @r.get("/api/studio/skus/{sku:path}/photos")
    def studio_photos(sku: str, _: dict = Depends(counter)):
        return [{k: p[k] for k in ("photo_id", "sku", "source", "run_id", "review_id", "created_at")}
                for p in store.list_photos(sku)]

    @r.post("/api/studio/skus/{sku:path}/photos", status_code=201)
    async def studio_add_photos(sku: str, files: list[UploadFile] = File(...),
                                who: dict = Depends(manager)):
        if len(files) > 20:
            raise HTTPException(400, "upload at most 20 photos at a time")
        added = []
        for f in files:
            data = await f.read(catalog_ops.MAX_PHOTO_BYTES + 1)
            added.append(catalog_ops.add_photo(services, sku, data, who)["photo_id"])
        return {"added": added, "quality": catalog_ops.quality(services)["products"].get(sku)}

    @r.get("/api/studio/photos/{photo_id}.jpg")
    def studio_photo(photo_id: str, _: dict = Depends(counter)):
        photo = store.get_photo(photo_id)
        if photo is None or not Path(photo["path"]).is_file():
            raise HTTPException(404, "no such photo")
        return FileResponse(photo["path"], media_type="image/jpeg")

    @r.delete("/api/studio/photos/{photo_id}")
    def studio_delete_photo(photo_id: str, who: dict = Depends(manager)):
        catalog_ops.delete_photo(services, photo_id, who)
        return {"ok": True}

    @r.post("/api/studio/identify")
    async def studio_identify(file: UploadFile = File(...), _: dict = Depends(counter)):
        return catalog_ops.identify_photo(services, await file.read(catalog_ops.MAX_PHOTO_BYTES + 1))

    @r.get("/api/studio/quality")
    def studio_quality(_: dict = Depends(counter)):
        return catalog_ops.quality(services)

    # == count-as-a-service ======================================================================
    @r.get("/api/sites")
    def list_sites(_: dict = Depends(counter)):
        return store.list_sites()

    @r.post("/api/sites", status_code=201)
    def create_site(body: SiteIn, who: dict = Depends(manager)):
        site = store.create_site(body.name, body.customer, body.address, body.timezone)
        store.add_audit(site["site_id"], "site_created", body.model_dump(), actor=who["username"])
        return site

    @r.get("/api/service-jobs")
    def list_service_jobs(status: str | None = None, mine: bool = False,
                          who: dict = Depends(counter)):
        return store.list_service_jobs(status, who["user_id"] if mine else None)

    @r.post("/api/service-jobs", status_code=201)
    def create_service_job(body: ServiceJobIn, who: dict = Depends(manager)):
        unknown = [u for u in body.crew if store.get_user(u) is None]
        if unknown:
            raise HTTPException(400, f"unknown crew member(s): {', '.join(unknown)}")
        job = store.create_service_job(**body.model_dump(), created_by=who["user_id"])
        store.add_audit(job["job_id"], "service_job_created", body.model_dump(), actor=who["username"])
        return job

    @r.get("/api/service-jobs/{job_id}")
    def get_service_job(job_id: str, _: dict = Depends(counter)):
        job = store.get_service_job(job_id)
        if job is None:
            raise HTTPException(404, "no such job")
        return job

    @r.patch("/api/service-jobs/{job_id}")
    def patch_service_job(job_id: str, body: ServiceJobPatch, who: dict = Depends(counter)):
        job = store.get_service_job(job_id)
        if job is None:
            raise HTTPException(404, "no such job")
        fields = {k: v for k, v in body.model_dump().items() if v is not None}
        crew_only = set(fields) <= {"status", "notes"}
        is_crew = who["user_id"] in job["crew"]
        if not (who["role"] in ("manager", "admin") or (is_crew and crew_only)):
            raise HTTPException(403, "only the crew can update a job's status; managers edit the rest")
        if "status" in fields and fields["status"] not in ("planned", "in_progress", "done", "cancelled"):
            raise HTTPException(400, "status must be planned, in_progress, done or cancelled")
        if fields.get("status") == "done":
            fields["completed_at"] = time.time()
        if "data_consent" in fields:
            fields["data_consent"] = int(bool(fields["data_consent"]))
        store.update_service_job(job_id, **fields)
        store.add_audit(job_id, "service_job_updated", fields, actor=who["username"])
        return store.get_service_job(job_id)

    @r.get("/api/datasets/coco.zip")
    def dataset(all_runs: bool = False, frames_per_run: int = 8, _: dict = Depends(admin)):
        run_ids = ([x["run_id"] for x in store.list_runs(100000)] if all_runs
                   else store.consented_runs())
        if not run_ids:
            raise HTTPException(404, "no runs with data consent yet (set it on a service job)")
        data = export_coco(services, run_ids, max(1, min(frames_per_run, 50)),
                           ctx.cfg.identify.unknown_sku)
        return Response(data, media_type="application/zip",
                        headers={"Content-Disposition": 'attachment; filename="countbone-coco.zip"'})

    return r


def _valid_code(code: str) -> bool:
    import re

    return re.match(CODE_RE, code) is not None
