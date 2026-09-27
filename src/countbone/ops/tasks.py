"""Recount tasks: a mismatch becomes a job for a named person.

A task is closed by a recount, either typed in (a person counted by hand)
or filmed (a recount video, run with the task's id). Closing it releases
the blocked adjustment with the recounted number, which then goes through
the approval rules like any other.
"""

from __future__ import annotations

import time
from typing import Any

from ..security import role_at_least
from . import Forbidden, OpsError, Services, reconcile
from .final import final_counts


def assign(services: Services, task_id: str, assignee: str | None, actor: dict[str, Any],
           due_at: float | None = None) -> dict[str, Any]:
    store = services.store
    task = store.get_task(task_id)
    if task is None:
        raise OpsError("no such task")
    if not role_at_least(actor["role"], "manager"):
        raise Forbidden("assigning tasks needs a manager")
    if assignee is not None and store.get_user(assignee) is None:
        raise OpsError("no such user")
    fields: dict[str, Any] = {"assignee": assignee}
    if due_at is not None:
        fields["due_at"] = due_at
    store.update_task(task_id, **fields)
    store.add_audit(task_id, "task_assigned", {"assignee": assignee, "due_at": due_at},
                    actor=actor["username"])
    return store.get_task(task_id)  # type: ignore[return-value]


def complete(services: Services, task_id: str, count: int, actor: dict[str, Any] | None,
             note: str | None = None, run_id: str | None = None) -> dict[str, Any]:
    """Close a task with a recounted quantity."""
    store = services.store
    task = store.get_task(task_id)
    if task is None:
        raise OpsError("no such task")
    if task["status"] not in ("open", "escalated"):
        raise OpsError(f"this task is already {task['status']}")
    if count < 0:
        raise OpsError("a count cannot be negative")
    if actor is not None and task["assignee"] and task["assignee"] != actor["user_id"] \
            and not role_at_least(actor["role"], "manager"):
        raise Forbidden("this recount is assigned to someone else")
    who = actor["username"] if actor else "system"
    result = {"recount": int(count), "by": who, "note": note, "run_id": run_id,
              "method": "video" if run_id else "manual"}
    store.update_task(task_id, status="done", result=result, closed_at=time.time(),
                      closed_by=actor["user_id"] if actor else None)
    store.add_audit(task_id, "task_done", {**result, "sku": task["sku"], "location": task["location"],
                                           "first_count": task["counted"]}, actor=who)

    # Release the adjustment this recount was holding, with the recount's number.
    adj = store.open_adjustment_for(task["location"], task["sku"])
    if adj is not None:
        system_qty = adj["system_qty"] or 0
        delta = int(count) - system_qty
        if delta == 0:
            store.update_adjustment(adj["adjustment_id"], status="superseded", counted_qty=int(count),
                                    delta=0, value=0.0, note="the recount agrees with the book")
            store.add_audit(adj["adjustment_id"], "adjustment_resolved_by_recount",
                            {"recount": count}, actor=who)
        else:
            value = round(delta * (adj["unit_value"] or 0), 2)
            store.update_adjustment(adj["adjustment_id"], counted_qty=int(count), delta=delta,
                                    value=value, status="proposed",
                                    note=f"recounted as {count} by {who}")
            reconcile.decide(services, adj["adjustment_id"])
    return store.get_task(task_id)  # type: ignore[return-value]


def complete_with_run(services: Services, run: dict[str, Any]) -> dict[str, Any] | None:
    """A recount video finished: close its task with the video's number."""
    task = services.store.get_task(run["task_id"])
    if task is None or task["status"] not in ("open", "escalated"):
        return None
    fc = final_counts(run)
    if not fc["settled"]:
        # A recount that itself needs review is not a recount yet.
        services.store.update_task(task["task_id"], result={
            "note": "recount video waiting for review", "run_id": run["run_id"]})
        return services.store.get_task(task["task_id"])
    qty = next((r["final"] for r in fc["rows"] if r["sku"] == task["sku"]), 0)
    creator = services.store.get_user(run["created_by"]) if run.get("created_by") else None
    return complete(services, task["task_id"], qty, creator, note="recount video",
                    run_id=run["run_id"])


def cancel(services: Services, task_id: str, actor: dict[str, Any], note: str) -> dict[str, Any]:
    store = services.store
    task = store.get_task(task_id)
    if task is None:
        raise OpsError("no such task")
    if not role_at_least(actor["role"], "manager"):
        raise Forbidden("cancelling tasks needs a manager")
    if task["status"] not in ("open", "escalated"):
        raise OpsError(f"this task is already {task['status']}")
    store.update_task(task_id, status="cancelled", closed_at=time.time(), closed_by=actor["user_id"],
                      result={"note": note})
    store.add_audit(task_id, "task_cancelled", {"note": note}, actor=actor["username"])
    # The adjustment it held goes to approval on the original count.
    adj = store.open_adjustment_for(task["location"], task["sku"])
    if adj is not None and adj["status"] == "blocked":
        store.update_adjustment(adj["adjustment_id"], status="proposed", note="recount cancelled")
        reconcile.decide(services, adj["adjustment_id"])
    return store.get_task(task_id)  # type: ignore[return-value]
