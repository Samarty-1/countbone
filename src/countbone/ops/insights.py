"""Insights: turn counts into an operational signal (roadmap phase 3).

Everything here reads what the platform already records (the book, the
runs, adjustments, recount tasks, receipts) and changes nothing except the
audit sample, which creates tasks.

- **What to count next.** An ABC class per SKU by stock value (A: the SKUs
  making up the first 80% of value; B: the next 15%; C: the rest). Each
  class has a count interval (A every 30 days, B 90, C 180). A location is
  due when its most demanding SKU is due. Locations are ranked by how far
  past due they are, weighted up by how often their counts have needed an
  adjustment.
- **Why each discrepancy happened.** Every decided adjustment gets a
  likely cause, with the evidence:
  - *miscount:* the recount agreed with the book;
  - *misplacement:* the same SKU went the other way at another location
    within two weeks;
  - *receiving error:* a delivery of the SKU shortly before was short or
    over by about the same amount;
  - *unexplained loss / gain:* nothing else accounts for it. This is where
    theft, damage and unrecorded sales sit.
- **Shrink** by cause, SKU, location and month. A misplacement nets out,
  so the loss that remains is real.
- **Drift alerts:** a location and SKU whose unexplained losses keep
  coming (three or more in a row), the pattern of steady pilferage.
- **Count accuracy.** Recounts triggered by a mismatch only ever look at
  suspicious counts, so their agreement rate is biased. A *blind audit
  sample* (`sample_audit`) recounts a random share of SKUs that matched the
  book, without showing the recounter either number. Its agreement rate,
  with a 95% interval, is an unbiased measure of how good the counts are.
"""

from __future__ import annotations

import json
import math
import random
import time
from collections import defaultdict
from typing import Any

from ..security import role_at_least
from . import Forbidden, OpsError, Services
from .final import final_counts

DAY = 86400.0
DEFAULTS: dict[str, Any] = {
    "class_cutoffs": {"A": 0.80, "B": 0.95},          # cumulative share of stock value
    "interval_days": {"A": 30, "B": 90, "C": 180},
    "window_days": 180,                               # history the signals look at
    "misplacement_days": 14,
    "receiving_days": 21,
    "drift_run": 3,                                   # unexplained losses in a row
}
DECIDED = ("approved", "posted", "failed")            # the book was (or is being) changed
SAMPLE_REASON = "audit sample: blind recount of a count that matched the book"


def settings(services: Services) -> dict[str, Any]:
    return {**DEFAULTS, **(services.store.get_setting("insights") or {})}


# -- what the store holds ------------------------------------------------------------------
def _unit_values(services: Services) -> dict[str, float]:
    return {s["sku"]: float(s.get("unit_value") or 0.0) for s in services.store.list_skus(include_archived=True)}


def _value(services: Services, values: dict[str, float], sku: str) -> float:
    if sku in values:
        return values[sku]
    try:
        return services.unit_value(sku)
    except Exception:  # noqa: BLE001 - no catalog loaded: value unknown
        return 0.0


def _adjustments(services: Services, since: float) -> list[dict[str, Any]]:
    return services.store._rows(
        "SELECT * FROM adjustments WHERE created_at >= ? ORDER BY created_at", (since,))


def _count_runs(services: Services) -> list[dict[str, Any]]:
    return services.store._rows(
        """SELECT run_id, location, kind, started_at FROM runs
            WHERE location IS NOT NULL AND COALESCE(kind, 'count') IN ('count', 'recount')
            ORDER BY started_at""")


# -- what to count next ----------------------------------------------------------------------
def abc(services: Services) -> dict[str, str]:
    """SKU -> A, B or C by its share of total stock value."""
    cfg = settings(services)
    values = _unit_values(services)
    stock: dict[str, float] = defaultdict(float)
    for row in services.store.expected_rows():
        stock[row["sku"]] += max(0, int(row["qty"])) * _value(services, values, row["sku"])
    total = sum(stock.values())
    out, running = {}, 0.0
    for sku, v in sorted(stock.items(), key=lambda kv: (-kv[1], kv[0])):
        share_before = running / total if total else 1.0
        running += v
        out[sku] = ("A" if share_before < cfg["class_cutoffs"]["A"]
                    else "B" if share_before < cfg["class_cutoffs"]["B"] else "C")
    return out


def schedule(services: Services, now: float | None = None, per_day: int = 10) -> list[dict[str, Any]]:
    """Every location with stock on the book, most urgent first."""
    now = now or time.time()
    cfg = settings(services)
    classes = abc(services)
    values = _unit_values(services)
    by_loc: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in services.store.expected_rows():
        by_loc[row["location"]].append(row)
    last: dict[str, float] = {}
    counts: dict[str, int] = defaultdict(int)
    since = now - cfg["window_days"] * DAY
    for r in _count_runs(services):
        last[r["location"]] = max(last.get(r["location"], 0.0), r["started_at"])
        if r["started_at"] >= since:
            counts[r["location"]] += 1
    adjusted: dict[str, int] = defaultdict(int)
    for a in _adjustments(services, since):
        if a["status"] in DECIDED and a["delta"]:
            adjusted[a["location"]] += 1
    out = []
    for loc, rows in by_loc.items():
        mine = {r["sku"]: classes.get(r["sku"], "C") for r in rows if int(r["qty"]) > 0}
        if not mine:
            continue
        interval = min(cfg["interval_days"][c] for c in mine.values())
        stock_value = sum(int(r["qty"]) * _value(services, values, r["sku"]) for r in rows)
        # how often a count here changes the book, smoothed so one count isn't the whole story
        volatility = (adjusted[loc] + 1) / (max(counts[loc], adjusted[loc]) + 2)
        if loc in last:
            age = (now - last[loc]) / DAY
            ratio = age / interval
        else:
            age, ratio = None, math.inf
        score = ratio * (1 + volatility) if ratio != math.inf else math.inf
        a_skus = sum(1 for c in mine.values() if c == "A")
        why = ("never counted" if age is None else
               f"{age - interval:.0f} days overdue" if age > interval else f"due in {interval - age:.0f} days")
        history = (f"{adjusted[loc]} of its last {counts[loc]} count(s) changed the book" if counts[loc]
                   else "no counts in the window")
        out.append({
            "location": loc, "classes": "".join(sorted(set(mine.values()))), "a_skus": a_skus,
            "stock_value": round(stock_value, 2), "interval_days": interval,
            "last_counted": last.get(loc), "days_since": None if age is None else round(age, 1),
            "due": ratio >= 1, "volatility": round(volatility, 2), "score": score,
            "why": f"{why}; {a_skus} A-class SKU(s), stock value {stock_value:,.2f}; {history}",
        })
    out.sort(key=lambda x: (-x["score"] if x["score"] != math.inf else -1e18, -x["stock_value"], x["location"]))
    for k, x in enumerate(out):
        x["suggested_day"] = k // per_day + 1 if x["due"] or x["score"] >= 0.8 else None
        x["score"] = None if x["score"] == math.inf else round(x["score"], 3)
    return out


# -- why each discrepancy happened -------------------------------------------------------------
def _receipt_lines(services: Services, since: float) -> list[dict[str, Any]]:
    return services.store._rows(
        """SELECT r.receipt_id, r.po_number, r.supplier, COALESCE(r.closed_at, r.updated_at) AS at,
                  l.sku, l.expected_qty, l.received_qty
             FROM receipts r JOIN receipt_lines l ON l.receipt_id = r.receipt_id
            WHERE l.received_qty IS NOT NULL AND COALESCE(r.closed_at, r.updated_at) >= ?""", (since,))


def causes(services: Services, now: float | None = None) -> list[dict[str, Any]]:
    """Each adjustment in the window that was decided or settled by a
    recount, with its likely cause and the evidence for it."""
    now = now or time.time()
    cfg = settings(services)
    since = now - cfg["window_days"] * DAY
    store = services.store
    adjs = [a for a in _adjustments(services, since) if a["status"] in DECIDED + ("superseded",)]
    out: dict[str, dict[str, Any]] = {}

    # miscount: the recount agreed with the book
    for a in adjs:
        if a["status"] != "superseded" or not a.get("task_id"):
            continue
        task = store.get_task(a["task_id"])
        res = (task or {}).get("result") or {}
        if task and task["status"] == "done" and res.get("recount") is not None \
                and int(res["recount"]) == (task.get("expected") if task.get("expected") is not None else a["system_qty"]):
            first = task.get("counted")
            out[a["adjustment_id"]] = {"cause": "miscount", "evidence":
                                       f"first count {first}, recount {res['recount']} by {res.get('by')} matched the book"}
    decided = [a for a in adjs if a["status"] in DECIDED and a["delta"]]

    # receiving error: a delivery of the SKU shortly before, off by about this
    # much. Checked before misplacement: a delivery shortfall of the same size
    # is more specific evidence than any opposite movement nearby.
    lines = _receipt_lines(services, since - cfg["receiving_days"] * DAY)
    used_lines: set[tuple[str, str]] = set()
    for a in decided:
        for ln in sorted(lines, key=lambda x: -x["at"]):
            if ln["sku"] != a["sku"] or (ln["receipt_id"], ln["sku"]) in used_lines:
                continue
            if not 0 <= a["created_at"] - ln["at"] <= cfg["receiving_days"] * DAY:
                continue
            diff = int(ln["received_qty"]) - int(ln["expected_qty"])
            if diff and diff * a["delta"] > 0 and abs(diff - a["delta"]) <= max(1, 0.2 * abs(a["delta"])):
                used_lines.add((ln["receipt_id"], ln["sku"]))
                out[a["adjustment_id"]] = {"cause": "receiving error", "evidence":
                                           f"PO {ln['po_number']}: received {ln['received_qty']} of "
                                           f"{ln['expected_qty']} {_ago(a['created_at'], ln['at'])}"}
                break

    # misplacement: opposite movements of one SKU at two locations, close in time
    pairs = []
    open_ = [a for a in decided if a["adjustment_id"] not in out]
    for i, a in enumerate(open_):
        for b in open_[i + 1:]:
            if a["sku"] != b["sku"] or a["location"] == b["location"] or a["delta"] * b["delta"] >= 0:
                continue
            if abs(a["created_at"] - b["created_at"]) > cfg["misplacement_days"] * DAY:
                continue
            small, big = sorted((abs(a["delta"]), abs(b["delta"])))
            if small / big >= 0.5:
                pairs.append((abs(abs(a["delta"]) - abs(b["delta"])), abs(a["created_at"] - b["created_at"]), a, b))
    used: set[str] = set()
    for _, _, a, b in sorted(pairs, key=lambda p: (p[0], p[1])):
        if a["adjustment_id"] in used or b["adjustment_id"] in used:
            continue
        used |= {a["adjustment_id"], b["adjustment_id"]}
        for x, y in ((a, b), (b, a)):
            out[x["adjustment_id"]] = {"cause": "misplacement", "evidence":
                                       f"{y['delta']:+d} of {x['sku']} at {y['location']} "
                                       f"{_ago(x['created_at'], y['created_at'])}", "pair": y["adjustment_id"]}

    rows = []
    for a in adjs:
        c = out.get(a["adjustment_id"])
        if c is None:
            if a["status"] not in DECIDED or not a["delta"]:
                continue
            c = {"cause": "unexplained loss" if a["delta"] < 0 else "unexplained gain",
                 "evidence": "no recount, transfer or delivery explains it"}
        rows.append({"adjustment_id": a["adjustment_id"], "location": a["location"], "sku": a["sku"],
                     "delta": a["delta"], "value": round(float(a["value"] or 0.0), 2),
                     "status": a["status"], "created_at": a["created_at"], **c})
    return rows


def _ago(t: float, ref: float) -> str:
    days = (t - ref) / DAY
    return "the same day" if abs(days) < 1 else f"{abs(days):.0f} days {'earlier' if days > 0 else 'later'}"


# -- shrink and drift ------------------------------------------------------------------------
def shrink(services: Services, now: float | None = None, rows: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Value lost and found, by cause, SKU, location and month."""
    rows = rows if rows is not None else causes(services, now)
    booked = [r for r in rows if r["status"] in DECIDED]
    by: dict[str, dict[str, float]] = {"cause": defaultdict(float), "sku": defaultdict(float),
                                       "location": defaultdict(float), "month": defaultdict(float)}
    for r in booked:
        by["cause"][r["cause"]] += r["value"]
        by["sku"][r["sku"]] += r["value"]
        by["location"][r["location"] or "-"] += r["value"]
        by["month"][time.strftime("%Y-%m", time.gmtime(r["created_at"]))] += r["value"]
    loss = sum(r["value"] for r in booked if r["value"] < 0)
    gain = sum(r["value"] for r in booked if r["value"] > 0)
    unexplained = by["cause"].get("unexplained loss", 0.0)

    def top(d: dict[str, float], n: int = 10) -> list[dict[str, Any]]:
        return [{"key": k, "value": round(v, 2)} for k, v in sorted(d.items(), key=lambda kv: kv[1])[:n] if v < 0]
    return {"loss": round(loss, 2), "gain": round(gain, 2), "net": round(loss + gain, 2),
            "unexplained_loss": round(unexplained, 2),
            "by_cause": {k: round(v, 2) for k, v in sorted(by["cause"].items())},
            "by_month": {k: round(v, 2) for k, v in sorted(by["month"].items())},
            "worst_skus": top(by["sku"]), "worst_locations": top(by["location"]),
            "miscounts_caught": sum(1 for r in rows if r["cause"] == "miscount")}


def drift(services: Services, now: float | None = None, rows: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    """Location and SKU pairs whose latest decided adjustments are a run of
    unexplained losses: the signature of steady pilferage."""
    cfg = settings(services)
    rows = rows if rows is not None else causes(services, now)
    seq: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for r in rows:
        if r["status"] in DECIDED:
            seq[(r["location"], r["sku"])].append(r)
    alerts = []
    for (loc, sku), rs in seq.items():
        rs.sort(key=lambda r: r["created_at"])
        run: list[dict[str, Any]] = []
        for r in reversed(rs):
            if r["cause"] != "unexplained loss":
                break
            run.append(r)
        if len(run) >= cfg["drift_run"]:
            lost = sum(r["value"] for r in run)
            alerts.append({"location": loc, "sku": sku, "losses_in_a_row": len(run),
                           "units": sum(r["delta"] for r in run), "value": round(lost, 2),
                           "since": run[-1]["created_at"],
                           "why": f"{len(run)} counts in a row found {sku} short at {loc} with nothing to explain it"})
    return sorted(alerts, key=lambda a: a["value"])


# -- count accuracy and the blind audit sample ----------------------------------------------------
def sample_audit(services: Services, run_id: str, actor: dict[str, Any], fraction: float = 0.05,
                 minimum: int = 1, seed: int | None = None) -> list[dict[str, Any]]:
    """Blind recount tasks for a random share of the SKUs a run counted
    that matched the book. The task shows neither the first count nor the
    book; both are kept in the audit trail to score the recount."""
    store = services.store
    if not role_at_least(actor["role"], "manager"):
        raise Forbidden("audit samples are set by a manager")
    if not 0 < fraction <= 1:
        raise OpsError("fraction must be between 0 and 1")
    run = store.get_run(run_id)
    if run is None:
        raise OpsError("no such run")
    if not run.get("location"):
        raise OpsError("the run has no location, so there is nothing to recount at")
    book = store.expected_for(run["location"])
    fc = final_counts(run)
    matched = sorted(r["sku"] for r in fc["rows"] if r["sku"] in book and r["final"] == book[r["sku"]])
    if not matched:
        raise OpsError("no SKU in this count matched the book; mismatches already get recount tasks")
    k = min(len(matched), max(minimum, round(len(matched) * fraction)))
    picked = random.Random(seed).sample(matched, k)
    out = []
    finals = {r["sku"]: r["final"] for r in fc["rows"]}
    for sku in picked:
        task = store.create_task(kind="audit", status="open", location=run["location"], sku=sku, run_id=run_id,
                                 reason=SAMPLE_REASON, created_by=actor["user_id"])
        store.add_audit(task["task_id"], "audit_sample_created",
                        {"sku": sku, "location": run["location"], "first_count": finals[sku], "book": book[sku],
                         "run_id": run_id, "fraction": fraction}, actor=actor["username"])
        out.append(task)
    return out


def _wilson(hits: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if not n:
        return (0.0, 0.0)
    p = hits / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    m = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (round((c - m) / d, 4), round((c + m) / d, 4))


def accuracy(services: Services, now: float | None = None) -> dict[str, Any]:
    """How often a first count is right: from the blind audit sample
    (unbiased), and from mismatch recounts (how many flagged mismatches
    were the count's fault rather than the book's)."""
    now = now or time.time()
    since = now - settings(services)["window_days"] * DAY
    store = services.store
    firsts = {r["run_id"]: r for r in store._rows(
        "SELECT run_id, payload FROM audit WHERE kind = 'audit_sample_created' AND created_at >= ?", (since,))}
    sample = []
    for task_id, row in firsts.items():
        task = store.get_task(task_id)
        recount = ((task or {}).get("result") or {}).get("recount")
        if not task or task["status"] != "done" or recount is None:
            continue
        payload = json.loads(row["payload"]) if isinstance(row["payload"], str) else row["payload"]
        recount = int(recount)
        sample.append({"task_id": task_id, "sku": task["sku"], "location": task["location"],
                       "first_count": payload["first_count"], "book": payload["book"], "recount": recount})
    hits = sum(1 for s in sample if s["recount"] == s["first_count"])
    triggered = store._rows(
        "SELECT * FROM tasks WHERE kind = 'recount' AND status = 'done' AND created_at >= ?", (since,))
    miscounts = 0
    for t in triggered:
        res = json.loads(t["result"]) if isinstance(t["result"], str) else (t["result"] or {})
        if res.get("recount") is not None and t.get("expected") is not None and int(res["recount"]) == t["expected"]:
            miscounts += 1
    open_samples = store._rows("SELECT COUNT(*) AS n FROM tasks WHERE kind = 'audit' AND status IN ('open', 'escalated')")
    return {
        "sample": {"recounted": len(sample), "agreed": hits,
                   "agreement": round(hits / len(sample), 4) if sample else None,
                   "interval_95": _wilson(hits, len(sample)) if sample else None,
                   "mean_abs_error": round(sum(abs(s["recount"] - s["first_count"]) for s in sample) / len(sample), 3)
                   if sample else None,
                   "open": open_samples[0]["n"],
                   "disagreements": [s for s in sample if s["recount"] != s["first_count"]]},
        "mismatch_recounts": {"done": len(triggered), "count_was_wrong": miscounts,
                              "book_was_wrong": len(triggered) - miscounts},
    }


def overview(services: Services, now: float | None = None, per_day: int = 10) -> dict[str, Any]:
    """Everything the Insights page shows, from one pass over the history."""
    now = now or time.time()
    rows = causes(services, now)
    sched = schedule(services, now, per_day)
    return {"generated_at": now, "settings": settings(services),
            "schedule": sched, "due": sum(1 for s in sched if s["due"]),
            "causes": rows, "shrink": shrink(services, now, rows), "drift": drift(services, now, rows),
            "accuracy": accuracy(services, now)}
