"""Count history.

SQLite, one file, no server. This is the table the analytics-layer plugins
read from: shrinkage, drift per SKU, discrepancy causes. Keeping it boring
means a customer can open it with any tool and audit us.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from ..types import CountResult, ReviewItem

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    run_id             TEXT PRIMARY KEY,
    source             TEXT NOT NULL,
    started_at         REAL NOT NULL,
    finished_at        REAL,
    duration_s         REAL,
    frames_read        INTEGER DEFAULT 0,
    frames_used        INTEGER DEFAULT 0,
    frames_dropped     INTEGER DEFAULT 0,
    detections         INTEGER DEFAULT 0,
    tracks             INTEGER DEFAULT 0,
    total              INTEGER DEFAULT 0,
    overall_confidence REAL DEFAULT 0,
    needs_review       INTEGER DEFAULT 0,
    config_fingerprint TEXT,
    meta               TEXT
);

CREATE TABLE IF NOT EXISTS sku_counts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id     TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    sku        TEXT NOT NULL,
    label      TEXT,
    count      INTEGER NOT NULL,
    expected   INTEGER,
    variance   INTEGER,
    confidence REAL,
    evidence   TEXT,
    counted_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sku_counts_sku ON sku_counts(sku, counted_at);
CREATE INDEX IF NOT EXISTS idx_sku_counts_run ON sku_counts(run_id);

CREATE TABLE IF NOT EXISTS reviews (
    review_id    TEXT PRIMARY KEY,
    run_id       TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    sku          TEXT NOT NULL,
    reason       TEXT,
    confidence   REAL,
    frame_index  INTEGER,
    bbox         TEXT,
    crop_path    TEXT,
    status       TEXT DEFAULT 'pending',
    resolved_sku TEXT,
    resolved_by  TEXT,
    resolved_at  REAL,
    created_at   REAL NOT NULL,
    meta         TEXT
);
CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status, created_at);

CREATE TABLE IF NOT EXISTS audit (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id     TEXT NOT NULL,
    kind       TEXT NOT NULL,
    payload    TEXT,
    created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_run ON audit(run_id, created_at);
"""


def _json(value: Any) -> str:
    return json.dumps(value, default=str)


class Store:
    """Thin, explicit data access. No ORM, no lazy objects."""

    def __init__(self, path: str | Path = "countbone.db") -> None:
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        # A single shared connection keeps :memory: databases usable from the
        # API's worker threads; the lock serialises writes.
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        with self._lock:
            self._conn.executescript(SCHEMA)
            self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # -- writes ----------------------------------------------------------
    def save_run(self, result: CountResult, config_fingerprint: str = "") -> None:
        now = time.time()
        with self._lock:
            self._conn.execute(
                """INSERT OR REPLACE INTO runs (run_id, source, started_at, finished_at,
                       duration_s, frames_read, frames_used, frames_dropped, detections,
                       tracks, total, overall_confidence, needs_review, config_fingerprint, meta)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
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
                ),
            )
            self._conn.execute("DELETE FROM sku_counts WHERE run_id = ?", (result.run_id,))
            self._conn.executemany(
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
            self._conn.executemany(
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
            self._conn.commit()

    def add_audit(self, run_id: str, kind: str, payload: Any) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO audit (run_id, kind, payload, created_at) VALUES (?,?,?,?)",
                (run_id, kind, _json(payload), time.time()),
            )
            self._conn.commit()

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
        with self._lock:
            row = self._conn.execute(
                "SELECT run_id, sku, meta FROM reviews WHERE review_id = ?", (review_id,)
            ).fetchone()
            if row is None:
                return False
            meta = json.loads(row["meta"] or "{}")
            if resolved_count is not None:
                meta["resolved_count"] = int(resolved_count)
            else:
                meta.pop("resolved_count", None)
            self._conn.execute(
                """UPDATE reviews
                      SET status = ?, resolved_sku = ?, resolved_by = ?, resolved_at = ?,
                          meta = ?
                    WHERE review_id = ?""",
                (status, resolved_sku, resolved_by, now, _json(meta), review_id),
            )
            self._conn.execute(
                "INSERT INTO audit (run_id, kind, payload, created_at) VALUES (?,?,?,?)",
                (
                    row["run_id"],
                    "review_decision",
                    _json({
                        "review_id": review_id,
                        "sku": row["sku"],
                        "status": status,
                        "resolved_sku": resolved_sku,
                        "resolved_count": resolved_count,
                        "resolved_by": resolved_by,
                    }),
                    now,
                ),
            )
            self._conn.commit()
            return True

    # -- reads -----------------------------------------------------------
    def _rows(self, sql: str, params: Iterable[Any] = ()) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(r) for r in self._conn.execute(sql, tuple(params)).fetchall()]

    def list_runs(self, limit: int = 50) -> list[dict[str, Any]]:
        return self._rows(
            "SELECT * FROM runs ORDER BY started_at DESC LIMIT ?", (limit,)
        )

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        rows = self._rows("SELECT * FROM runs WHERE run_id = ?", (run_id,))
        if not rows:
            return None
        run = rows[0]
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

    def sku_history(self, sku: str, limit: int = 100) -> list[dict[str, Any]]:
        return self._rows(
            """SELECT run_id, count, expected, variance, confidence, counted_at
                 FROM sku_counts WHERE sku = ? ORDER BY counted_at DESC LIMIT ?""",
            (sku, limit),
        )

    def audit_trail(self, run_id: str) -> list[dict[str, Any]]:
        rows = self._rows(
            "SELECT * FROM audit WHERE run_id = ? ORDER BY created_at", (run_id,)
        )
        for row in rows:
            row["payload"] = json.loads(row["payload"] or "null")
        return rows

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
                )
            )
        return out
