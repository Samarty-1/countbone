"""Reconcile: turn counts into signed-off changes to the book.

The flow, per location and SKU:

  count differs from book ──► outside tolerance? ──► recount task (blocked)
                                   │                        │ recount done
                                   ▼                        ▼
                               adjustment  ◄────────────────┘
                                   │
            rules by value:  small ──► auto-approved
                             medium ─► a manager approves
                             large ──► an admin (finance) approves
                                   │
                                   ▼
                     posted to the system of record (or exported)

An adjustment is one proposed change: book quantity, counted quantity,
delta and its value. A newer count of the same place supersedes an older
open adjustment rather than stacking on it, so the inbox only ever shows
the current disagreement.
"""

from __future__ import annotations

import time
from collections import defaultdict
from typing import Any

from .. import integrations
from ..security import role_at_least
from . import Forbidden, OpsError, Services
from .final import final_counts
from .merge import merge, objects_from_run

DEFAULT_RULES: dict[str, Any] = {
    # auto-approve a difference this small (both limits must hold)
    "auto_approve_max_value": 25.0,
    "auto_approve_max_units": 2,
    # up to this value a manager signs off; above it, an admin (finance)
    "manager_max_value": 1000.0,
    # "all": every mismatch gets a recount task before it can be approved;
    # "above_auto": only mismatches too big to auto-approve; "none": never
    "recount_policy": "all",
    "recount_due_hours": 24,
    # push approved adjustments to this integration as soon as they are approved
    "post_to": None,
    "auto_post": False,
    # Separation of duties. A recount is not done by the person whose count is
    # in dispute, and an adjustment is not approved by whoever counted or
    # recounted it: otherwise one person can film, "correct" and sign off a
    # change to the book alone, which is exactly what a stock count exists to
    # catch. A one-person shop can turn these off.
    "independent_recount": True,
    "four_eyes": True,
}

RULE_ROLE = {"auto": "counter", "manager": "manager", "admin": "admin"}


def rules(services: Services) -> dict[str, Any]:
    return {**DEFAULT_RULES, **(services.store.get_setting("reconcile_rules") or {})}


def set_rules(services: Services, patch: dict[str, Any], actor: dict[str, Any]) -> dict[str, Any]:
    unknown = set(patch) - set(DEFAULT_RULES)
    if unknown:
        raise OpsError(f"unknown rule(s): {', '.join(sorted(unknown))}")
    if patch.get("recount_policy") not in (None, "all", "above_auto", "none"):
        raise OpsError("recount_policy must be all, above_auto or none")
    for key in ("independent_recount", "four_eyes", "auto_post"):
        if key in patch and not isinstance(patch[key], bool):
            raise OpsError(f"{key} must be true or false")
    for key in ("auto_approve_max_value", "manager_max_value", "auto_approve_max_units",
                "recount_due_hours"):
        if key in patch and (patch[key] is None or float(patch[key]) < 0):
            raise OpsError(f"{key} must be zero or more")
    merged = {**rules(services), **patch}
    services.store.set_setting("reconcile_rules", merged, actor["user_id"])
    services.store.add_audit("settings", "reconcile_rules", merged, actor=actor["username"])
    return merged


def classify(delta: int, value: float, r: dict[str, Any]) -> str:
    if abs(value) <= float(r["auto_approve_max_value"]) and abs(delta) <= int(r["auto_approve_max_units"]):
        return "auto"
    if abs(value) <= float(r["manager_max_value"]):
        return "manager"
    return "admin"


def needs_recount(rule: str, r: dict[str, Any]) -> bool:
    policy = r["recount_policy"]
    return policy == "all" or (policy == "above_auto" and rule != "auto")


# -- what was counted ------------------------------------------------------------
def counted_at(services: Services, run: dict[str, Any]) -> tuple[dict[str, int], dict[str, int], str]:
    """(final count per SKU, open reviews per SKU, how it was derived).

    A run in a walk speaks for the whole walk: the walk's videos are merged
    so an overlap is counted once.
    """
    store = services.store
    if run.get("walk_id"):
        runs = [store.get_run(r["run_id"]) for r in store.walk_runs(run["walk_id"])]
        runs = [r for r in runs if r]
        merged = merge([(r["run_id"], objects_from_run(r)) for r in runs])
        pending: dict[str, int] = defaultdict(int)
        for r in runs:
            for row in final_counts(r)["rows"]:
                pending[row["sku"]] += row["pending_reviews"]
        return merged.counts(), dict(pending), f"walk {run['walk_id']} ({len(runs)} videos merged)"
    fc = final_counts(run)
    return ({r["sku"]: r["final"] for r in fc["rows"]},
            {r["sku"]: r["pending_reviews"] for r in fc["rows"]}, f"run {run['run_id']}")


# -- keeping adjustments in step with counts ----------------------------------------
def sync_run(services: Services, run_id: str) -> list[dict[str, Any]]:
    """Create or refresh the adjustments (and recount tasks) a run implies.

    Idempotent: call it when a run finishes and again whenever a review
    decision changes its final count.
    """
    store = services.store
    run = store.get_run(run_id)
    if run is None or not run.get("location") or run.get("kind") not in ("count", None):
        return []
    location = run["location"]
    book = store.expected_for(location)
    if not book:
        return []  # nothing to reconcile against
    r = rules(services)
    counted, pending, source = counted_at(services, run)
    unknown = services_unknown_sku(services)
    touched = []
    for sku in sorted(set(book) | set(counted)):
        if sku == unknown:
            continue  # an unnamed object is a review, not a book change
        qty = int(counted.get(sku, 0))
        system_qty = int(book.get(sku, 0))
        delta = qty - system_qty
        existing = store.open_adjustment_for(location, sku)
        if existing is None and store.decided_adjustment_for(location, sku, run_id):
            # Signed off already: the book change this run implied is decided,
            # and a later review of the same video does not reopen it.
            continue
        if existing and existing["run_id"] != run_id and existing["run_id"] is not None:
            older = store.get_run(existing["run_id"])
            if older and older["started_at"] > run["started_at"]:
                continue  # a newer count already speaks for this place
        if existing and existing["run_id"] == run_id and _recounted(store, existing):
            continue  # a person recounted this; their number stands over the video's
        if delta == 0:
            if existing:
                store.update_adjustment(existing["adjustment_id"], status="superseded",
                                        note=f"a later count agrees with the book ({source})")
            continue
        unit_value = services.unit_value(sku)
        value = round(delta * unit_value, 2)
        rule = classify(delta, value, r)
        fields = {"system_qty": system_qty, "counted_qty": qty, "delta": delta,
                  "unit_value": unit_value, "value": value, "run_id": run_id, "rule": rule}
        if existing and existing["run_id"] == run_id:
            store.update_adjustment(existing["adjustment_id"], **fields)
            adj = store.get_adjustment(existing["adjustment_id"])
        else:
            if existing:
                store.update_adjustment(existing["adjustment_id"], status="superseded",
                                        note=f"superseded by {source}")
            adj = store.create_adjustment(location=location, sku=sku, status="blocked",
                                          note=source, **fields)
            store.add_audit(adj["adjustment_id"], "adjustment_proposed",
                            {**fields, "location": location, "sku": sku, "source": source},
                            actor="system")
        adj = _route(services, adj, run, pending.get(sku, 0), r)
        touched.append(adj)
    return touched


def services_unknown_sku(services: Services) -> str:
    return services.extra.get("unknown_sku", "UNKNOWN")


def _route(services: Services, adj: dict[str, Any], run: dict[str, Any], pending_reviews: int,
           r: dict[str, Any]) -> dict[str, Any]:
    """Decide what an adjustment waits for: reviews, a recount, or approval."""
    store = services.store
    if adj["status"] not in ("blocked", "proposed"):
        return adj
    if pending_reviews:
        store.update_adjustment(adj["adjustment_id"], status="blocked",
                                note=f"waiting for {pending_reviews} review(s) on the count")
        return store.get_adjustment(adj["adjustment_id"])  # type: ignore[return-value]
    task = store.open_task_for(adj["location"], adj["sku"])
    if task is None and needs_recount(adj["rule"], r) and not _recounted(store, adj):
        due = time.time() + float(r["recount_due_hours"]) * 3600
        task = store.create_task(
            kind="recount", status="open", location=adj["location"], sku=adj["sku"],
            run_id=adj["run_id"], reason=f"counted {adj['counted_qty']}, book says {adj['system_qty']}",
            expected=adj["system_qty"], counted=adj["counted_qty"], variance=adj["delta"],
            value_at_risk=abs(adj["value"]),
            # Unassigned under independent_recount: anyone but the first
            # counter takes it (or a manager assigns it).
            assignee=None if r.get("independent_recount") else run.get("created_by"), due_at=due,
            created_by="system",
        )
        store.add_audit(task["task_id"], "task_created",
                        {"sku": adj["sku"], "location": adj["location"], "variance": adj["delta"],
                         "assignee": task["assignee"], "adjustment_id": adj["adjustment_id"]},
                        actor="system")
    if task is not None:
        store.update_adjustment(adj["adjustment_id"], status="blocked", task_id=task["task_id"],
                                note="waiting for a recount")
        return store.get_adjustment(adj["adjustment_id"])  # type: ignore[return-value]
    return decide(services, adj["adjustment_id"])


def _recounted(store, adj: dict[str, Any]) -> bool:
    """Has this disagreement already been recounted? Then do not ask again."""
    if adj.get("task_id"):
        task = store.get_task(adj["task_id"])
        return bool(task and task["status"] == "done")
    return False


def decide(services: Services, adjustment_id: str) -> dict[str, Any]:
    """Apply the value rules to an adjustment nobody is blocking."""
    store = services.store
    adj = store.get_adjustment(adjustment_id)
    if adj is None:
        raise OpsError("no such adjustment")
    r = rules(services)
    rule = classify(adj["delta"], adj["value"], r)
    if rule == "auto":
        store.update_adjustment(adjustment_id, status="approved", rule=rule, decided_by=None,
                                decided_at=time.time(), note="auto-approved: within the small-difference rule")
        store.add_audit(adjustment_id, "adjustment_approved",
                        {"rule": "auto", "delta": adj["delta"], "value": adj["value"]}, actor="system")
        if r.get("auto_post") and r.get("post_to"):
            post(services, [adjustment_id], actor=None)
    else:
        store.update_adjustment(adjustment_id, status="proposed", rule=rule,
                                note=f"needs {RULE_ROLE[rule]} approval")
    return store.get_adjustment(adjustment_id)  # type: ignore[return-value]


# -- people deciding ---------------------------------------------------------------
def approve(services: Services, adjustment_id: str, actor: dict[str, Any],
            note: str | None = None) -> dict[str, Any]:
    store = services.store
    adj = store.get_adjustment(adjustment_id)
    if adj is None:
        raise OpsError("no such adjustment")
    if adj["status"] != "proposed":
        raise OpsError(f"only a proposed adjustment can be approved (this one is {adj['status']})")
    needed = RULE_ROLE.get(adj["rule"] or "admin", "admin")
    if not role_at_least(actor["role"], needed):
        raise Forbidden(f"a difference worth {abs(adj['value']):.2f} needs {needed} approval")
    if rules(services).get("four_eyes") and actor.get("user_id") in _involved(store, adj):
        raise Forbidden("you counted or recounted this: someone else has to approve it")
    # The old note said what it was waiting for; approval answers that.
    store.update_adjustment(adjustment_id, status="approved", decided_by=actor["user_id"],
                            decided_at=time.time(), note=note or None)
    store.add_audit(adjustment_id, "adjustment_approved",
                    {"rule": adj["rule"], "delta": adj["delta"], "value": adj["value"],
                     "sku": adj["sku"], "location": adj["location"], "note": note},
                    actor=actor["username"])
    r = rules(services)
    if r.get("auto_post") and r.get("post_to"):
        post(services, [adjustment_id], actor=actor)
    return store.get_adjustment(adjustment_id)  # type: ignore[return-value]


def _involved(store, adj: dict[str, Any]) -> set[str]:
    """Who produced the numbers behind an adjustment: its count and its recount."""
    people: set[str] = set()
    run = store.get_run(adj["run_id"]) if adj.get("run_id") else None
    if run and run.get("created_by"):
        people.add(run["created_by"])
    task = store.get_task(adj["task_id"]) if adj.get("task_id") else None
    if task and task.get("closed_by"):
        people.add(task["closed_by"])
    return people


def reject(services: Services, adjustment_id: str, actor: dict[str, Any], note: str) -> dict[str, Any]:
    store = services.store
    adj = store.get_adjustment(adjustment_id)
    if adj is None:
        raise OpsError("no such adjustment")
    if adj["status"] not in ("proposed", "blocked", "approved"):
        raise OpsError(f"a {adj['status']} adjustment cannot be rejected")
    if not role_at_least(actor["role"], "manager"):
        raise Forbidden("rejecting an adjustment needs a manager")
    if not (note or "").strip():
        raise OpsError("say why the adjustment is rejected; it goes on the audit trail")
    store.update_adjustment(adjustment_id, status="rejected", decided_by=actor["user_id"],
                            decided_at=time.time(), note=note.strip())
    store.add_audit(adjustment_id, "adjustment_rejected",
                    {"note": note.strip(), "sku": adj["sku"], "location": adj["location"],
                     "delta": adj["delta"]}, actor=actor["username"])
    return store.get_adjustment(adjustment_id)  # type: ignore[return-value]


def connector_for(services: Services, name: str):
    row = services.store.get_integration(name)
    if row is None:
        raise OpsError(f"no integration named {name!r}")
    if not row["enabled"]:
        raise OpsError(f"integration {name!r} is disabled")
    secrets = services.keyring.unseal(row.get("secrets"))
    return integrations.build(row["kind"], row["settings"], secrets, services.http_client)


def post(services: Services, adjustment_ids: list[str] | None, actor: dict[str, Any] | None,
         integration: str | None = None) -> dict[str, Any]:
    """Write approved adjustments to the system of record."""
    store = services.store
    r = rules(services)
    name = integration or r.get("post_to")
    if not name:
        raise OpsError("no integration is set to receive adjustments; export CSV instead")
    if adjustment_ids is None:
        adjs = store.list_adjustments(status="approved")
    else:
        adjs = [a for a in (store.get_adjustment(i) for i in adjustment_ids) if a]
        bad = [a["adjustment_id"] for a in adjs if a["status"] not in ("approved", "failed")]
        if bad:
            raise OpsError(f"not approved: {', '.join(bad)}")
    if not adjs:
        return {"posted": 0, "failed": 0, "results": []}
    try:
        connector = connector_for(services, name)
        results = connector.push_adjustments([
            integrations.Adjustment(a["adjustment_id"], a["location"], a["sku"], a["system_qty"],
                                    a["counted_qty"], a["delta"], a.get("note") or "")
            for a in adjs
        ])
    except integrations.IntegrationError as exc:
        store.mark_integration(name, str(exc))
        results = [integrations.PostResult(a["adjustment_id"], False, error=str(exc)) for a in adjs]
    ok = failed = 0
    for res in results:
        if res.ok:
            ok += 1
            store.update_adjustment(res.adjustment_id, status="posted", integration=name,
                                    external_ref=res.external_ref, posted_at=time.time(),
                                    post_error=None)
        else:
            failed += 1
            store.update_adjustment(res.adjustment_id, status="failed", integration=name,
                                    post_error=res.error)
        store.add_audit(res.adjustment_id, "adjustment_posted" if res.ok else "adjustment_post_failed",
                        {"integration": name, "external_ref": res.external_ref, "error": res.error},
                        actor=(actor or {}).get("username", "system"))
    if failed == 0:
        store.mark_integration(name, None)
    return {"posted": ok, "failed": failed,
            "results": [res.__dict__ for res in results]}


def mark_exported(services: Services, adjustment_ids: list[str], actor: dict[str, Any],
                  reference: str) -> int:
    """For customers who post by file: record that these went out by CSV."""
    if not role_at_least(actor["role"], "manager"):
        raise Forbidden("needs a manager")
    n = 0
    for adj_id in adjustment_ids:
        adj = services.store.get_adjustment(adj_id)
        if adj and adj["status"] in ("approved", "failed"):
            services.store.update_adjustment(adj_id, status="posted", integration="csv",
                                             external_ref=reference, posted_at=time.time())
            services.store.add_audit(adj_id, "adjustment_posted",
                                     {"integration": "csv", "external_ref": reference},
                                     actor=actor["username"])
            n += 1
    return n


def period_report(services: Services, since: float, until: float) -> dict[str, Any]:
    rows = services.store.list_adjustments(since=since, until=until, limit=100000)
    by_status: dict[str, dict[str, float]] = defaultdict(lambda: {"count": 0, "units": 0, "value": 0.0})
    for a in rows:
        s = by_status[a["status"]]
        s["count"] += 1
        s["units"] += a["delta"]
        s["value"] = round(s["value"] + (a["value"] or 0), 2)
    booked = [a for a in rows if a["status"] == "posted"]
    return {
        "since": since, "until": until,
        "by_status": dict(by_status),
        "net_value_posted": round(sum(a["value"] or 0 for a in booked), 2),
        "gross_value_posted": round(sum(abs(a["value"] or 0) for a in booked), 2),
        "open": sum(1 for a in rows if a["status"] in ("blocked", "proposed", "approved", "failed")),
        "adjustments": rows,
    }
