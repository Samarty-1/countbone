"""Repositories: the platform's tables, one mixin per area.

Mixed into store.db.Store, which supplies the connection, the lock and the
helpers (_tx, _rows, _one, _exec). Methods here are plain data access; the
rules about what may happen when live in countbone.ops.
"""

from __future__ import annotations

import json
import time
from typing import TYPE_CHECKING, Any

import numpy as np

from ..types import new_id

if TYPE_CHECKING:  # pragma: no cover
    import sqlite3
    from collections.abc import Iterable
    from contextlib import AbstractContextManager


def _j(value: Any) -> str | None:
    return None if value is None else json.dumps(value, default=str)


def _unj(value: Any, default: Any = None) -> Any:
    if value is None or value == "":
        return default
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return default


class _Base:
    """What the mixins expect from Store (declared for readers and linters)."""

    if TYPE_CHECKING:  # pragma: no cover
        def _tx(self) -> AbstractContextManager[sqlite3.Connection]: ...
        def _rows(self, sql: str, params: Iterable[Any] = ()) -> list[dict[str, Any]]: ...
        def _one(self, sql: str, params: Iterable[Any] = ()) -> dict[str, Any] | None: ...
        def _exec(self, sql: str, params: Iterable[Any] = ()) -> int: ...
        def add_audit(self, run_id: str, kind: str, payload: Any, actor: str | None = None) -> None: ...

    def _update(self, table: str, key_col: str, key: str, fields: dict[str, Any],
                allowed: set[str], json_cols: set[str] = frozenset()) -> bool:
        fields = {k: v for k, v in fields.items() if k in allowed}
        if not fields:
            return self._one(f"SELECT 1 FROM {table} WHERE {key_col} = ?", (key,)) is not None
        cols = ", ".join(f"{k} = ?" for k in fields)
        values = [_j(v) if k in json_cols else v for k, v in fields.items()]
        return self._exec(f"UPDATE {table} SET {cols} WHERE {key_col} = ?", (*values, key)) > 0


# -- people and access -----------------------------------------------------
class AccessRepo(_Base):
    def count_users(self) -> int:
        row = self._one("SELECT COUNT(*) AS n FROM users")
        return int(row["n"]) if row else 0

    def create_user(self, username: str, pw_hash: str, role: str,
                    display_name: str | None = None, created_by: str | None = None) -> dict[str, Any]:
        user_id = new_id("usr")
        self._exec(
            """INSERT INTO users (user_id, username, display_name, role, pw_hash, created_at, created_by)
               VALUES (?,?,?,?,?,?,?)""",
            (user_id, username.strip(), display_name or username.strip(), role, pw_hash,
             time.time(), created_by),
        )
        return self.get_user(user_id)  # type: ignore[return-value]

    def get_user(self, user_id: str) -> dict[str, Any] | None:
        return self._one("SELECT * FROM users WHERE user_id = ?", (user_id,))

    def user_by_username(self, username: str) -> dict[str, Any] | None:
        return self._one("SELECT * FROM users WHERE username = ?", (username.strip(),))

    def list_users(self) -> list[dict[str, Any]]:
        return self._rows("SELECT * FROM users ORDER BY disabled, username")

    def update_user(self, user_id: str, **fields: Any) -> bool:
        return self._update("users", "user_id", user_id, fields,
                            {"display_name", "role", "pw_hash", "disabled", "last_login_at"})

    def create_session(self, token_hash: str, user_id: str, expires_at: float,
                       client: str | None = None) -> None:
        now = time.time()
        self._exec(
            """INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at, last_seen_at, client)
               VALUES (?,?,?,?,?,?)""",
            (token_hash, user_id, now, expires_at, now, (client or "")[:200]),
        )

    def session_user(self, token_hash: str) -> dict[str, Any] | None:
        row = self._one(
            """SELECT u.*, s.expires_at AS session_expires_at, s.last_seen_at AS session_seen_at
                 FROM auth_sessions s JOIN users u ON u.user_id = s.user_id
                WHERE s.token_hash = ?""",
            (token_hash,),
        )
        now = time.time()
        if row is None or row["session_expires_at"] < now or row["disabled"]:
            return None
        # Touch at most once a minute: every request would be a write otherwise.
        if now - (row["session_seen_at"] or 0) > 60:
            self._exec("UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?",
                       (now, token_hash))
        return row

    def delete_session(self, token_hash: str) -> None:
        self._exec("DELETE FROM auth_sessions WHERE token_hash = ?", (token_hash,))

    def delete_user_sessions(self, user_id: str) -> None:
        self._exec("DELETE FROM auth_sessions WHERE user_id = ?", (user_id,))

    def purge_expired_sessions(self) -> int:
        return self._exec("DELETE FROM auth_sessions WHERE expires_at < ?", (time.time(),))

    def create_api_key(self, name: str, key_hash: str, role: str,
                       created_by: str | None) -> dict[str, Any]:
        key_id = new_id("key")
        self._exec(
            """INSERT INTO api_keys (key_id, name, key_hash, role, created_by, created_at)
               VALUES (?,?,?,?,?,?)""",
            (key_id, name, key_hash, role, created_by, time.time()),
        )
        return self._one("SELECT key_id, name, role, created_by, created_at, revoked FROM api_keys "
                         "WHERE key_id = ?", (key_id,))  # type: ignore[return-value]

    def api_key_by_hash(self, key_hash: str) -> dict[str, Any] | None:
        row = self._one("SELECT * FROM api_keys WHERE key_hash = ? AND revoked = 0", (key_hash,))
        if row and time.time() - (row["last_used_at"] or 0) > 60:
            self._exec("UPDATE api_keys SET last_used_at = ? WHERE key_id = ?",
                       (time.time(), row["key_id"]))
        return row

    def list_api_keys(self) -> list[dict[str, Any]]:
        return self._rows("SELECT key_id, name, role, created_by, created_at, last_used_at, revoked "
                          "FROM api_keys ORDER BY revoked, created_at DESC")

    def revoke_api_key(self, key_id: str) -> bool:
        return self._exec("UPDATE api_keys SET revoked = 1 WHERE key_id = ?", (key_id,)) > 0


# -- product catalog ---------------------------------------------------------
class CatalogRepo(_Base):
    def list_skus(self, include_archived: bool = False) -> list[dict[str, Any]]:
        where = "" if include_archived else "WHERE s.archived = 0"
        rows = self._rows(
            f"""SELECT s.*, (SELECT COUNT(*) FROM sku_photos p WHERE p.sku = s.sku) AS photos
                  FROM skus s {where} ORDER BY s.sku"""
        )
        for r in rows:
            r["hue"] = _unj(r["hue"])
            r["barcodes"] = _unj(r["barcodes"], [])
        return rows

    def get_sku(self, sku: str) -> dict[str, Any] | None:
        row = self._one("SELECT * FROM skus WHERE sku = ?", (sku,))
        if row:
            row["hue"] = _unj(row["hue"])
            row["barcodes"] = _unj(row["barcodes"], [])
        return row

    def upsert_sku(self, sku: str, fields: dict[str, Any], actor: str | None) -> dict[str, Any]:
        existing = self.get_sku(sku)
        with self._tx():
            if existing is None:
                self._exec(
                    """INSERT INTO skus (sku, label, unit_value, hue, achromatic, min_saturation,
                           barcodes, created_at, created_by)
                       VALUES (?,?,?,?,?,?,?,?,?)""",
                    (sku, fields.get("label") or sku, float(fields.get("unit_value") or 0),
                     _j(fields.get("hue")), int(bool(fields.get("achromatic"))),
                     int(fields.get("min_saturation") or 60), _j(fields.get("barcodes") or []),
                     time.time(), actor),
                )
            else:
                self._update("skus", "sku", sku, fields,
                             {"label", "unit_value", "hue", "achromatic", "min_saturation",
                              "barcodes", "archived"}, json_cols={"hue", "barcodes"})
        return self.get_sku(sku)  # type: ignore[return-value]

    def add_photo(self, sku: str, path: str, source: str, created_by: str | None,
                  vectors: list[tuple[str, np.ndarray]], version: int,
                  run_id: str | None = None, review_id: str | None = None,
                  photo_id: str | None = None) -> str:
        photo_id = photo_id or new_id("pho")
        with self._tx() as conn:
            conn.execute(
                """INSERT INTO sku_photos (photo_id, sku, path, source, run_id, review_id,
                       created_at, created_by) VALUES (?,?,?,?,?,?,?,?)""",
                (photo_id, sku, path, source, run_id, review_id, time.time(), created_by),
            )
            conn.executemany(
                "INSERT INTO sku_vectors (photo_id, sku, kind, version, vector) VALUES (?,?,?,?,?)",
                [(photo_id, sku, kind, version, np.asarray(v, np.float32).tobytes())
                 for kind, v in vectors],
            )
        return photo_id

    def list_photos(self, sku: str | None = None) -> list[dict[str, Any]]:
        if sku:
            return self._rows("SELECT * FROM sku_photos WHERE sku = ? ORDER BY created_at", (sku,))
        return self._rows("SELECT * FROM sku_photos ORDER BY sku, created_at")

    def get_photo(self, photo_id: str) -> dict[str, Any] | None:
        return self._one("SELECT * FROM sku_photos WHERE photo_id = ?", (photo_id,))

    def delete_photo(self, photo_id: str) -> bool:
        return self._exec("DELETE FROM sku_photos WHERE photo_id = ?", (photo_id,)) > 0

    def all_vectors(self) -> list[dict[str, Any]]:
        rows = self._rows(
            """SELECT v.photo_id, v.sku, v.kind, v.version, v.vector
                 FROM sku_vectors v JOIN skus s ON s.sku = v.sku
                WHERE s.archived = 0 ORDER BY v.id"""
        )
        for r in rows:
            r["vector"] = np.frombuffer(r["vector"], dtype=np.float32)
        return rows

    def replace_vectors(self, photo_id: str, sku: str,
                        vectors: list[tuple[str, np.ndarray]], version: int) -> None:
        with self._tx() as conn:
            conn.execute("DELETE FROM sku_vectors WHERE photo_id = ?", (photo_id,))
            conn.executemany(
                "INSERT INTO sku_vectors (photo_id, sku, kind, version, vector) VALUES (?,?,?,?,?)",
                [(photo_id, sku, kind, version, np.asarray(v, np.float32).tobytes())
                 for kind, v in vectors],
            )

    def stale_photo_ids(self, version: int) -> list[str]:
        return [r["photo_id"] for r in self._rows(
            "SELECT DISTINCT photo_id FROM sku_vectors WHERE version != ?", (version,))]


# -- operations --------------------------------------------------------------
_TASK_COLS = {"status", "assignee", "due_at", "result", "counted", "variance", "value_at_risk",
              "updated_at", "closed_at", "closed_by", "reason", "expected"}
_ADJ_COLS = {"status", "rule", "decided_by", "decided_at", "note", "integration", "external_ref",
             "post_error", "posted_at", "counted_qty", "delta", "value", "system_qty", "task_id",
             "run_id", "updated_at", "unit_value"}


class OpsRepo(_Base):
    # settings ------------------------------------------------------------
    def get_setting(self, key: str, default: Any = None) -> Any:
        row = self._one("SELECT value FROM settings WHERE key = ?", (key,))
        return _unj(row["value"], default) if row else default

    def set_setting(self, key: str, value: Any, actor: str | None) -> None:
        self._exec(
            """INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?,?,?,?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                   updated_at = excluded.updated_at, updated_by = excluded.updated_by""",
            (key, _j(value), time.time(), actor),
        )

    # sites -----------------------------------------------------------------
    def create_site(self, name: str, customer: str | None = None, address: str | None = None,
                    timezone: str | None = None) -> dict[str, Any]:
        site_id = new_id("site")
        self._exec("INSERT INTO sites (site_id, name, customer, address, timezone, created_at) "
                   "VALUES (?,?,?,?,?,?)", (site_id, name, customer, address, timezone, time.time()))
        return self.get_site(site_id)  # type: ignore[return-value]

    def get_site(self, site_id: str) -> dict[str, Any] | None:
        return self._one("SELECT * FROM sites WHERE site_id = ?", (site_id,))

    def list_sites(self) -> list[dict[str, Any]]:
        return self._rows("SELECT * FROM sites ORDER BY name")

    # locations ---------------------------------------------------------------
    def upsert_location(self, code: str, name: str | None = None, site_id: str | None = None,
                        zone: str | None = None, actor: str | None = None) -> dict[str, Any]:
        self._exec(
            """INSERT INTO locations (code, name, site_id, zone, created_at, created_by)
               VALUES (?,?,?,?,?,?)
               ON CONFLICT(code) DO UPDATE SET
                   name = COALESCE(excluded.name, locations.name),
                   site_id = COALESCE(excluded.site_id, locations.site_id),
                   zone = COALESCE(excluded.zone, locations.zone),
                   archived = 0""",
            (code, name, site_id, zone, time.time(), actor),
        )
        return self.get_location(code)  # type: ignore[return-value]

    def get_location(self, code: str) -> dict[str, Any] | None:
        return self._one("SELECT * FROM locations WHERE code = ?", (code,))

    def list_locations(self, site_id: str | None = None,
                       include_archived: bool = False) -> list[dict[str, Any]]:
        clauses, params = [], []
        if site_id:
            clauses.append("l.site_id = ?")
            params.append(site_id)
        if not include_archived:
            clauses.append("l.archived = 0")
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        return self._rows(
            f"""SELECT l.*,
                   (SELECT COUNT(*) FROM expected_stock e WHERE e.location = l.code) AS skus_expected,
                   (SELECT MAX(started_at) FROM runs r WHERE r.location = l.code) AS last_counted_at,
                   (SELECT run_id FROM runs r WHERE r.location = l.code
                     ORDER BY started_at DESC LIMIT 1) AS last_run_id
                  FROM locations l {where} ORDER BY l.code""",
            params,
        )

    def archive_location(self, code: str) -> bool:
        return self._exec("UPDATE locations SET archived = 1 WHERE code = ?", (code,)) > 0

    # book stock ---------------------------------------------------------------
    def set_expected(self, location: str, quantities: dict[str, int], source: str,
                     actor: str | None, replace: bool = False) -> None:
        now = time.time()
        with self._tx() as conn:
            if replace:
                conn.execute("DELETE FROM expected_stock WHERE location = ?", (location,))
            conn.executemany(
                """INSERT INTO expected_stock (location, sku, qty, source, updated_at, updated_by)
                   VALUES (?,?,?,?,?,?)
                   ON CONFLICT(location, sku) DO UPDATE SET qty = excluded.qty,
                       source = excluded.source, updated_at = excluded.updated_at,
                       updated_by = excluded.updated_by""",
                [(location, sku, int(q), source, now, actor) for sku, q in quantities.items()],
            )

    def expected_for(self, location: str) -> dict[str, int]:
        return {r["sku"]: int(r["qty"]) for r in self._rows(
            "SELECT sku, qty FROM expected_stock WHERE location = ?", (location,))}

    def expected_rows(self, location: str | None = None) -> list[dict[str, Any]]:
        if location:
            return self._rows("SELECT * FROM expected_stock WHERE location = ? ORDER BY sku",
                              (location,))
        return self._rows("SELECT * FROM expected_stock ORDER BY location, sku")

    # planograms ---------------------------------------------------------------
    def set_planogram(self, location: str, rows: list[list[str]], actor: str | None) -> None:
        self._exec(
            """INSERT INTO planograms (location, rows, updated_at, updated_by) VALUES (?,?,?,?)
               ON CONFLICT(location) DO UPDATE SET rows = excluded.rows,
                   updated_at = excluded.updated_at, updated_by = excluded.updated_by""",
            (location, _j(rows), time.time(), actor),
        )

    def get_planogram(self, location: str) -> list[list[str]] | None:
        row = self._one("SELECT rows FROM planograms WHERE location = ?", (location,))
        return _unj(row["rows"]) if row else None

    # durable job queue ----------------------------------------------------------
    def enqueue_job(self, run_id: str, source: str, params: dict[str, Any],
                    filename: str | None, created_by: str | None) -> None:
        now = time.time()
        self._exec(
            """INSERT INTO jobs (run_id, source, params, status, filename, created_by,
                   created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)""",
            (run_id, source, _j(params), "queued", filename, created_by, now, now),
        )

    def set_job(self, run_id: str, status: str, error: str | None = None,
                bump_attempts: bool = False) -> None:
        self._exec(
            f"""UPDATE jobs SET status = ?, error = ?, updated_at = ?
                   {", attempts = attempts + 1" if bump_attempts else ""}
                WHERE run_id = ?""",
            (status, error, time.time(), run_id),
        )

    def get_job(self, run_id: str) -> dict[str, Any] | None:
        row = self._one("SELECT * FROM jobs WHERE run_id = ?", (run_id,))
        if row:
            row["params"] = _unj(row["params"], {})
        return row

    def unfinished_jobs(self) -> list[dict[str, Any]]:
        rows = self._rows("SELECT * FROM jobs WHERE status IN ('queued', 'running') "
                          "ORDER BY created_at")
        for r in rows:
            r["params"] = _unj(r["params"], {})
        return rows

    def list_jobs(self, limit: int = 50) -> list[dict[str, Any]]:
        rows = self._rows("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,))
        for r in rows:
            r["params"] = _unj(r["params"], {})
        return rows

    # resumable uploads ------------------------------------------------------------
    def create_upload(self, client_id: str | None, filename: str | None, size: int,
                      sha256: str | None, params: dict[str, Any], path: str,
                      created_by: str | None) -> dict[str, Any]:
        upload_id = new_id("upl")
        now = time.time()
        self._exec(
            """INSERT INTO uploads (upload_id, client_id, filename, size, received, sha256, params,
                   path, status, created_by, created_at, updated_at)
               VALUES (?,?,?,?,0,?,?,?,'open',?,?,?)""",
            (upload_id, client_id, filename, size, sha256, _j(params), path, created_by, now, now),
        )
        return self.get_upload(upload_id)  # type: ignore[return-value]

    def get_upload(self, upload_id: str) -> dict[str, Any] | None:
        row = self._one("SELECT * FROM uploads WHERE upload_id = ?", (upload_id,))
        if row:
            row["params"] = _unj(row["params"], {})
        return row

    def upload_by_client(self, client_id: str) -> dict[str, Any] | None:
        row = self._one("SELECT * FROM uploads WHERE client_id = ?", (client_id,))
        if row:
            row["params"] = _unj(row["params"], {})
        return row

    def set_upload(self, upload_id: str, **fields: Any) -> bool:
        fields["updated_at"] = time.time()
        return self._update("uploads", "upload_id", upload_id, fields,
                            {"received", "status", "run_id", "updated_at"})

    def stale_uploads(self, before: float) -> list[dict[str, Any]]:
        """Open uploads nobody has added to since `before`: abandoned."""
        return self._rows("SELECT * FROM uploads WHERE status = 'open' AND updated_at < ?", (before,))

    # walks: several videos of one place ----------------------------------------------
    def create_walk(self, location: str | None, name: str | None,
                    actor: str | None) -> dict[str, Any]:
        walk_id = new_id("walk")
        self._exec("INSERT INTO walks (walk_id, location, name, created_by, created_at) "
                   "VALUES (?,?,?,?,?)", (walk_id, location, name, actor, time.time()))
        return self.get_walk(walk_id)  # type: ignore[return-value]

    def get_walk(self, walk_id: str) -> dict[str, Any] | None:
        return self._one("SELECT * FROM walks WHERE walk_id = ?", (walk_id,))

    def list_walks(self, location: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
        if location:
            return self._rows(
                """SELECT w.*, (SELECT COUNT(*) FROM runs r WHERE r.walk_id = w.walk_id) AS runs
                     FROM walks w WHERE location = ? ORDER BY created_at DESC LIMIT ?""",
                (location, limit))
        return self._rows(
            """SELECT w.*, (SELECT COUNT(*) FROM runs r WHERE r.walk_id = w.walk_id) AS runs
                 FROM walks w ORDER BY created_at DESC LIMIT ?""", (limit,))

    def close_walk(self, walk_id: str) -> bool:
        return self._exec("UPDATE walks SET status = 'closed', closed_at = ? WHERE walk_id = ?",
                          (time.time(), walk_id)) > 0

    def walk_runs(self, walk_id: str) -> list[dict[str, Any]]:
        return self._rows("SELECT run_id FROM runs WHERE walk_id = ? ORDER BY started_at",
                          (walk_id,))

    # tasks ---------------------------------------------------------------------------
    def create_task(self, **fields: Any) -> dict[str, Any]:
        task_id = new_id("task")
        now = time.time()
        self._exec(
            """INSERT INTO tasks (task_id, kind, status, location, sku, run_id, reason, expected,
                   counted, variance, value_at_risk, assignee, due_at, created_at, created_by,
                   updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (task_id, fields.get("kind", "recount"), fields.get("status", "open"),
             fields.get("location"), fields.get("sku"), fields.get("run_id"),
             fields.get("reason"), fields.get("expected"), fields.get("counted"),
             fields.get("variance"), fields.get("value_at_risk"), fields.get("assignee"),
             fields.get("due_at"), now, fields.get("created_by"), now),
        )
        return self.get_task(task_id)  # type: ignore[return-value]

    def get_task(self, task_id: str) -> dict[str, Any] | None:
        row = self._one(
            """SELECT t.*, u.display_name AS assignee_name FROM tasks t
                 LEFT JOIN users u ON u.user_id = t.assignee WHERE task_id = ?""", (task_id,))
        if row:
            row["result"] = _unj(row["result"])
        return row

    def list_tasks(self, status: str | None = None, assignee: str | None = None,
                   location: str | None = None, limit: int = 200,
                   for_user: str | None = None) -> list[dict[str, Any]]:
        """`for_user`: what that person can pick up: tasks assigned to them, and
        unassigned ones that are not a recount of their own run."""
        clauses, params = [], []
        if status:
            clauses.append("t.status = ?")
            params.append(status)
        if assignee:
            clauses.append("t.assignee = ?")
            params.append(assignee)
        if for_user:
            clauses.append("(t.assignee = ? OR (t.assignee IS NULL AND NOT EXISTS ("
                           "SELECT 1 FROM runs r WHERE r.run_id = t.run_id AND r.created_by = ?)))")
            params.extend([for_user, for_user])
        if location:
            clauses.append("t.location = ?")
            params.append(location)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = self._rows(
            f"""SELECT t.*, u.display_name AS assignee_name FROM tasks t
                  LEFT JOIN users u ON u.user_id = t.assignee {where}
                 ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'escalated' THEN 1 ELSE 2 END,
                          COALESCE(t.due_at, 9e18), t.created_at DESC LIMIT ?""",
            (*params, limit),
        )
        for r in rows:
            r["result"] = _unj(r["result"])
        return rows

    def open_task_for(self, location: str | None, sku: str) -> dict[str, Any] | None:
        row = self._one(
            """SELECT task_id FROM tasks WHERE status IN ('open', 'escalated')
                 AND sku = ? AND COALESCE(location, '') = COALESCE(?, '')
                 ORDER BY created_at DESC LIMIT 1""",
            (sku, location))
        return self.get_task(row["task_id"]) if row else None

    def update_task(self, task_id: str, **fields: Any) -> bool:
        fields["updated_at"] = time.time()
        return self._update("tasks", "task_id", task_id, fields, _TASK_COLS, json_cols={"result"})

    # adjustments ---------------------------------------------------------------------
    def create_adjustment(self, **fields: Any) -> dict[str, Any]:
        adjustment_id = new_id("adj")
        now = time.time()
        self._exec(
            """INSERT INTO adjustments (adjustment_id, location, sku, system_qty, counted_qty, delta,
                   unit_value, value, run_id, task_id, status, rule, note, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (adjustment_id, fields.get("location"), fields["sku"], fields.get("system_qty"),
             fields["counted_qty"], fields["delta"], fields.get("unit_value", 0.0),
             fields.get("value", 0.0), fields.get("run_id"), fields.get("task_id"),
             fields.get("status", "proposed"), fields.get("rule"), fields.get("note"), now, now),
        )
        return self.get_adjustment(adjustment_id)  # type: ignore[return-value]

    def get_adjustment(self, adjustment_id: str) -> dict[str, Any] | None:
        return self._one(
            """SELECT a.*, u.display_name AS decided_by_name FROM adjustments a
                 LEFT JOIN users u ON u.user_id = a.decided_by WHERE adjustment_id = ?""",
            (adjustment_id,))

    def list_adjustments(self, status: str | None = None, location: str | None = None,
                         since: float | None = None, until: float | None = None,
                         limit: int = 500) -> list[dict[str, Any]]:
        clauses, params = [], []
        if status:
            statuses = status.split(",")
            clauses.append(f"a.status IN ({','.join('?' * len(statuses))})")
            params.extend(statuses)
        if location:
            clauses.append("a.location = ?")
            params.append(location)
        if since is not None:
            clauses.append("a.created_at >= ?")
            params.append(since)
        if until is not None:
            clauses.append("a.created_at < ?")
            params.append(until)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        return self._rows(
            f"""SELECT a.*, u.display_name AS decided_by_name FROM adjustments a
                  LEFT JOIN users u ON u.user_id = a.decided_by {where}
                 ORDER BY ABS(a.value) DESC, a.created_at DESC LIMIT ?""",
            (*params, limit),
        )

    def open_adjustment_for(self, location: str | None, sku: str) -> dict[str, Any] | None:
        return self._one(
            """SELECT * FROM adjustments WHERE status IN ('blocked', 'proposed')
                 AND sku = ? AND COALESCE(location, '') = COALESCE(?, '')
                 ORDER BY created_at DESC LIMIT 1""",
            (sku, location))

    def decided_adjustment_for(self, location: str | None, sku: str,
                               run_id: str) -> dict[str, Any] | None:
        return self._one(
            """SELECT * FROM adjustments WHERE status IN ('approved', 'posted', 'failed', 'rejected')
                 AND sku = ? AND COALESCE(location, '') = COALESCE(?, '') AND run_id = ?
                 LIMIT 1""",
            (sku, location, run_id))

    def update_adjustment(self, adjustment_id: str, **fields: Any) -> bool:
        fields["updated_at"] = time.time()
        return self._update("adjustments", "adjustment_id", adjustment_id, fields, _ADJ_COLS)

    # receipts ------------------------------------------------------------------------
    def create_receipt(self, po_number: str, lines: dict[str, dict[str, Any]],
                       supplier: str | None, dock: str | None, source: str,
                       actor: str | None, note: str | None = None) -> dict[str, Any]:
        receipt_id = new_id("rcpt")
        now = time.time()
        with self._tx() as conn:
            conn.execute(
                """INSERT INTO receipts (receipt_id, po_number, supplier, dock, status, source, note,
                       created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (receipt_id, po_number, supplier, dock, "open", source, note, actor, now, now),
            )
            conn.executemany(
                """INSERT INTO receipt_lines (receipt_id, sku, expected_qty, unit_cost)
                   VALUES (?,?,?,?)""",
                [(receipt_id, sku, int(v["qty"]), float(v.get("unit_cost") or 0))
                 for sku, v in lines.items()],
            )
        return self.get_receipt(receipt_id)  # type: ignore[return-value]

    def get_receipt(self, receipt_id: str) -> dict[str, Any] | None:
        row = self._one("SELECT * FROM receipts WHERE receipt_id = ?", (receipt_id,))
        if row is None:
            return None
        row["lines"] = self._rows(
            "SELECT * FROM receipt_lines WHERE receipt_id = ? ORDER BY sku", (receipt_id,))
        row["runs"] = [r["run_id"] for r in self._rows(
            "SELECT run_id FROM runs WHERE receipt_id = ? ORDER BY started_at", (receipt_id,))]
        return row

    def list_receipts(self, status: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
        where, params = ("WHERE status = ?", [status]) if status else ("", [])
        return self._rows(
            f"""SELECT r.*,
                   (SELECT COALESCE(SUM(expected_qty), 0) FROM receipt_lines l
                     WHERE l.receipt_id = r.receipt_id) AS expected_units,
                   (SELECT SUM(received_qty) FROM receipt_lines l
                     WHERE l.receipt_id = r.receipt_id) AS received_units
                  FROM receipts r {where} ORDER BY created_at DESC LIMIT ?""",
            (*params, limit))

    def update_receipt(self, receipt_id: str, **fields: Any) -> bool:
        fields["updated_at"] = time.time()
        return self._update("receipts", "receipt_id", receipt_id, fields,
                            {"status", "note", "closed_at", "closed_by", "updated_at", "dock",
                             "supplier"})

    def set_received(self, receipt_id: str, received: dict[str, int]) -> None:
        with self._tx() as conn:
            for sku, qty in received.items():
                cur = conn.execute(
                    "UPDATE receipt_lines SET received_qty = ? WHERE receipt_id = ? AND sku = ?",
                    (int(qty), receipt_id, sku))
                if cur.rowcount == 0:
                    # Delivered but never ordered: a line of its own.
                    conn.execute(
                        """INSERT INTO receipt_lines (receipt_id, sku, expected_qty, received_qty)
                           VALUES (?,?,0,?)""", (receipt_id, sku, int(qty)))
            conn.execute(
                "UPDATE receipt_lines SET received_qty = 0 WHERE receipt_id = ? AND received_qty IS NULL",
                (receipt_id,))

    # claims --------------------------------------------------------------------------
    def create_claim(self, **fields: Any) -> dict[str, Any]:
        claim_id = new_id("clm")
        now = time.time()
        self._exec(
            """INSERT INTO claims (claim_id, kind, counterparty, status, receipt_id, run_ids, amount,
                   currency, note, created_by, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (claim_id, fields["kind"], fields.get("counterparty"), "draft",
             fields.get("receipt_id"), _j(fields.get("run_ids") or []),
             float(fields.get("amount") or 0), fields.get("currency") or "USD",
             fields.get("note"), fields.get("created_by"), now, now),
        )
        return self.get_claim(claim_id)  # type: ignore[return-value]

    def get_claim(self, claim_id: str) -> dict[str, Any] | None:
        row = self._one("SELECT * FROM claims WHERE claim_id = ?", (claim_id,))
        if row:
            row["run_ids"] = _unj(row["run_ids"], [])
        return row

    def list_claims(self, status: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
        where, params = ("WHERE status = ?", [status]) if status else ("", [])
        rows = self._rows(f"SELECT * FROM claims {where} ORDER BY created_at DESC LIMIT ?",
                          (*params, limit))
        for r in rows:
            r["run_ids"] = _unj(r["run_ids"], [])
        return rows

    def update_claim(self, claim_id: str, **fields: Any) -> bool:
        fields["updated_at"] = time.time()
        return self._update("claims", "claim_id", claim_id, fields,
                            {"status", "counterparty", "amount", "recovered_amount", "note",
                             "pack_path", "pack_sha256", "updated_at", "currency"})

    # service jobs ----------------------------------------------------------------------
    def create_service_job(self, **fields: Any) -> dict[str, Any]:
        job_id = new_id("svc")
        now = time.time()
        self._exec(
            """INSERT INTO service_jobs (job_id, site_id, title, scheduled_for, crew, locations,
                   status, data_consent, notes, created_by, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (job_id, fields.get("site_id"), fields.get("title"), fields.get("scheduled_for"),
             _j(fields.get("crew") or []), _j(fields.get("locations") or []), "planned",
             int(bool(fields.get("data_consent"))), fields.get("notes"),
             fields.get("created_by"), now, now),
        )
        return self.get_service_job(job_id)  # type: ignore[return-value]

    def get_service_job(self, job_id: str) -> dict[str, Any] | None:
        row = self._one(
            """SELECT j.*, s.name AS site_name, s.customer AS customer FROM service_jobs j
                 LEFT JOIN sites s ON s.site_id = j.site_id WHERE job_id = ?""", (job_id,))
        if row:
            row["crew"] = _unj(row["crew"], [])
            row["locations"] = _unj(row["locations"], [])
            row["runs"] = [r["run_id"] for r in self._rows(
                "SELECT run_id FROM runs WHERE job_id = ? ORDER BY started_at", (job_id,))]
        return row

    def list_service_jobs(self, status: str | None = None,
                          crew_member: str | None = None) -> list[dict[str, Any]]:
        where, params = ("WHERE j.status = ?", [status]) if status else ("", [])
        rows = self._rows(
            f"""SELECT j.*, s.name AS site_name, s.customer AS customer,
                   (SELECT COUNT(*) FROM runs r WHERE r.job_id = j.job_id) AS run_count
                  FROM service_jobs j LEFT JOIN sites s ON s.site_id = j.site_id {where}
                 ORDER BY COALESCE(j.scheduled_for, j.created_at) DESC""", params)
        for r in rows:
            r["crew"] = _unj(r["crew"], [])
            r["locations"] = _unj(r["locations"], [])
        if crew_member:
            rows = [r for r in rows if crew_member in r["crew"]]
        return rows

    def update_service_job(self, job_id: str, **fields: Any) -> bool:
        fields["updated_at"] = time.time()
        return self._update("service_jobs", "job_id", job_id, fields,
                            {"status", "title", "scheduled_for", "crew", "locations",
                             "data_consent", "notes", "completed_at", "updated_at", "site_id"},
                            json_cols={"crew", "locations"})

    def consented_runs(self) -> list[str]:
        return [r["run_id"] for r in self._rows(
            """SELECT r.run_id FROM runs r JOIN service_jobs j ON j.job_id = r.job_id
                WHERE j.data_consent = 1 ORDER BY r.started_at""")]

    # integrations ------------------------------------------------------------------------
    def upsert_integration(self, name: str, kind: str, settings: dict[str, Any],
                           secrets: bytes | None, enabled: bool, actor: str | None) -> None:
        self._exec(
            """INSERT INTO integrations (name, kind, settings, secrets, enabled, updated_at, updated_by)
               VALUES (?,?,?,?,?,?,?)
               ON CONFLICT(name) DO UPDATE SET kind = excluded.kind, settings = excluded.settings,
                   secrets = COALESCE(excluded.secrets, integrations.secrets),
                   enabled = excluded.enabled, updated_at = excluded.updated_at,
                   updated_by = excluded.updated_by""",
            (name, kind, _j(settings), secrets, int(enabled), time.time(), actor),
        )

    def get_integration(self, name: str) -> dict[str, Any] | None:
        row = self._one("SELECT * FROM integrations WHERE name = ?", (name,))
        if row:
            row["settings"] = _unj(row["settings"], {})
        return row

    def list_integrations(self) -> list[dict[str, Any]]:
        rows = self._rows("SELECT * FROM integrations ORDER BY name")
        for r in rows:
            r["settings"] = _unj(r["settings"], {})
            r["has_secrets"] = bool(r.pop("secrets"))
        return rows

    def mark_integration(self, name: str, error: str | None) -> None:
        self._exec("UPDATE integrations SET last_sync_at = ?, last_error = ? WHERE name = ?",
                   (time.time(), error, name))

    def delete_integration(self, name: str) -> bool:
        return self._exec("DELETE FROM integrations WHERE name = ?", (name,)) > 0
