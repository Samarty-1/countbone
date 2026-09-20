"""Detection filtering and SKU identification, the two swappable middles."""

from __future__ import annotations

import cv2
import numpy as np
import pytest

from countbone.catalog import Catalog, SkuEntry
from countbone.config import DetectConfig, IdentifyConfig
from countbone.stages import detect, identify
from countbone.types import Detection, Frame


def frame_with_boxes(colors, size=(480, 640)) -> Frame:
    image = np.full((*size, 3), 170, dtype=np.uint8)
    for i, color in enumerate(colors):
        x = 40 + i * 140
        cv2.rectangle(image, (x, 120), (x + 100, 300), color, -1)
        cv2.rectangle(image, (x, 120), (x + 100, 300), (30, 30, 30), 3)
    return Frame(index=0, source_index=0, timestamp_s=0.0, image=image)


# -- detection -------------------------------------------------------------
def test_iou_of_identical_boxes_is_one():
    assert detect.iou((0, 0, 10, 10), (0, 0, 10, 10)) == pytest.approx(1.0)


def test_iou_of_disjoint_boxes_is_zero():
    assert detect.iou((0, 0, 10, 10), (50, 50, 60, 60)) == 0.0


def test_nms_keeps_the_best_of_an_overlapping_pair():
    a = Detection((0, 0, 100, 100), score=0.9, frame_index=0)
    b = Detection((5, 5, 105, 105), score=0.4, frame_index=0)
    kept = detect.nms([b, a], threshold=0.45)
    assert kept == [a]


def test_nms_keeps_neighbours_that_merely_touch():
    a = Detection((0, 0, 100, 100), score=0.9, frame_index=0)
    b = Detection((101, 0, 200, 100), score=0.8, frame_index=0)
    assert len(detect.nms([a, b], threshold=0.45)) == 2


def test_specks_and_whole_frame_blobs_are_filtered_out():
    frame = frame_with_boxes([(0, 0, 200)])
    cfg = DetectConfig(min_area_frac=0.001, max_area_frac=0.25)
    dets = [
        Detection((0, 0, 4, 4), score=0.9, frame_index=0),           # speck
        Detection((0, 0, 640, 480), score=0.9, frame_index=0),       # the shelf
        Detection((40, 120, 140, 300), score=0.9, frame_index=0),    # a real box
    ]
    kept = detect.filter_detections(dets, frame, cfg)
    assert [d.bbox for d in kept] == [(40, 120, 140, 300)]


def test_contour_detector_finds_separated_boxes():
    frame = frame_with_boxes([(40, 40, 205), (200, 110, 40), (60, 170, 60)])
    dets = detect.build(DetectConfig()).detect(frame)
    assert len(dets) == 3
    assert all(d.score > 0.5 for d in dets)


def test_unknown_detector_backend_fails_loudly():
    with pytest.raises(ValueError, match="unknown detect backend"):
        detect.build(DetectConfig(backend="magic"))


def test_fixture_detector_replays_a_script():
    frame = frame_with_boxes([(0, 0, 200)])
    script = lambda f: [Detection((10, 10, 110, 210), score=0.8, frame_index=f.index)]  # noqa: E731
    backend = detect.FixtureDetector(DetectConfig(), script=script)
    assert len(backend.detect(frame)) == 1


# -- identification --------------------------------------------------------
def identify_one(color, catalog=None, cfg=None):
    frame = frame_with_boxes([color])
    det = Detection((40, 120, 140, 300), score=0.9, frame_index=0)
    backend = identify.build(cfg or IdentifyConfig(), catalog or Catalog.default())
    return backend.identify(frame, [det])[0]


def test_colour_identifier_names_each_carton():
    assert identify_one((40, 40, 205)).sku == "SKU-RED"
    assert identify_one((200, 110, 40)).sku == "SKU-BLU"
    assert identify_one((60, 170, 60)).sku == "SKU-GRN"
    assert identify_one((40, 200, 225)).sku == "SKU-YEL"


def test_a_colour_outside_the_catalog_is_unknown():
    item = identify_one((200, 40, 190))  # magenta: in no band
    assert item.sku == "UNKNOWN"
    assert item.id_confidence == 0.0
    assert item.id_source == "fallback"


def test_an_unsaturated_item_matches_an_achromatic_entry():
    catalog = Catalog([SkuEntry("SKU-TIN", "Tin", achromatic=True, min_saturation=40)])
    item = identify_one((150, 150, 150), catalog=catalog)
    assert item.sku == "SKU-TIN"
    assert item.id_confidence > 0.5


def test_classmap_identifier_maps_detector_classes():
    catalog = Catalog([SkuEntry("SKU-BTL", "Bottle", classes=["bottle"])])
    frame = frame_with_boxes([(0, 0, 200)])
    det = Detection((40, 120, 140, 300), score=0.77, frame_index=0, meta={"class_name": "bottle"})
    backend = identify.build(IdentifyConfig(backend="classmap"), catalog)
    item = backend.identify(frame, [det])[0]
    assert item.sku == "SKU-BTL"
    assert item.id_confidence == pytest.approx(0.77)


def test_classmap_falls_back_for_an_unmapped_class():
    frame = frame_with_boxes([(0, 0, 200)])
    det = Detection((40, 120, 140, 300), score=0.7, frame_index=0, meta={"class_name": "cat"})
    backend = identify.build(IdentifyConfig(backend="classmap"), Catalog([]))
    assert backend.identify(frame, [det])[0].sku == "UNKNOWN"


def test_unknown_identify_backend_fails_loudly():
    with pytest.raises(ValueError, match="unknown identify backend"):
        identify.build(IdentifyConfig(backend="telepathy"), Catalog.default())


def test_crop_clamps_to_the_frame():
    frame = frame_with_boxes([(0, 0, 200)])
    det = Detection((-50, -50, 20, 20), score=0.5, frame_index=0)
    patch = identify.crop(frame, det)
    assert patch.shape[0] > 0 and patch.shape[1] > 0


def test_overlapping_hue_bands_pick_the_best_fit_not_the_first_entry():
    """Regression: catalog order decided the answer when two bands overlap.

    This blue patch reads at hue 107: 3 from the narrow band's centre and 8
    from the wide one's, so the narrow band wins whichever order they appear in.
    """
    wide = SkuEntry("SKU-WIDE", "Wide band", hue=(90, 140))         # centre 115
    narrow = SkuEntry("SKU-NARROW", "Narrow band", hue=(105, 115))  # centre 110

    for order in ([wide, narrow], [narrow, wide]):
        item = identify_one((200, 110, 40), catalog=Catalog(list(order)))
        assert item.sku == "SKU-NARROW", f"order {[e.sku for e in order]} changed the answer"
