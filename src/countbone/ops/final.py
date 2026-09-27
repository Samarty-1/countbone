"""The final count: the machine's count with every reviewer's decision applied.

This is the number the rest of the product acts on (reconciliation,
receiving, evidence), so it is defined once, here, and the machine's own
count is never overwritten: both stay visible, with the reason they differ.

Decisions and their effect (item reviews are about one tracked object):

  counted object, rejected           not a real item: -1 from its SKU
  counted object, corrected to X     it was an X: -1 from its SKU, +1 to X
  counted object, accepted           no change
  uncounted object (possible miss),
      accepted                       a real item after all: +1 to its SKU
      corrected to X                 a real X: +1 to X
      rejected                       no change
  whole-SKU review with a recount    the recount replaces that SKU's number

Reviews without a track id (runs recorded before item reviews carried one)
cannot be mapped to an object, so they inform but do not change the number.
"""

from __future__ import annotations

import json
from collections import defaultdict
from typing import Any


def _meta(review: dict[str, Any]) -> dict[str, Any]:
    meta = review.get("meta")
    if isinstance(meta, str):
        try:
            return json.loads(meta or "{}")
        except ValueError:
            return {}
    return meta or {}


def final_counts(run: dict[str, Any]) -> dict[str, Any]:
    counts = run.get("counts") or []
    machine = {c["sku"]: int(c["count"]) for c in counts}
    labels = {c["sku"]: c.get("label") or c["sku"] for c in counts}
    expected = {c["sku"]: c.get("expected") for c in counts}
    confidence = {c["sku"]: c.get("confidence") for c in counts}
    final: dict[str, int] = defaultdict(int, machine)
    why: dict[str, list[str]] = defaultdict(list)
    recounts: dict[str, tuple[int, str | None]] = {}
    pending: dict[str, int] = defaultdict(int)
    seen_tracks: set[int] = set()

    for review in run.get("reviews") or []:
        meta = _meta(review)
        status = review.get("status") or "pending"
        sku = review["sku"]
        if status == "pending":
            pending[sku] += 1
            continue
        if meta.get("scope") == "sku":
            if meta.get("resolved_count") is not None:
                recounts[sku] = (int(meta["resolved_count"]), review.get("resolved_by"))
            continue
        track = meta.get("track_id")
        if track is None or track in seen_tracks:
            continue
        seen_tracks.add(track)
        own = meta.get("track_sku") or sku
        target = review.get("resolved_sku")
        counted = bool(meta.get("counted", True))
        who = review.get("resolved_by") or "a reviewer"
        if counted:
            if status == "rejected":
                final[own] -= 1
                why[own].append(f"-1 not an item ({who})")
            elif status == "corrected" and target and target != own:
                final[own] -= 1
                final[target] += 1
                why[own].append(f"-1 moved to {target} ({who})")
                why[target].append(f"+1 moved from {own} ({who})")
        else:
            if status == "accepted":
                final[own] += 1
                why[own].append(f"+1 missed item confirmed ({who})")
            elif status == "corrected" and target:
                final[target] += 1
                why[target].append(f"+1 missed item confirmed as {target} ({who})")

    for sku, (n, who) in recounts.items():
        final[sku] = n
        why[sku].append(f"recounted as {n} ({who or 'a reviewer'})")

    rows = []
    for sku in sorted(set(machine) | set(final)):
        value = max(0, final[sku])
        exp = expected.get(sku)
        if value == 0 and machine.get(sku, 0) == 0 and exp is None:
            continue
        rows.append({
            "sku": sku,
            "label": labels.get(sku, sku),
            "machine": machine.get(sku, 0),
            "final": value,
            "expected": exp,
            "variance": None if exp is None else value - int(exp),
            "confidence": confidence.get(sku),
            "changes": why.get(sku, []),
            "pending_reviews": pending.get(sku, 0),
        })
    open_reviews = sum(pending.values())
    return {
        "rows": rows,
        "total": sum(r["final"] for r in rows),
        "machine_total": sum(machine.values()),
        # Provisional while anything is still waiting for a person.
        "settled": open_reviews == 0,
        "open_reviews": open_reviews,
    }
