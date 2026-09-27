"""Receive: count a delivery against its purchase order at the dock.

A receipt is a PO's lines (SKU, ordered quantity, unit cost). Each video
filmed against it (one per pallet, or one walk around the load) is counted
with the PO as its expected numbers. Separate videos are separate pallets,
so their counts add up; a pallet filmed twice belongs in a walk, where the
overlap is merged away.

When the count disagrees with the PO the receipt is marked discrepancy, and
a shortage opens a draft supplier claim priced at the PO's unit costs, with
the videos attached as evidence, while the truck is still at the dock.
"""

from __future__ import annotations

import time
from collections import defaultdict
from typing import Any

from ..security import role_at_least
from . import Forbidden, OpsError, Services
from .final import final_counts
from .merge import merge, objects_from_run


def create(services: Services, po_number: str, lines: dict[str, dict[str, Any]],
           actor: dict[str, Any], supplier: str | None = None, dock: str | None = None,
           source: str = "manual", note: str | None = None) -> dict[str, Any]:
    po_number = (po_number or "").strip()
    if not po_number:
        raise OpsError("a receipt needs a PO number")
    if not lines:
        raise OpsError("a receipt needs at least one line")
    for sku, line in lines.items():
        if int(line.get("qty", -1)) < 0:
            raise OpsError(f"line {sku}: quantity must be zero or more")
    receipt = services.store.create_receipt(po_number, lines, supplier, dock, source,
                                            actor["user_id"], note)
    services.store.add_audit(receipt["receipt_id"], "receipt_created",
                             {"po_number": po_number, "lines": lines, "supplier": supplier,
                              "source": source}, actor=actor["username"])
    return receipt


def expected_for(receipt: dict[str, Any]) -> dict[str, int]:
    return {line["sku"]: int(line["expected_qty"]) for line in receipt["lines"]}


def received_totals(services: Services, receipt: dict[str, Any]) -> tuple[dict[str, int], bool]:
    """(units received per SKU across the receipt's videos, all reviews settled)."""
    store = services.store
    runs = [store.get_run(rid) for rid in receipt["runs"]]
    runs = [r for r in runs if r]
    totals: dict[str, int] = defaultdict(int)
    settled = True
    walks: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for run in runs:
        fc = final_counts(run)
        settled = settled and fc["settled"]
        if run.get("walk_id"):
            walks[run["walk_id"]].append(run)
            continue
        for row in fc["rows"]:
            totals[row["sku"]] += row["final"]
    for walk_runs in walks.values():
        merged = merge([(r["run_id"], objects_from_run(r)) for r in walk_runs])
        for sku, n in merged.counts().items():
            totals[sku] += n
    return dict(totals), settled


def apply_runs(services: Services, receipt_id: str) -> dict[str, Any]:
    """Recompute a receipt from its videos (after a run, or a review decision)."""
    store = services.store
    receipt = store.get_receipt(receipt_id)
    if receipt is None:
        raise OpsError("no such receipt")
    if receipt["status"] == "closed":
        return receipt
    unknown = services.extra.get("unknown_sku", "UNKNOWN")
    totals, settled = received_totals(services, receipt)
    ordered = expected_for(receipt)
    received = {sku: totals.get(sku, 0) for sku in ordered}
    received.update({sku: n for sku, n in totals.items() if sku not in ordered and n and sku != unknown})
    store.set_received(receipt_id, received)
    mismatch = any(received.get(s, 0) != q for s, q in ordered.items()) or any(
        s not in ordered for s in received)
    status = "discrepancy" if mismatch else "counted"
    store.update_receipt(receipt_id, status=status,
                         note=None if settled else "provisional: reviews still open on a video")
    receipt = store.get_receipt(receipt_id)
    store.add_audit(receipt_id, "receipt_counted",
                    {"received": received, "status": status, "settled": settled,
                     "runs": receipt["runs"]}, actor="system")  # type: ignore[index]
    if status == "discrepancy" and settled:
        _draft_claim(services, receipt)  # type: ignore[arg-type]
    return store.get_receipt(receipt_id)  # type: ignore[return-value]


def discrepancies(receipt: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for line in receipt["lines"]:
        got = line["received_qty"] if line["received_qty"] is not None else 0
        diff = got - line["expected_qty"]
        if diff:
            out.append({"sku": line["sku"], "ordered": line["expected_qty"], "received": got,
                        "difference": diff, "unit_cost": line["unit_cost"],
                        "value": round(diff * (line["unit_cost"] or 0), 2)})
    return out


def _draft_claim(services: Services, receipt: dict[str, Any]) -> None:
    shorts = [d for d in discrepancies(receipt) if d["difference"] < 0]
    if not shorts:
        return
    amount = round(-sum(d["value"] for d in shorts), 2)
    store = services.store
    existing = next((c for c in store.list_claims() if c["receipt_id"] == receipt["receipt_id"]
                     and c["status"] == "draft"), None)
    note = "Short: " + ", ".join(f"{d['sku']} {-d['difference']} unit(s)" for d in shorts)
    if existing:
        store.update_claim(existing["claim_id"], amount=amount, note=note)
        return
    claim = store.create_claim(kind="supplier_shortage", counterparty=receipt.get("supplier"),
                               receipt_id=receipt["receipt_id"], run_ids=receipt["runs"],
                               amount=amount, note=note, created_by="system")
    store.add_audit(claim["claim_id"], "claim_drafted",
                    {"receipt_id": receipt["receipt_id"], "po_number": receipt["po_number"],
                     "amount": amount, "shortages": shorts}, actor="system")


def close(services: Services, receipt_id: str, actor: dict[str, Any],
          note: str | None = None) -> dict[str, Any]:
    store = services.store
    receipt = store.get_receipt(receipt_id)
    if receipt is None:
        raise OpsError("no such receipt")
    if receipt["status"] == "closed":
        raise OpsError("already closed")
    if receipt["status"] == "discrepancy" and not role_at_least(actor["role"], "manager"):
        raise Forbidden("accepting a delivery with discrepancies needs a manager")
    if receipt["status"] == "open" and not receipt["runs"]:
        raise OpsError("film the delivery before closing the receipt")
    store.update_receipt(receipt_id, status="closed", closed_at=time.time(),
                         closed_by=actor["user_id"], note=note)
    store.add_audit(receipt_id, "receipt_closed",
                    {"discrepancies": discrepancies(receipt), "note": note},
                    actor=actor["username"])
    return store.get_receipt(receipt_id)  # type: ignore[return-value]
