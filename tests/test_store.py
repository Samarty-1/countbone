"""Count history, the review queue, and the audit trail."""

from __future__ import annotations

import pytest

from countbone.store.db import Store
from countbone.types import CountResult, ReviewItem, SkuCount


@pytest.fixture
def store(tmp_path) -> Store:
    s = Store(tmp_path / "test.db")
    yield s
    s.close()


def make_result(run_id: str = "run_1", count: int = 12, started_at: float = 1000.0):
    return CountResult(
        run_id=run_id,
        source="shelf.mp4",
        started_at=started_at,
        finished_at=started_at + 2,
        frames_read=20,
        frames_used=18,
        counts=[SkuCount("SKU-A", count, label="A", confidence=0.8, expected=10)],
        overall_confidence=0.8,
        needs_review=True,
        reviews=[
            ReviewItem(
                review_id="rev_1",
                run_id=run_id,
                sku="SKU-A",
                reason="low_item_confidence",
                confidence=0.33,
                frame_index=4,
                bbox=(1.0, 2.0, 3.0, 4.0),
                crop_path="crops/a.jpg",
            )
        ],
    )


def test_round_trip(store):
    store.save_run(make_result(), config_fingerprint="abc123")
    run = store.get_run("run_1")

    assert run["total"] == 12
    assert run["config_fingerprint"] == "abc123"
    assert run["counts"][0]["sku"] == "SKU-A"
    assert run["counts"][0]["variance"] == 2
    assert run["reviews"][0]["review_id"] == "rev_1"


def test_unknown_run_is_none(store):
    assert store.get_run("nope") is None


def test_saving_twice_does_not_duplicate_counts(store):
    result = make_result()
    store.save_run(result)
    store.save_run(result)
    assert len(store.get_run("run_1")["counts"]) == 1


def test_pending_reviews_are_listed_least_confident_first(store):
    result = make_result()
    result.reviews.append(
        ReviewItem("rev_2", "run_1", "SKU-B", "unidentified", 0.11, 2)
    )
    store.save_run(result)
    pending = store.reviews(status="pending")
    assert [r["review_id"] for r in pending] == ["rev_2", "rev_1"]


def test_resolving_a_review_records_who_and_what(store):
    store.save_run(make_result())
    assert store.resolve_review("rev_1", "corrected", "SKU-B", "leigh")

    resolved = store.reviews(status="corrected")[0]
    assert resolved["resolved_sku"] == "SKU-B"
    assert resolved["resolved_by"] == "leigh"
    assert resolved["resolved_at"] > 0
    assert store.reviews(status="pending") == []


def test_resolving_an_unknown_review_returns_false(store):
    assert store.resolve_review("nope", "accepted", None, "leigh") is False


def test_invalid_review_status_is_rejected(store):
    with pytest.raises(ValueError, match="invalid review status"):
        store.resolve_review("rev_1", "maybe", None, "leigh")


def test_sku_history_is_newest_first(store):
    store.save_run(make_result("run_1", count=10, started_at=1000.0))
    store.save_run(make_result("run_2", count=9, started_at=2000.0))
    store.save_run(make_result("run_3", count=7, started_at=3000.0))

    history = store.sku_history("SKU-A")
    assert [h["count"] for h in history] == [7, 9, 10]  # the drift a shrinkage plugin reads


def test_runs_are_listed_newest_first(store):
    store.save_run(make_result("run_1", started_at=1000.0))
    store.save_run(make_result("run_2", started_at=2000.0))
    assert [r["run_id"] for r in store.list_runs()] == ["run_2", "run_1"]


def test_audit_entries_are_kept_in_order(store):
    store.save_run(make_result())
    store.add_audit("run_1", "audit_pack", {"manifest_sha256": "deadbeef"})
    store.add_audit("run_1", "exception_report", {"variances": []})

    trail = store.audit_trail("run_1")
    assert [a["kind"] for a in trail] == ["audit_pack", "exception_report"]
    assert trail[0]["payload"]["manifest_sha256"] == "deadbeef"


def test_review_items_come_back_as_objects(store):
    store.save_run(make_result())
    items = store.review_items("run_1")
    assert items[0].bbox == (1.0, 2.0, 3.0, 4.0)
    assert items[0].crop_path == "crops/a.jpg"
