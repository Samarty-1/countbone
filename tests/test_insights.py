"""Insights: what to count next, why each discrepancy happened, shrink,
drift and count accuracy, scored on synthetic history with known causes."""

from __future__ import annotations

import time

import pytest

from countbone import insights_demo
from countbone.ops import Services, insights
from countbone.store.db import Store

DAY = 86400.0


def services(store, tmp_path):
    return Services(store=store, keyring=None, data_dir=tmp_path, output_dir=tmp_path, catalog=lambda: None)


@pytest.fixture
def history(tmp_path):
    store = Store(tmp_path / "i.db")
    truth = insights_demo.build(store, seed=4)
    yield services(store, tmp_path), truth
    store.close()


@pytest.mark.parametrize("seed", [4, 11, 23])
def test_planted_causes_drift_and_schedule_are_found(tmp_path, seed):
    store = Store(tmp_path / f"s{seed}.db")
    truth = insights_demo.build(store, seed=seed)
    ov = insights.overview(services(store, tmp_path), truth["now"])
    sc = insights_demo.score(ov, truth)
    assert sc["causes_right"] == sc["causes_planted"], sc["wrong"]
    assert sc["drift_found"] and sc["drift_false_alarms"] == 0
    assert sc["overdue_first"], sc["schedule_top3"]
    store.close()


def test_misplacements_net_out_and_shrink_adds_up(history):
    svc, truth = history
    ov = insights.overview(svc, truth["now"])
    sh = ov["shrink"]
    assert sh["by_cause"]["misplacement"] == 0
    assert sh["net"] == pytest.approx(sum(sh["by_cause"].values()), abs=0.01)
    assert sh["loss"] + sh["gain"] == pytest.approx(sh["net"], abs=0.01)
    assert sh["worst_locations"][0]["key"] == "B-02"                 # the drifting bay
    assert sh["miscounts_caught"] == 5


def _two(store, gap_days, delta_b=3, sku="X"):
    now = time.time()
    store.upsert_sku(sku, {"unit_value": 10.0}, actor=None)
    ids = []
    for loc, d, t in (("L1", -3, now - 30 * DAY), ("L2", delta_b, now - (30 - gap_days) * DAY)):
        a = store.create_adjustment(location=loc, sku=sku, system_qty=10, counted_qty=10 + d, delta=d,
                                    unit_value=10.0, value=d * 10.0, status="approved")
        store._exec("UPDATE adjustments SET created_at = ? WHERE adjustment_id = ?", (t, a["adjustment_id"]))
        ids.append(a["adjustment_id"])
    return now, ids


@pytest.mark.parametrize("gap, delta_b, want", [(13, 3, "misplacement"), (15, 3, "unexplained loss"),
                                                (2, 1, "unexplained loss"), (2, 2, "misplacement")])
def test_misplacement_needs_close_dates_and_similar_sizes(tmp_path, gap, delta_b, want):
    store = Store(tmp_path / "m.db")
    now, ids = _two(store, gap, delta_b)
    got = {r["adjustment_id"]: r["cause"] for r in insights.causes(services(store, tmp_path), now)}
    assert got[ids[0]] == want
    store.close()


def test_abc_classes_follow_value_share(tmp_path):
    store = Store(tmp_path / "a.db")
    for sku, v in (("BIG", 100.0), ("MID", 10.0), ("LOW", 1.0)):
        store.upsert_sku(sku, {"unit_value": v}, actor=None)
    store.set_expected("L1", {"BIG": 8, "MID": 15, "LOW": 40}, "test", None)   # 800, 150, 40 of 990
    assert insights.abc(services(store, tmp_path)) == {"BIG": "A", "MID": "B", "LOW": "C"}
    store.close()


def test_a_location_is_due_by_its_most_demanding_sku(tmp_path):
    store = Store(tmp_path / "d.db")
    svc = services(store, tmp_path)
    for sku, v in (("BIG", 100.0), ("LOW", 1.0)):
        store.upsert_sku(sku, {"unit_value": v}, actor=None)
    store.set_expected("HOT", {"BIG": 10}, "test", None)
    store.set_expected("COLD", {"LOW": 10}, "test", None)
    now = time.time()
    for loc in ("HOT", "COLD"):
        store._exec("INSERT INTO runs (run_id, source, started_at, location, kind) VALUES (?,?,?,?,?)",
                    (f"r-{loc}", "x", now - 45 * DAY, loc, "count"))
    sched = {s["location"]: s for s in insights.schedule(svc, now)}
    assert sched["HOT"]["due"] and sched["HOT"]["interval_days"] == 30       # A: every 30 days, 45 since
    assert not sched["COLD"]["due"] and sched["COLD"]["interval_days"] == 180
    assert insights.schedule(svc, now)[0]["location"] == "HOT"
    store.close()


def test_wilson_interval():
    assert insights._wilson(18, 20) == (0.699, 0.9721)
    assert insights._wilson(0, 0) == (0.0, 0.0)
    lo, hi = insights._wilson(50, 50)
    assert hi == 1.0 and lo > 0.9
