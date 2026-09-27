"""What happens after a video is counted, and after a person changes its count.

One entry point per event, so the job runner and the review endpoint cannot
drift apart in what they trigger:

  after_run(run_id)       a run finished: route it by kind
  after_review(run_id)    a review decision changed a run's final count
"""

from __future__ import annotations

import logging
from typing import Any

from . import Services, receive, reconcile, tasks

log = logging.getLogger(__name__)


def _dispatch(services: Services, run: dict[str, Any], first_time: bool) -> dict[str, Any]:
    out: dict[str, Any] = {"kind": run.get("kind")}
    kind = run.get("kind") or "count"
    if kind == "receive" and run.get("receipt_id"):
        out["receipt"] = receive.apply_runs(services, run["receipt_id"])["status"]
    elif kind == "recount" and run.get("task_id"):
        task = tasks.complete_with_run(services, run)
        out["task"] = task["status"] if task else None
    else:
        out["adjustments"] = len(reconcile.sync_run(services, run["run_id"]))
    return out


def after_run(services: Services, run_id: str) -> dict[str, Any]:
    run = services.store.get_run(run_id)
    if run is None:
        return {}
    try:
        return _dispatch(services, run, first_time=True)
    except Exception:  # noqa: BLE001 - the count is saved; follow-ups must not fail it
        log.exception("post-run processing failed for %s", run_id)
        services.store.add_audit(run_id, "postrun_failed", {}, actor="system")
        return {"error": "post-run processing failed; see the server log"}


def after_review(services: Services, run_id: str) -> dict[str, Any]:
    run = services.store.get_run(run_id)
    if run is None:
        return {}
    return _dispatch(services, run, first_time=False)
