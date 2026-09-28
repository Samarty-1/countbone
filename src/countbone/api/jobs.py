"""The counting queue: durable, so a restart loses nothing.

Every submitted video is a row in the jobs table before it is a task in
memory. On start the runner re-queues whatever was queued or running when
the process last stopped (a job that has crashed the worker three times is
marked failed instead, so one bad file cannot wedge the queue).

One worker: counting is CPU-bound, and a queue is easier to reason about
than contention between two runs writing artifacts at once. One worker also
means the single Pipeline is never entered concurrently.
"""

from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from ..ops import Services, postrun
from ..plugins.location_tag import find_location

log = logging.getLogger(__name__)
MAX_ATTEMPTS = 3


class RunTracker:
    """Live progress of runs in flight. Small enough to keep in memory.

    Finished runs linger (a client polling a run that just ended still sees
    its last state) but only the newest KEEP_FINISHED of them: a server that
    counts for months must not keep every run it ever saw.
    """

    KEEP_FINISHED = 500

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._state: dict[str, dict[str, Any]] = {}

    def set(self, run_id: str, **fields: Any) -> None:
        with self._lock:
            self._state.setdefault(run_id, {"run_id": run_id}).update(fields)
            self._state[run_id]["_touched"] = time.time()
            if fields.get("status") in ("done", "failed"):
                self._evict()

    def _evict(self) -> None:
        finished = [k for k, v in self._state.items() if v.get("status") in ("done", "failed")]
        if len(finished) > self.KEEP_FINISHED:
            finished.sort(key=lambda k: self._state[k]["_touched"])
            for k in finished[: len(finished) - self.KEEP_FINISHED]:
                del self._state[k]

    @staticmethod
    def _public(v: dict[str, Any]) -> dict[str, Any]:
        return {k: x for k, x in v.items() if k != "_touched"}

    def get(self, run_id: str) -> dict[str, Any] | None:
        with self._lock:
            return self._public(self._state[run_id]) if run_id in self._state else None

    def all(self) -> list[dict[str, Any]]:
        with self._lock:
            return [self._public(v) for v in self._state.values()]


class JobRunner:
    def __init__(self, pipeline, services: Services, tracker: RunTracker) -> None:
        self.pipeline = pipeline
        self.services = services
        self.tracker = tracker
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="countbone")

    def submit(self, run_id: str, source: str, params: dict[str, Any], filename: str | None,
               created_by: str | None) -> None:
        self.services.store.enqueue_job(run_id, source, params, filename, created_by)
        self.tracker.set(run_id, status="queued", source=source, filename=filename, error=None,
                         kind=params.get("kind", "count"), location=params.get("location"))
        self.pool.submit(self._work, run_id)

    def resume(self) -> int:
        n = 0
        for job in self.services.store.unfinished_jobs():
            if job["attempts"] >= MAX_ATTEMPTS:
                self.services.store.set_job(job["run_id"], "failed",
                                            error="stopped the server repeatedly; not retried")
                continue
            self.tracker.set(job["run_id"], status="queued", source=job["source"],
                             filename=job["filename"], error=None, resumed=True,
                             kind=job["params"].get("kind", "count"),
                             location=job["params"].get("location"))
            self.pool.submit(self._work, job["run_id"])
            n += 1
        return n

    def shutdown(self) -> None:
        self.pool.shutdown(wait=False, cancel_futures=True)

    # -- the work ------------------------------------------------------------
    def _inputs(self, job: dict[str, Any]) -> tuple[dict[str, int] | None, dict[str, Any]]:
        """Expected numbers and run context for a job, from what asked for it."""
        store = self.services.store
        params = dict(job["params"] or {})
        kind = params.get("kind") or "count"
        context: dict[str, Any] = {
            k: params.get(k) for k in ("location", "walk_id", "receipt_id", "task_id", "job_id")
            if params.get(k)
        }
        context["kind"] = kind
        context["created_by"] = job.get("created_by")
        if kind == "receive":
            receipt = store.get_receipt(params["receipt_id"])
            return ({line["sku"]: int(line["expected_qty"]) for line in receipt["lines"]} if receipt else {}), context
        if kind == "recount":
            task = store.get_task(params["task_id"])
            if task:
                context.setdefault("location", task["location"])
        if not context.get("location"):
            try:
                found = find_location(job["source"])
            except Exception:  # noqa: BLE001 - a pre-scan is best effort
                found = None
            if found:
                context["location"] = found
                context["location_source"] = "label_in_video"
        location = context.get("location")
        expected = None
        if location:
            book = store.expected_for(location)
            expected = book or None
            plan = store.get_planogram(location)
            if plan:
                context["planogram"] = plan
        return expected, context

    def _work(self, run_id: str) -> None:
        store = self.services.store
        job = store.get_job(run_id)
        if job is None:
            return
        store.set_job(run_id, "running", bump_attempts=True)
        self.tracker.set(run_id, status="running")
        try:
            expected, context = self._inputs(job)
            if context.get("location"):
                self.tracker.set(run_id, location=context["location"])
            result = self.pipeline.run(job["source"], run_id=run_id, expected=expected,
                                       context=context)
            store.set_job(run_id, "done")
            self.tracker.set(
                run_id, status="done", total=result.total, needs_review=result.needs_review,
                confidence=round(result.overall_confidence, 4),
            )
            follow = postrun.after_run(self.services, run_id)
            self.tracker.set(run_id, followup=follow)
        except Exception as exc:  # noqa: BLE001 - surfaced to the client
            log.exception("run %s failed", run_id)
            store.set_job(run_id, "failed", error=str(exc))
            self.tracker.set(run_id, status="failed", error=str(exc))
