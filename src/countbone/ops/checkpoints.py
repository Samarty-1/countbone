"""Signed checkpoints of the audit trail, kept outside the database.

The audit chain is plain SHA-256, so anyone who can write the database can
edit a row and recompute every hash after it, or delete the newest rows,
and the chain still checks. A checkpoint is the chain's length and head
hash at a moment, signed with the evidence key and appended to a file next
to the keys, not in the database. Verifying the trail against every
checkpoint catches a rewrite or a truncation up to the latest one.

Checkpoints are written at start-up, whenever an evidence pack is built
(the pack's signed manifest carries the same pair, so a counterparty holds
one too), and on demand from Settings. They do not help against someone
who holds the signing key as well; nothing inside one deployment can.
"""

from __future__ import annotations

import json
import time
from typing import Any

from ..security import verify_signature
from . import Services

FILE = "audit_checkpoints.jsonl"


def _canon(obj: Any) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode("utf-8")


def write(services: Services, reason: str) -> dict[str, Any]:
    head = services.store.audit_head()
    body = {"rows": head["rows"], "head": head["head"], "at": time.time(), "reason": reason,
            "key_id": services.keyring.key_id()}
    entry = {**body, "signature": services.keyring.sign(_canon(body))}
    path = services.data_dir / FILE
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, sort_keys=True) + "\n")
    return entry


def load(services: Services) -> tuple[list[dict[str, Any]], list[str]]:
    """(checkpoints whose signature verifies, problems with the rest)."""
    path = services.data_dir / FILE
    if not path.is_file():
        return [], []
    key = services.keyring.public_key_pem()
    good: list[dict[str, Any]] = []
    problems: list[str] = []
    for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
            body = {k: entry[k] for k in ("rows", "head", "at", "reason", "key_id")}
            ok = verify_signature(key, _canon(body), entry["signature"])
        except (ValueError, KeyError, TypeError):
            ok = False
        if ok:
            good.append(body)
        else:
            problems.append(f"checkpoint on line {n} is not signed by this deployment's key")
    return good, problems


def verify(services: Services) -> dict[str, Any]:
    marks, problems = load(services)
    result = services.store.verify_audit_chain(marks)
    if problems:
        result = {**result, "ok": False, "problem": result.get("problem") or problems[0],
                  "checkpoint_problems": problems}
    latest = max(marks, key=lambda m: m["rows"], default=None)
    return {**result, "checkpoints": len(marks), "latest_checkpoint": latest}
