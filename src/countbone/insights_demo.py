"""Six months of synthetic stock-count history, with known causes planted.

Builds a store with a catalog, twelve bays and their book stock, counts
over 180 days, and the adjustments, recounts and deliveries those counts
led to. Some discrepancies are planted with a known cause, so the Insights
demo can score itself:

- 5 **miscounts:** the recount matched the book;
- 3 **misplacements:** the same SKU short in one bay and over in another,
  days apart;
- 3 **receiving errors:** a delivery came in short, and the shelf count
  found the same shortfall a few days later;
- 1 **drift:** a high-value SKU found short at the same bay four counts in
  a row, with nothing to explain it;
- 6 one-off **unexplained** losses and gains, including two decoys: a loss
  and a gain of the same SKU 40 days apart (too far apart to be a
  misplacement), and a loss and a gain of different SKUs on the same day.

Plus a blind audit sample of 20 recounts, 18 of which agreed with the
first count. It also sets up the schedule: two bays have never been
counted, and one bay holding A-class stock was last counted 120 days ago.
Everything is fictional.
"""

from __future__ import annotations

import random
import time
from typing import Any

from .store.db import Store

DAY = 86400.0
BAYS = [f"{z}-{n:02d}" for z in "ABC" for n in range(1, 5)]


def build(store: Store, seed: int = 4, now: float | None = None) -> dict[str, Any]:
    now = now or time.time()
    rng = random.Random(seed)
    skus = []
    for i in range(1, 41):
        value = round(min(600.0, rng.lognormvariate(2.8, 1.1)), 2)
        sku = f"SKU-{i:03d}"
        store.upsert_sku(sku, {"label": f"Product {i}", "unit_value": value}, actor=None)
        skus.append(sku)
    values = {s: store.get_sku(s)["unit_value"] for s in skus}
    top = max(skus, key=lambda s: values[s])
    stock: dict[str, dict[str, int]] = {}
    for bay in BAYS:
        store.upsert_location(bay, name=f"Bay {bay}", zone=bay[0])
        mine = rng.sample([s for s in skus if s != top], 5)
        if bay in ("B-02", "B-03"):
            mine.append(top)                    # the high-value SKU lives in B-02 and B-03
        stock[bay] = {s: rng.randint(6, 40) for s in mine}
        store.set_expected(bay, stock[bay], source="demo", actor=None)

    # counts: every bay every 20-40 days, except the never-counted and the neglected
    runs: dict[str, list[float]] = {}
    for bay in BAYS:
        if bay in ("C-03", "C-04"):
            continue
        t = now - rng.uniform(160, 178) * DAY
        last = now - (120 * DAY if bay == "B-03" else rng.uniform(2, 25) * DAY)
        times = []
        while t < last - 15 * DAY:
            times.append(t)
            t += rng.uniform(20, 40) * DAY
        times.append(last)
        runs[bay] = times
        for j, ts in enumerate(times):
            store._exec("INSERT INTO runs (run_id, source, started_at, finished_at, location, kind, created_by) "
                        "VALUES (?,?,?,?,?,?,?)", (f"run-{bay}-{j}", "demo.webm", ts, ts + 300, bay, "count", "carl"))

    truth: dict[str, str] = {}

    def adj(bay: str, sku: str, delta: int, t: float, status: str = "approved", **extra: Any) -> str:
        book = stock[bay].get(sku, 0)
        a = store.create_adjustment(location=bay, sku=sku, system_qty=book, counted_qty=book + delta, delta=delta,
                                    unit_value=values[sku], value=round(delta * values[sku], 2),
                                    run_id=extra.get("run_id"), status=status, rule="manager")
        store._exec("UPDATE adjustments SET created_at = ?, updated_at = ?, decided_at = ?, task_id = ?, note = ? "
                    "WHERE adjustment_id = ?", (t, t, t, extra.get("task_id"), extra.get("note"), a["adjustment_id"]))
        return a["adjustment_id"]

    def when(bay: str, k: int) -> float:
        return runs[bay][min(k, len(runs[bay]) - 1)] + 600

    # 1. miscounts: the recount agreed with the book, so the adjustment was superseded
    for bay, k in (("A-01", 1), ("A-02", 2), ("A-03", 1), ("B-01", 3), ("C-01", 2)):
        sku = sorted(stock[bay])[0]
        book = stock[bay][sku]
        task = store.create_task(kind="recount", status="done", location=bay, sku=sku, expected=book,
                                 counted=book - 3, variance=-3, reason="demo", created_by="system")
        store.update_task(task["task_id"], result={"recount": book, "by": "maria", "method": "manual"})
        store._exec("UPDATE tasks SET created_at = ?, closed_at = ? WHERE task_id = ?",
                    (when(bay, k), when(bay, k) + DAY, task["task_id"]))
        a = adj(bay, sku, 0, when(bay, k), status="superseded", task_id=task["task_id"],
                note="the recount agrees with the book")
        truth[a] = "miscount"

    # Each planted discrepancy gets a SKU of its own, so two of them can't
    # happen to look like one misplacement (except the decoy pair on purpose).
    taken = {top}

    def pick(bay: str) -> str:
        sku = next(s for s in sorted(stock[bay]) if s not in taken and stock[bay][s] >= 6)
        taken.add(sku)
        return sku

    # 2. misplacements: short in one bay, over in a neighbour, days apart
    for src, dst, gap in (("A-02", "A-03", 2), ("B-01", "B-04", 0), ("C-01", "C-02", 4)):
        sku = pick(src)
        qty = min(stock[src][sku], rng.randint(3, 6))
        t = when(src, 3)
        truth[adj(src, sku, -qty, t)] = "misplacement"
        truth[adj(dst, sku, qty, t + gap * DAY)] = "misplacement"

    # 3. receiving errors: a short delivery, then the shelf count finds the same gap
    for n, (bay, k, short) in enumerate((("A-04", 2, 4), ("B-04", 3, 6), ("C-02", 1, 2))):
        sku = pick(bay)
        t = when(bay, k)
        r = store.create_receipt(f"PO-DEMO-{n + 1}", {sku: {"qty": 24, "unit_cost": values[sku]}}, "Demo Supplier",
                                 "D1", "manual", None)
        store.set_received(r["receipt_id"], {sku: 24 - short})
        store._exec("UPDATE receipts SET status = 'closed', closed_at = ?, created_at = ? WHERE receipt_id = ?",
                    (t - 5 * DAY, t - 6 * DAY, r["receipt_id"]))
        truth[adj(bay, sku, -short, t)] = "receiving error"

    # 4. drift: the high-value SKU short at B-02 four counts in a row
    drift_ids = []
    for k in range(len(runs["B-02"]) - 4, len(runs["B-02"])):
        a = adj("B-02", top, -rng.randint(2, 3), when("B-02", k))
        truth[a] = "unexplained loss"
        drift_ids.append(a)

    # 5. one-off unexplained differences, with decoys
    sku_a1 = pick("A-01")
    truth[adj("A-01", sku_a1, -2, when("A-01", 0))] = "unexplained loss"
    truth[adj("C-02", sku_a1, 2, when("A-01", 0) + 40 * DAY)] = "unexplained gain"           # 40 days later: not a move
    t = when("B-01", 1)
    truth[adj("B-01", pick("B-01"), -3, t)] = "unexplained loss"
    truth[adj("A-04", pick("A-04"), 3, t)] = "unexplained gain"                              # a different SKU
    truth[adj("C-01", pick("C-01"), -1, when("C-01", 1))] = "unexplained loss"
    truth[adj("A-03", pick("A-03"), -5, when("A-03", 2))] = "unexplained loss"

    # 6. a blind audit sample: 20 recounts of counts that matched the book, 18 agree
    for n in range(20):
        bay = BAYS[n % 10]
        sku = sorted(stock[bay])[n % 5]
        first = stock[bay][sku]
        task = store.create_task(kind="audit", status="done", location=bay, sku=sku, reason="audit sample",
                                 created_by="maria")
        store.update_task(task["task_id"], result={"recount": first + (1 if n in (6, 13) else 0), "by": "dina"})
        store.add_audit(task["task_id"], "audit_sample_created",
                        {"sku": sku, "location": bay, "first_count": first, "book": first}, actor="maria")
    return {"now": now, "causes": truth, "drift": [("B-02", top)], "drift_adjustments": drift_ids,
            "never_counted": ["C-03", "C-04"], "neglected": "B-03", "top_sku": top, "sample": (18, 20)}


def score(overview: dict[str, Any], truth: dict[str, Any]) -> dict[str, Any]:
    got = {r["adjustment_id"]: r["cause"] for r in overview["causes"]}
    planted = truth["causes"]
    right = sum(1 for a, c in planted.items() if got.get(a) == c)
    wrong = {a: (c, got.get(a)) for a, c in planted.items() if got.get(a) != c}
    alerts = {(a["location"], a["sku"]) for a in overview["drift"]}
    first = [s["location"] for s in overview["schedule"][:3]]
    return {"causes_right": right, "causes_planted": len(planted), "wrong": wrong,
            "drift_found": set(truth["drift"]) <= alerts, "drift_false_alarms": len(alerts - set(truth["drift"])),
            "schedule_top3": first,
            "overdue_first": set(truth["never_counted"]) | {truth["neglected"]} == set(first)}
