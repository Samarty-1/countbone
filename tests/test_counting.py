"""Counting is where the product is won or lost: one object, one count."""

from __future__ import annotations

import pytest

from countbone.catalog import Catalog, SkuEntry
from countbone.config import CountConfig
from countbone.stages.count import Tracker, count_from_tracks, count_per_frame, finalise
from countbone.types import CountResult, Detection, Item

CATALOG = Catalog([SkuEntry("A", "Thing A"), SkuEntry("B", "Thing B")])


def item(x: float, sku: str = "A", y: float = 0.0, score: float = 0.9, frame: int = 0) -> Item:
    det = Detection(bbox=(x, y, x + 40, y + 60), score=score, frame_index=frame)
    return Item(detection=det, sku=sku, id_confidence=0.9)


def test_a_still_object_stays_one_track():
    tracker = Tracker()
    for f in range(5):
        tracker.update(f, [item(100, frame=f)])
    assert len(tracker.tracks) == 1
    assert tracker.tracks[0].hits == 5


def test_two_objects_stay_two_tracks():
    tracker = Tracker()
    for f in range(4):
        tracker.update(f, [item(100, frame=f), item(300, frame=f)])
    assert len(tracker.tracks) == 2


def test_a_pan_without_motion_compensation_fragments_tracks():
    """The failure this system exists to avoid: one carton counted many times."""
    tracker = Tracker()
    for f in range(5):
        tracker.update(f, [item(100 - 45 * f, frame=f)])  # slides out of overlap
    assert len(tracker.tracks) > 1


def test_a_dropped_frame_still_moves_the_camera():
    """Regression: motion during a frame the quality gate dropped was lost, so
    every track lagged a frame of pan and split in two (a double count)."""
    tracker = Tracker()
    motion = {"dx": -30.0, "dy": 0.0, "response": 0.9, "estimated": True}
    x = 200.0
    for f in range(6):
        if f:
            x -= 30
        if f == 3:  # dropped by the quality gate: no items, but the camera moved
            tracker.observe_motion(motion)
            continue
        tracker.update(f, [item(x, frame=f)], motion if f else None)
    assert len(tracker.tracks) == 1
    assert tracker.tracks[0].hits == 5


def test_motion_compensation_keeps_a_panning_object_as_one_track():
    tracker = Tracker()
    motion = {"dx": -45.0, "dy": 0.0, "response": 0.9, "estimated": True}
    for f in range(5):
        tracker.update(f, [item(100 - 45 * f, frame=f)], motion if f else None)
    assert len(tracker.tracks) == 1
    assert tracker.tracks[0].hits == 5


def test_a_track_survives_a_short_disappearance():
    tracker = Tracker(max_gap=2)
    tracker.update(0, [item(100, frame=0)])
    tracker.update(1, [])                      # occluded
    tracker.update(2, [item(100, frame=2)])
    assert len(tracker.tracks) == 1
    assert tracker.tracks[0].hits == 2


def test_a_long_disappearance_starts_a_new_track():
    tracker = Tracker(max_gap=1)
    tracker.update(0, [item(100, frame=0)])
    tracker.update(5, [item(100, frame=5)])
    assert len(tracker.tracks) == 2


def test_track_identity_is_a_majority_vote():
    tracker = Tracker()
    for f, sku in enumerate(["A", "B", "A", "A"]):
        tracker.update(f, [item(100, sku=sku, frame=f)])
    assert tracker.tracks[0].sku == "A"


def test_min_hits_discards_one_frame_ghosts():
    tracker = Tracker()
    tracker.update(0, [item(100, frame=0), item(400, frame=0)])
    tracker.update(1, [item(100, frame=1)])  # the second object never returns

    counts = count_from_tracks(tracker.tracks, CountConfig(min_hits=2), CATALOG)
    assert [(c.sku, c.count) for c in counts] == [("A", 1)]


def test_peak_frame_takes_the_fullest_view():
    per_frame = {
        0: [item(0), item(100)],
        1: [item(0), item(100), item(200)],
        2: [item(0)],
    }
    counts = count_per_frame(per_frame, CountConfig(), CATALOG, "peak_frame")
    assert counts[0].count == 3


def test_median_frame_ignores_a_single_bad_frame():
    per_frame = {
        0: [item(0), item(100)],
        1: [item(0), item(100)],
        2: [item(0), item(100), item(200), item(300)],  # a reflection burst
        3: [item(0), item(100)],
    }
    counts = count_per_frame(per_frame, CountConfig(), CATALOG, "median_frame")
    assert counts[0].count == 2


def test_frame_to_frame_disagreement_lowers_confidence():
    steady = {i: [item(0), item(100)] for i in range(4)}
    jumpy = {0: [item(0)], 1: [item(0), item(100), item(200)], 2: [item(0), item(100)]}
    calm = count_per_frame(steady, CountConfig(), CATALOG, "peak_frame")[0]
    wild = count_per_frame(jumpy, CountConfig(), CATALOG, "peak_frame")[0]
    assert calm.confidence > wild.confidence


def test_expected_counts_produce_variance():
    tracker = Tracker()
    for f in range(3):
        tracker.update(f, [item(100, frame=f), item(300, frame=f)])
    counts = count_from_tracks(tracker.tracks, CountConfig(expected={"A": 5}), CATALOG)
    assert counts[0].expected == 5
    assert counts[0].variance == -3


def test_overall_confidence_is_weighted_by_count():
    result = CountResult(run_id="r", source="x")
    tracker = Tracker()
    for f in range(3):
        tracker.update(f, [item(100, frame=f), item(300, sku="B", frame=f)])
    out = finalise(result, tracker.tracks, {}, CountConfig(), CATALOG)
    assert 0.0 < out.overall_confidence <= 1.0
    assert out.total == 2


def test_unknown_strategy_fails_loudly():
    with pytest.raises(ValueError, match="unknown count strategy"):
        finalise(
            CountResult(run_id="r", source="x"), [], {}, CountConfig(strategy="vibes"), CATALOG
        )
