"""Counting features, scored end to end on rendered footage with known truth:
adaptive sampling, continuity, photo-enrolled identity, cross-video merging,
shelf gaps, bay labels, and the final count after review."""

from __future__ import annotations

import logging

import numpy as np
import pytest

from countbone import appearance, demo
from countbone.catalog import Catalog, SkuEntry
from countbone.config import Config
from countbone.ops.final import final_counts
from countbone.ops.merge import Placed, align, merge, objects_from_run
from countbone.pipeline import Pipeline
from countbone.plugins.shelf_check import check_planogram, find_gaps, rows_of


def _cfg(tmp_path, **capture) -> Config:
    cfg = Config()
    cfg.output.sqlite = None
    cfg.output.dir = str(tmp_path / "runs")
    for k, v in capture.items():
        setattr(cfg.capture, k, v)
    return cfg


@pytest.fixture(scope="module")
def media(tmp_path_factory):
    return tmp_path_factory.mktemp("accuracy")


# -- sampling and continuity ---------------------------------------------------------
def test_adaptive_sampling_recovers_what_a_fixed_stride_misses(media, tmp_path):
    """Seed 21 lost its left-edge cartons at a fixed stride of 5: the blurred
    samples left them one usable sighting each."""
    scene = demo.make_demo_video(media / "s21.webm", seed=21)
    fixed = Pipeline(_cfg(tmp_path, adaptive=False)).run(scene.path)
    adaptive = Pipeline(_cfg(tmp_path)).run(scene.path)
    assert fixed.total < scene.total
    assert fixed.needs_review, "a wrong count must never pass as clean"
    assert adaptive.total == scene.total
    assert {c.sku: c.count for c in adaptive.counts} == scene.truth
    assert adaptive.meta["sampling"]["retries"] > 0
    assert adaptive.meta["continuity"]["broken_gaps"] == 0


@pytest.mark.parametrize("seed", [2, 5, 9, 14])
def test_adaptive_sampling_is_exact_across_seeds(media, tmp_path, seed):
    scene = demo.make_demo_video(media / f"seed{seed}.webm", seed=seed)
    result = Pipeline(_cfg(tmp_path)).run(scene.path)
    assert {c.sku: c.count for c in result.counts} == scene.truth


def test_a_fast_pan_is_followed_by_narrowing_the_stride(media, tmp_path):
    scene = demo.make_demo_video(media / "fast.webm", seed=4, seconds=2.5)
    result = Pipeline(_cfg(tmp_path)).run(scene.path)
    assert result.meta["sampling"]["min_step"] < 5
    assert result.total == scene.total


def test_continuity_flags_a_camera_that_outran_the_tracker(media, tmp_path):
    scene = demo.make_demo_video(media / "veryfast.webm", seed=6, seconds=2.0)
    result = Pipeline(_cfg(tmp_path, adaptive=False, every_n_frames=10)).run(scene.path)
    assert result.meta["continuity"]["broken_gaps"] > 0
    assert result.needs_review
    assert any("film more slowly" in w for w in result.warnings)


def test_reaching_the_frame_cap_is_flagged(media, tmp_path):
    scene = demo.make_demo_video(media / "cap.webm", seed=3)
    result = Pipeline(_cfg(tmp_path, max_frames=10)).run(scene.path)
    assert result.needs_review
    assert any("not counted" in w for w in result.warnings)


def test_an_expected_sku_that_was_never_seen_is_a_zero_row(media, tmp_path):
    scene = demo.make_demo_video(media / "zero.webm", seed=3)
    expected = {**scene.truth, "SKU-GHOST": 4}
    result = Pipeline(_cfg(tmp_path)).run(scene.path, expected=expected)
    ghost = next(c for c in result.counts if c.sku == "SKU-GHOST")
    assert ghost.count == 0 and ghost.variance == -4
    assert result.needs_review
    assert any(e["sku"] == "SKU-GHOST" for e in result.meta["tolerance_exceptions"])


# -- identity ------------------------------------------------------------------------
def _lookalike_catalog(skip: str | None = None) -> Catalog:
    entries = [SkuEntry(s, v["label"], hue=(170, 10) if s.startswith("RED") else (95, 130))
               for s, v in demo.LOOKALIKE_SKUS.items()]
    exemplars = []
    for i, sku in enumerate(demo.LOOKALIKE_SKUS):
        if sku == skip:
            continue
        for j, photo in enumerate(demo.product_photos(sku, 5, seed=100 + i)):
            exemplars += appearance.vectors_for_photo(photo, f"{sku}:{j}", sku)
    return Catalog(entries, exemplars)


def test_photos_tell_apart_products_colour_cannot(media, tmp_path):
    scene = demo.make_demo_video(media / "look.webm", seed=5, palette="lookalike")
    colour = Pipeline(_cfg(tmp_path), catalog_provider=lambda: _lookalike_catalog()).run
    photos_catalog = _lookalike_catalog()
    with_photos = Pipeline(_cfg(tmp_path), catalog_provider=lambda: photos_catalog)
    assert with_photos.identifier.name == "appearance"
    result = with_photos.run(scene.path)
    assert {c.sku: c.count for c in result.counts if c.count} == scene.truth

    cfg = _cfg(tmp_path)
    cfg.identify.backend = "color"
    colour_only = Pipeline(cfg, catalog_provider=lambda: _lookalike_catalog()).run(scene.path)
    colour_counts = {c.sku: c.count for c in colour_only.counts if c.count}
    assert colour_counts != scene.truth, "the look-alike range should defeat colour matching"
    del colour


def test_an_unenrolled_look_alike_is_flagged_not_misfiled(media, tmp_path):
    scene = demo.make_demo_video(media / "look2.webm", seed=3, palette="lookalike")
    catalog = _lookalike_catalog(skip="RED-BAND")
    result = Pipeline(_cfg(tmp_path), catalog_provider=lambda: catalog).run(scene.path)
    counts = {c.sku: c.count for c in result.counts}
    assert scene.truth.get("RED-BAND", 0) > 0
    # Its units are not silently added to the look-alike it resembles most...
    assert counts.get("RED-PLAIN", 0) == scene.truth.get("RED-PLAIN", 0)
    # ...they surface as unknown, for a person.
    assert counts.get("UNKNOWN", 0) > 0
    assert result.needs_review


def test_index_calibrates_itself_from_enrolment_photos():
    index = _lookalike_catalog().index()
    assert index.calibration["source"] == "probes"
    assert 0.5 < index.accept < 0.99
    assert set(index.accept_by_sku) == set(demo.LOOKALIKE_SKUS)


def test_product_crop_removes_the_background():
    photo = demo.product_photos("RED-DOT", 1, seed=2)[0]
    crop = appearance.product_crop(photo)
    assert crop.shape[0] < photo.shape[0] and crop.shape[1] < photo.shape[1]
    # most of what is left is the red carton, not the backdrop
    red = (crop[:, :, 2] > 150) & (crop[:, :, 1] < 90)
    assert red.mean() > 0.3


def test_embedding_is_deterministic_and_unit_length():
    img = demo.product_photos("RED-STRIPE", 1, seed=0)[0]
    a, b = appearance.embed(img), appearance.embed(img.copy())
    assert np.allclose(a, b)
    assert abs(float(np.linalg.norm(a)) - 1.0) < 1e-5


# -- merging videos of one place ---------------------------------------------------------
def _objects(tmp_path, path) -> tuple[str, list[Placed]]:
    result = Pipeline(_cfg(tmp_path)).run(path)
    return result.run_id, objects_from_run({"run_id": result.run_id, "meta": result.meta,
                                            "reviews": []})


def test_overlapping_videos_are_counted_once(media, tmp_path):
    full = demo.make_demo_video(media / "m_full.webm", seed=8)
    a = demo.make_demo_video(media / "m_a.webm", seed=8, window=(0.0, 0.6), seconds=4.0)
    b = demo.make_demo_video(media / "m_b.webm", seed=8, window=(0.4, 1.0), seconds=4.0)
    runs = [_objects(tmp_path, a.path), _objects(tmp_path, b.path)]
    naive = sum(len(objs) for _, objs in runs)
    merged = merge(runs)
    assert naive > full.total
    assert merged.counts() == full.truth
    assert merged.alignments[1]["status"] == "aligned"


def test_videos_that_do_not_overlap_are_simply_added(media, tmp_path):
    a = demo.make_demo_video(media / "d_a.webm", seed=8, window=(0.0, 0.2), seconds=2.5)
    b = demo.make_demo_video(media / "d_b.webm", seed=8, window=(0.85, 1.0), seconds=2.5)
    runs = [_objects(tmp_path, a.path), _objects(tmp_path, b.path)]
    merged = merge(runs)
    assert sum(merged.counts().values()) == sum(len(o) for _, o in runs)
    assert merged.duplicates == 0


def test_a_uniform_shelf_is_ambiguous_not_guessed():
    grid = [Placed("SKU-A", x * 140.0, y * 180.0, 96, 112, "a") for x in range(12) for y in range(3)]
    shifted = [Placed("SKU-A", p.x - 420.0, p.y, 96, 112, "b") for p in grid if p.x >= 420]
    assert align(grid, shifted).status == "ambiguous"


# -- shelf gaps and planograms ------------------------------------------------------------
def test_every_empty_slot_is_found(media, tmp_path):
    import json

    scene = demo.make_demo_video(media / "gaps.webm", seed=21)
    result = Pipeline(_cfg(tmp_path)).run(scene.path)
    report = json.loads((tmp_path / "runs" / result.run_id / "shelf.json").read_text())
    assert report["missing_facings"] == len(scene.empty_slots)
    assert all("photo" in g for g in report["gaps"])
    assert (tmp_path / "runs" / result.run_id / report["gaps"][0]["photo"]).is_file()


def test_gap_finder_on_a_hand_made_row():
    row = [{"sku": "A", "x": x, "y": 50, "w": 100, "h": 100} for x in (50, 200, 500, 650)]
    other = [{"sku": "B", "x": x, "y": 250, "w": 100, "h": 100} for x in (50, 200, 350, 500, 650)]
    gaps = find_gaps(row + other)
    assert len(gaps) == 1 and gaps[0]["missing_facings"] == 1 and gaps[0]["row"] == 0


def test_planogram_names_what_is_wrong():
    objs = [{"sku": s, "x": i * 150.0, "y": 50, "w": 100, "h": 100}
            for i, s in enumerate(["A", "B", "X", "D"])]
    report = check_planogram(rows_of(objs), [["A", "B", "C", "D", "E"]], [])
    kinds = sorted(i["kind"] for i in report["issues"])
    assert kinds == ["misplaced", "missing"]
    assert report["compliance"] == 0.6


def test_contact_sheet_shows_every_counted_object(media, tmp_path):
    scene = demo.make_demo_video(media / "sheet.webm", seed=12)
    result = Pipeline(_cfg(tmp_path)).run(scene.path)
    assert result.meta["contact_sheet"]["objects"] == result.total
    assert (tmp_path / "runs" / result.run_id / "contact_sheet.jpg").is_file()


# -- bay labels in the video ----------------------------------------------------------------
def test_a_label_in_the_video_files_the_run_under_that_bay(media, tmp_path):
    scene = demo.make_demo_video(media / "label.webm", seed=3, label="A07-B03")
    result = Pipeline(_cfg(tmp_path)).run(scene.path)
    assert result.meta["context"]["location"] == "A07-B03"
    assert result.meta["labels_seen"] == ["A07-B03"]
    assert {c.sku: c.count for c in result.counts if c.sku != "UNKNOWN"} == scene.truth


def test_gap_photos_show_the_shelf_not_the_label(media, tmp_path):
    """Regression: the opening label frames tied with the first shelf frame
    and were chosen as the photo of a shelf gap."""
    import json

    scene = demo.make_demo_video(media / "label_gaps.webm", seed=12, label="A07-B03")
    result = Pipeline(_cfg(tmp_path)).run(scene.path)
    gaps = json.loads((tmp_path / "runs" / result.run_id / "shelf.json").read_text())["gaps"]
    label_frames = int(scene.fps * 0.75)
    assert gaps and all(g["photo_frame"] >= label_frames for g in gaps)


def test_a_label_for_another_bay_is_flagged(media, tmp_path):
    scene = demo.make_demo_video(media / "label2.webm", seed=3, label="A07-B03")
    result = Pipeline(_cfg(tmp_path)).run(scene.path, context={"location": "Z99"})
    assert result.needs_review
    assert any("filed under Z99" in w for w in result.warnings)


def test_scene_cuts_are_detected_and_blur_is_not():
    import random

    import cv2

    from countbone.stages.motion import MotionEstimator

    board, *_ = demo._shelf(2112, 540, random.Random(3))
    shelf = board[:, 0:960].copy()
    moved = board[:, 12:972].copy()
    blurred = cv2.GaussianBlur(moved, (21, 21), 0)
    label = demo._label_frames("A1", 960, 540, 1)[0]
    m = MotionEstimator()
    m.update(shelf)
    step = m.update(moved)
    assert step["estimated"] and not step["cut"] and abs(step["dx"] + 12) < 2
    assert not m.update(blurred)["cut"]
    assert m.update(label)["cut"]
    # The reference frame is not modified by phase correlation (OpenCV 5
    # windows its inputs in place): the same frame twice is zero motion.
    m2 = MotionEstimator()
    m2.update(shelf)
    again = m2.update(shelf.copy())
    assert again["estimated"] and abs(again["dx"]) < 0.5 and abs(again["dy"]) < 0.5


def test_find_location_prescan(media):
    from countbone.plugins.location_tag import find_location

    scene = demo.make_demo_video(media / "label3.webm", seed=3, label="DOCK-2")
    assert find_location(scene.path) == "DOCK-2"
    plain = demo.make_demo_video(media / "nolabel.webm", seed=3)
    assert find_location(plain.path) is None


# -- the final count ------------------------------------------------------------------------------
def _run(counts, reviews):
    return {"counts": [{"sku": s, "count": n, "expected": e, "label": s, "confidence": 0.9}
                       for s, n, e in counts], "reviews": reviews}


def _review(status, scope="item", **meta):
    return {"sku": meta.pop("sku", "A"), "status": status, "resolved_sku": meta.pop("to", None),
            "resolved_by": "ann", "meta": {"scope": scope, **meta}}


def test_final_count_applies_decisions_per_object():
    run = _run([("A", 10, 10), ("B", 5, 6)], [
        _review("rejected", track_id=1, track_sku="A", counted=True),           # A -1
        _review("corrected", track_id=2, track_sku="A", counted=True, to="B"),  # A -1, B +1
        _review("accepted", track_id=3, track_sku="B", counted=False, sku="B"),  # B +1 (a miss)
        _review("rejected", track_id=4, track_sku="B", counted=False, sku="B"),  # nothing
        _review("accepted", track_id=5, track_sku="A", counted=True),           # nothing
    ])
    fc = final_counts(run)
    rows = {r["sku"]: r for r in fc["rows"]}
    assert rows["A"]["machine"] == 10 and rows["A"]["final"] == 8
    assert rows["B"]["final"] == 7 and rows["B"]["variance"] == 1
    assert fc["settled"] and fc["total"] == 15


def test_a_recount_overrides_and_pending_reviews_keep_it_provisional():
    run = _run([("A", 10, 12)], [
        _review("corrected", scope="sku", sku="A", resolved_count=12),
        {"sku": "A", "status": "pending", "meta": {"scope": "item", "track_id": 9}},
    ])
    fc = final_counts(run)
    assert fc["rows"][0]["final"] == 12
    assert not fc["settled"] and fc["open_reviews"] == 1


def test_reviews_without_a_track_do_not_move_the_number():
    run = _run([("A", 4, None)], [_review("rejected", track_id=None)])
    assert final_counts(run)["rows"][0]["final"] == 4


@pytest.fixture(autouse=True)
def _quiet():
    logging.disable(logging.WARNING)
    yield
    logging.disable(logging.NOTSET)
