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


def test_a_box_cut_by_the_frame_edge_does_not_leak_its_label():
    """Regression: a carton cut off by the frame edge has an open outline, so
    its white label was reported as an object of its own (an UNKNOWN count and
    a review item). The partial carton is skipped; the label must be too."""
    image = np.full((480, 640, 3), 170, dtype=np.uint8)
    # whole carton with a label, for contrast
    cv2.rectangle(image, (100, 120), (200, 300), (40, 40, 205), -1)
    cv2.rectangle(image, (100, 120), (200, 300), (30, 30, 30), 3)
    cv2.rectangle(image, (116, 150), (184, 180), (235, 235, 235), -1)
    # carton running off the right edge, label fully inside the frame
    cv2.rectangle(image, (560, 120), (700, 300), (40, 40, 205), -1)
    cv2.rectangle(image, (560, 120), (700, 300), (30, 30, 30), 3)
    cv2.rectangle(image, (576, 150), (630, 180), (235, 235, 235), -1)
    frame = Frame(index=0, source_index=0, timestamp_s=0.0, image=image)

    dets = detect.build(DetectConfig()).detect(frame)
    assert len(dets) == 1  # only the whole carton: no partial, no label
    x1, y1, x2, y2 = dets[0].bbox
    assert x1 <= 100 and y1 <= 120 and x2 >= 200 and y2 >= 300 and x2 < 260


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


# -- barcodes --------------------------------------------------------------------------------
_EAN_L = ["0001101", "0011001", "0010011", "0111101", "0100011",
          "0110001", "0101111", "0111011", "0110111", "0001011"]
_EAN_G = ["0100111", "0110011", "0011011", "0100001", "0011101",
          "0111001", "0000101", "0010001", "0001001", "0010111"]
_EAN_R = ["1110010", "1100110", "1101100", "1000010", "1011100",
          "1001110", "1010000", "1000100", "1001000", "1110100"]
_EAN_PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG",
               "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"]


def ean13(code: str, module: int = 2) -> np.ndarray:
    """A printed EAN-13, drawn from the standard's encoding tables."""
    d = [int(c) for c in code]
    bits = "101"
    for i, c in enumerate(d[1:7]):
        bits += (_EAN_L if _EAN_PARITY[d[0]][i] == "L" else _EAN_G)[c]
    bits += "01010" + "".join(_EAN_R[c] for c in d[7:]) + "101"
    quiet = 15
    img = np.full((200, (len(bits) + 2 * quiet) * module), 255, np.uint8)
    for i, b in enumerate(bits):
        if b == "1":
            img[20:180, (quiet + i) * module:(quiet + i + 1) * module] = 0
    img = cv2.copyMakeBorder(img, 20, 20, 20, 20, cv2.BORDER_CONSTANT, value=255)
    return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)


def test_a_legible_barcode_names_its_product():
    code = "4006381333931"
    catalog = Catalog([SkuEntry("PEN", "Pen", barcodes=[code]), SkuEntry("INK", "Ink")])
    reader = identify.BarcodeReader(catalog)
    patch = ean13(code)
    assert reader.read(patch).sku == "PEN"
    # A crop too narrow to resolve a 1D code is not even tried.
    assert reader.read(cv2.resize(patch, (80, 60))) is None
    # A code the catalog does not list names nothing.
    assert identify.BarcodeReader(Catalog([SkuEntry("X", barcodes=["5012345678900"])])).read(patch) is None


def test_barcodes_are_not_read_when_no_product_lists_one():
    reader = identify.BarcodeReader(Catalog([SkuEntry("PEN", "Pen")]))
    assert not reader.enabled and reader.read(ean13("4006381333931")) is None
