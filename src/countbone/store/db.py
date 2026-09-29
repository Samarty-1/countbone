"""The database.

SQLite, one file, no server. Keeping it boring means a customer can open it
with any tool and audit us. The schema lives in store/schema.py as numbered
migrations; domain tables are reached through the repositories in
store/repos.py, mixed into the one Store class so every caller shares one
connection and one lock.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import time
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from ..types import CountResult, ReviewItem
from .repos import AccessRepo, CatalogRepo, OpsRepo
from .schema import MIGRATIONS

GENESIS = "0" * 64


def _json(value: Any) -> str:
    return json.dumps(value, default=str)


def _chain_hash(prev: str, subject: str, kind: str, payload: str, created_at: float,
                actor: str | None) -> str:
    body = "\x1f".join([prev, subject, kind, payload, repr(float(created_at)), actor or ""])
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


class Store(AccessRepo, CatalogRepo, OpsRepo):
    """Thin, explicit data access. No ORM, no lazy objects."""

    def __init__(self, path: str | Path = "countbone.db") -> None:
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        # Re-entrant: a repository method may call another inside one transaction.
        self._lock = threading.RLock()
        # A single shared connection keeps :memory: databases usable from the
        # API's worker threads; the lock serialises access.
        self._conn = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.execute("PRAGMA busy_timeout=5000")
        self._migrate()

    def _migrate(self) -> None:
        with self._lock:
            current = self._conn.execute("PRAGMA user_version").fetchone()[0]
            for version, script in enumerate(MIGRATIONS, start=1):
                if version <= current:
                    continue
                # One transaction per migration: DDL is transactional in
                # SQLite, so a failed upgrade leaves the previous version intact.
                self._conn.executescript(
                    f"BEGIN;\n{script}\nPRAGMA user_version = {version};\nCOMMIT;"
                )

    @property
    def schema_version(self) -> int:
        with self._lock:
            return int(self._conn.execute("PRAGMA user_version").fetchone()[0])

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # -- low-level helpers shared by the repositories --------------------
    @contextmanager
    def _tx(self) -> Iterator[sqlite3.Connection]:
        """A write transaction. Nested use joins the outer one."""
        with self._lock:
            if self._conn.in_transaction:
                yield self._conn
                return
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                yield self._conn
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise
            self._conn.execute("COMMIT")

    def _rows(self, sql: str, params: Iterable[Any] = ()) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(r) for r in self._conn.execute(sql, tuple(params)).fetchall()]

    def _one(self, sql: str, params: Iterable[Any] = ()) -> dict[str, Any] | None:
        rows = self._rows(sql, params)
        return rows[0] if rows else None

    def _exec(self, sql: str, params: Iterable[Any] = ()) -> int:
        with self._tx() as conn:
            return conn.execute(sql, tuple(params)).rowcount

    # -- audit trail -------------------------------------------------------
    def add_audit(self, run_id: str, kind: str, payload: Any, actor: str | None = None) -> None:
        """Append to the hash-chained trail. `run_id` is the subject's id."""
        body = _json(payload)
        with self._tx() as conn:
            last = conn.execute(
                "SELECT row_hash FROM audit WHERE row_hash IS NOT NULL ORDER BY id DESC LIMIT 1"
            ).fetchone()
            prev = last["row_hash"] if last else GENESIS
            now = time.time()
            row_hash = _chain_hash(prev, run_id, kind, body, now, actor)
            conn.execute(
                """INSERT INTO audit (run_id, kind, payload, created_at, actor, prev_hash, row_hash)
                   VALUES (?,?,?,?,?,?,?)""",
                (run_id, kind, body, now, actor, prev, row_hash),
            )

    def verify_audit_chain(self, checkpoints: Iterable[dict[str, Any]] = ()) -> dict[str, Any]:
        """Recompute every link. Any edit, deletion or insertion shows up as
        the first row whose stored hash no longer matches.

        The chain alone cannot catch someone who can write the database: they
        can recompute every hash after an edit, or delete the newest rows.
        `checkpoints` ({rows, head}, signed and kept outside the database)
        catch both: the chain must still pass through each one."""
        wanted = {int(c["rows"]): c["head"] for c in checkpoints}
        seen: dict[int, str] = {0: GENESIS} if 0 in wanted else {}
        rows = self._rows("SELECT * FROM audit ORDER BY id")
        prev = GENESIS
        checked = legacy = 0
        for row in rows:
            if row["row_hash"] is None:
                legacy += 1  # written before the chain existed (schema v1)
                continue
            if row["prev_hash"] != prev:
                return {"ok": False, "checked": checked, "legacy_rows": legacy,
                        "broken_at": row["id"], "problem": "a row before this one was removed or altered"}
            expected = _chain_hash(prev, row["run_id"], row["kind"], row["payload"] or "null",
                                   row["created_at"], row["actor"])
            if expected != row["row_hash"]:
                return {"ok": False, "checked": checked, "legacy_rows": legacy,
                        "broken_at": row["id"], "problem": "this row was altered"}
            prev = row["row_hash"]
            checked += 1
            if checked in wanted:
                seen[checked] = prev
        for n, head in sorted(wanted.items()):
            if n > checked:
                return {"ok": False, "checked": checked, "legacy_rows": legacy,
                        "problem": f"a checkpoint saw {n} events; only {checked} remain, "
                                   "so the newest were deleted"}
            if seen.get(n) != head:
                return {"ok": False, "checked": checked, "legacy_rows": legacy,
                        "problem": f"the trail up to event {n} was rewritten since a checkpoint"}
        return {"ok": True, "checked": checked, "legacy_rows": legacy, "head": prev,
                "checkpoints_matched": len(wanted)}

    def audit_head(self) -> dict[str, Any]:
        """{rows, head}: how many chained events there are and the last hash."""
        # One statement, so an event written meanwhile cannot split the pair.
        row = self._one(
            "SELECT COUNT(*) AS n, (SELECT row_hash FROM audit WHERE row_hash IS NOT NULL "
            "ORDER BY id DESC LIMIT 1) AS head FROM audit WHERE row_hash IS NOT NULL")
        return {"rows": int(row["n"]), "head": row["head"] or GENESIS}

    def audit_trail(self, run_id: str) -> list[dict[str, Any]]:
        rows = self._rows(
            "SELECT * FROM audit WHERE run_id = ? ORDER BY id", (run_id,)
        )
        for row in rows:
            row["payload"] = json.loads(row["payload"] or "null")
        return rows

    def recent_audit(self, limit: int = 100, kind: str | None = None) -> list[dict[str, Any]]:
        if kind:
            rows = self._rows("SELECT * FROM audit WHERE kind = ? ORDER BY id DESC LIMIT ?",
                              (kind, limit))
        else:
            rows = self._rows("SELECT * FROM audit ORDER BY id DESC LIMIT ?", (limit,))
        for row in rows:
            row["payload"] = json.loads(row["payload"] or "null")
        return rows

    # -- runs --------------------------------------------------------------
    def save_run(self, result: CountResult, config_fingerprint: str = "") -> None:
        now = time.time()
        context = result.meta.get("context") or {}
        with self._tx() as conn:
            conn.execute(
                """INSERT OR REPLACE INTO runs (run_id, source, started_at, finished_at,
                       duration_s, frames_read, frames_used, frames_dropped, detections,
                       tracks, total, overall_confidence, needs_review, config_fingerprint, meta,
                       location, kind, created_by, walk_id, receipt_id, task_id, job_id)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    result.run_id,
                    result.source,
                    result.started_at,
                    result.finished_at,
                    result.duration_s,
                    result.frames_read,
                    result.frames_used,
                    result.frames_dropped,
                    result.detections,
                    result.tracks,
                    result.total,
                    result.overall_confidence,
                    int(result.needs_review),
                    config_fingerprint,
                    _json({"warnings": result.warnings, **result.meta}),
                    context.get("location"),
                    context.get("kind") or "count",
                    context.get("created_by"),
                    context.get("walk_id"),
                    context.get("receipt_id"),
                    context.get("task_id"),
                    context.get("job_id"),
                ),
            )
            conn.execute("DELETE FROM sku_counts WHERE run_id = ?", (result.run_id,))
            conn.executemany(
                """INSERT INTO sku_counts (run_id, sku, label, count, expected, variance,
                       confidence, evidence, counted_at)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                [
                    (
                        result.run_id,
                        c.sku,
                        c.label,
                        c.count,
                        c.expected,
                        c.variance,
                        c.confidence,
                        _json(c.evidence),
                        result.started_at,
                    )
                    for c in result.counts
                ],
            )
            conn.executemany(
                """INSERT OR REPLACE INTO reviews (review_id, run_id, sku, reason, confidence,
                       frame_index, bbox, crop_path, status, created_at, meta)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                [
                    (
                        r.review_id,
                        result.run_id,
                        r.sku,
                        r.reason,
                        r.confidence,
                        r.frame_index,
                        _json(list(r.bbox) if r.bbox else None),
                        r.crop_path,
                        r.status,
                        now,
                        _json(r.meta),
                    )
                    for r in result.reviews
                ],
            )

    def resolve_review(
        self,
        review_id: str,
        status: str,
        resolved_sku: str | None,
        resolved_by: str,
        resolved_count: int | None = None,
    ) -> bool:
        """Record a reviewer's decision.

        A recount goes into the review's meta rather than over the run's
        count: the machine's answer and the human's correction are both
        evidence, and the audit trail needs to show which was which.
        """
        if status not in {"accepted", "rejected", "corrected", "pending"}:
            raise ValueError(f"invalid review status {status!r}")
        now = time.time()
        with self._tx() as conn:
            row = conn.execute(
                "SELECT run_id, sku, meta FROM reviews WHERE review_id = ?", (review_id,)
            ).fetchone()
            if row is None:
                return False
            meta = json.loads(row["meta"] or "{}")
            if resolved_count is not None:
                meta["resolved_count"] = int(resolved_count)
            else:
                meta.pop("resolved_count", None)
            conn.execute(
                """UPDATE reviews
                      SET status = ?, resolved_sku = ?, resolved_by = ?, resolved_at = ?,
                          meta = ?
                    WHERE review_id = ?""",
                (status, resolved_sku, resolved_by, now, _json(meta), review_id),
            )
            self.add_audit(
                row["run_id"],
                "review_decision",
                {
                    "review_id": review_id,
                    "sku": row["sku"],
                    "status": status,
                    "resolved_sku": resolved_sku,
                    "resolved_count": resolved_count,
                    "resolved_by": resolved_by,
                },
                actor=resolved_by,
            )
            return True

    # -- reads -------------------------------------------------------------
    def list_runs(self, limit: int = 50, location: str | None = None,
                  kind: str | None = None) -> list[dict[str, Any]]:
        clauses, params = [], []
        if location:
            clauses.append("location = ?")
            params.append(location)
        if kind:
            clauses.append("kind = ?")
            params.append(kind)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        return self._rows(
            f"SELECT * FROM runs {where} ORDER BY started_at DESC LIMIT ?", (*params, limit)
        )

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        run = self._one("SELECT * FROM runs WHERE run_id = ?", (run_id,))
        if run is None:
            return None
        run["meta"] = json.loads(run["meta"] or "{}")
        run["counts"] = self._rows(
            "SELECT * FROM sku_counts WHERE run_id = ? ORDER BY sku", (run_id,)
        )
        for c in run["counts"]:
            c["evidence"] = json.loads(c["evidence"] or "{}")
        run["reviews"] = self._rows(
            "SELECT * FROM reviews WHERE run_id = ? ORDER BY confidence ASC", (run_id,)
        )
        return run

    def reviews(self, status: str | None = "pending", limit: int = 200) -> list[dict[str, Any]]:
        if status:
            return self._rows(
                "SELECT * FROM reviews WHERE status = ? ORDER BY confidence ASC LIMIT ?",
                (status, limit),
            )
        return self._rows("SELECT * FROM reviews ORDER BY created_at DESC LIMIT ?", (limit,))

    def review(self, review_id: str) -> dict[str, Any] | None:
        row = self._one("SELECT * FROM reviews WHERE review_id = ?", (review_id,))
        if row:
            row["meta"] = json.loads(row["meta"] or "{}")
            row["bbox"] = json.loads(row["bbox"] or "null")
        return row

    def sku_history(self, sku: str, limit: int = 100) -> list[dict[str, Any]]:
        return self._rows(
            """SELECT sc.run_id, sc.count, sc.expected, sc.variance, sc.confidence,
                      sc.counted_at, r.location
                 FROM sku_counts sc JOIN runs r ON r.run_id = sc.run_id
                WHERE sc.sku = ? ORDER BY sc.counted_at DESC LIMIT ?""",
            (sku, limit),
        )

    def review_items(self, run_id: str) -> list[ReviewItem]:
        out = []
        for row in self._rows("SELECT * FROM reviews WHERE run_id = ?", (run_id,)):
            bbox = json.loads(row["bbox"] or "null")
            out.append(
                ReviewItem(
                    review_id=row["review_id"],
                    run_id=row["run_id"],
                    sku=row["sku"],
                    reason=row["reason"] or "",
                    confidence=row["confidence"] or 0.0,
                    frame_index=row["frame_index"] or 0,
                    bbox=tuple(bbox) if bbox else None,
                    crop_path=row["crop_path"],
                    status=row["status"],
                    resolved_sku=row["resolved_sku"],
                    meta=json.loads(row["meta"] or "{}"),
                )
            )
        return out
