"""Stage 4 - Identify. Decide which SKU each detection is."""

from __future__ import annotations

from typing import Protocol

import cv2
import numpy as np

from ..catalog import Catalog, SkuEntry
from ..config import IdentifyConfig
from ..types import Detection, Frame, Item


class Identifier(Protocol):
    name: str

    def identify(self, frame: Frame, detections: list[Detection]) -> list[Item]: ...


def crop(frame: Frame, det: Detection, inset: float = 0.0) -> np.ndarray:
    """Pixels inside a box, optionally shrunk to avoid background bleed."""
    h, w = frame.image.shape[:2]
    x1, y1, x2, y2 = det.bbox
    if inset:
        dx, dy = (x2 - x1) * inset, (y2 - y1) * inset
        x1, y1, x2, y2 = x1 + dx, y1 + dy, x2 - dx, y2 - dy
    xi1, yi1 = max(0, int(x1)), max(0, int(y1))
    xi2, yi2 = min(w, int(round(x2))), min(h, int(round(y2)))
    if xi2 <= xi1 or yi2 <= yi1:
        return np.zeros((1, 1, 3), dtype=np.uint8)
    return frame.image[yi1:yi2, xi1:xi2]


def circular_hue(hsv: np.ndarray) -> float:
    """The typical hue of a patch, on OpenCV's 0-179 wheel.

    Hue wraps: 0 and 179 are both red. A median over a red patch whose
    pixels straddle the wrap (sensor noise decides which side each lands on)
    averages 0s and 179s into a green or cyan hue, which misfiled real red
    cartons as green. The mean direction on the circle, weighted by
    saturation so grey pixels (whose hue is noise) barely count, does not.
    """
    h = hsv[:, :, 0].astype(np.float64).ravel() * (2.0 * np.pi / 180.0)
    w = hsv[:, :, 1].astype(np.float64).ravel() + 1.0
    angle = np.arctan2(float((w * np.sin(h)).sum()), float((w * np.cos(h)).sum()))
    return float(np.mod(angle * 180.0 / (2.0 * np.pi), 180.0))


class ColorIdentifier:
    """Match the dominant hue of a detection against the catalog.

    Good enough for colour-coded stock and for proving the pipeline; swap in a
    trained classifier backend when SKUs are distinguished by artwork.
    """

    name = "color"

    def __init__(self, cfg: IdentifyConfig, catalog: Catalog) -> None:
        self.cfg = cfg
        self.catalog = catalog

    def identify(self, frame: Frame, detections: list[Detection]) -> list[Item]:
        items: list[Item] = []
        for det in detections:
            patch = crop(frame, det, inset=0.18)
            hsv = cv2.cvtColor(patch, cv2.COLOR_BGR2HSV)
            hue = circular_hue(hsv)
            sat = float(np.median(hsv[:, :, 1]))
            val = float(np.median(hsv[:, :, 2]))

            sku, label, conf = self.cfg.unknown_sku, "Unidentified", 0.0

            # Best fit, not first match: overlapping hue bands in a catalog
            # should not be resolved by the order someone typed them in.
            chromatic = [
                e
                for e in self.catalog.entries
                if not e.achromatic and sat >= e.min_saturation and e.matches_hue(hue)
            ]
            if chromatic:
                entry = min(chromatic, key=lambda e: e.hue_distance(hue))
                sku, label = entry.sku, entry.label
                # centre of the hue band and strong saturation both help
                centred = 1.0 - entry.hue_center_distance(hue)
                sat_term = min(1.0, sat / 180.0)
                conf = float(np.clip(0.35 + 0.45 * centred + 0.20 * sat_term, 0.0, 1.0))
            else:
                for entry in self.catalog.entries:
                    if entry.achromatic and sat < entry.min_saturation:
                        sku, label = entry.sku, entry.label
                        conf = float(np.clip(1.0 - sat / max(entry.min_saturation, 1), 0, 1))
                        break

            items.append(
                Item(
                    detection=det,
                    sku=sku,
                    label=label,
                    id_confidence=conf,
                    id_source="classifier" if conf > 0 else "fallback",
                    meta={"hue": round(hue, 1), "sat": round(sat, 1), "val": round(val, 1)},
                )
            )
        return items


class ClassMapIdentifier:
    """Map detector class names onto SKUs via the catalog's classes field."""

    name = "classmap"

    def __init__(self, cfg: IdentifyConfig, catalog: Catalog) -> None:
        self.cfg = cfg
        self.catalog = catalog

    def identify(self, frame: Frame, detections: list[Detection]) -> list[Item]:
        items = []
        for det in detections:
            class_name = str(det.meta.get("class_name", ""))
            entry = self.catalog.by_class(class_name)
            if entry is None:
                items.append(
                    Item(
                        detection=det,
                        sku=self.cfg.unknown_sku,
                        label=class_name or "Unidentified",
                        id_confidence=0.0,
                        id_source="fallback",
                    )
                )
            else:
                items.append(
                    Item(
                        detection=det,
                        sku=entry.sku,
                        label=entry.label,
                        id_confidence=det.score,
                        id_source="classifier",
                    )
                )
        return items


class FixtureIdentifier:
    """Reads the SKU straight off the detection metadata. For tests."""

    name = "fixture"

    def __init__(self, cfg: IdentifyConfig, catalog: Catalog) -> None:
        self.cfg = cfg
        self.catalog = catalog

    def identify(self, frame: Frame, detections: list[Detection]) -> list[Item]:
        return [
            Item(
                detection=det,
                sku=str(det.meta.get("sku", self.cfg.unknown_sku)),
                label=str(det.meta.get("label", "")),
                id_confidence=float(det.meta.get("id_confidence", det.score)),
                id_source="fixture",
            )
            for det in detections
        ]


def _bands_overlap(a: SkuEntry, b: SkuEntry) -> bool:
    """Could a sighting of `b` fall in `a`'s colour band?"""
    if a.achromatic or b.achromatic:
        return a.achromatic and b.achromatic
    if a.hue is None or b.hue is None:
        return True
    return any(a.matches_hue(h) for h in _band_points(b)) or any(
        b.matches_hue(h) for h in _band_points(a))


def _band_points(e: SkuEntry) -> list[float]:
    lo, hi = e.hue  # type: ignore[misc]
    span = (hi - lo) if lo <= hi else (180 - lo + hi)
    return [(lo + span * k / 8) % 180 for k in range(9)]


class BarcodeReader:
    """Read an EAN/UPC off a sighting when one is legible.

    A readable barcode is the strongest identity evidence there is, but most
    video crops are too small or soft to decode, so this is tried only on
    large crops and only when the catalog lists barcodes at all.
    """

    MIN_WIDTH = 90  # px; below this a 1D code cannot resolve at video quality

    def __init__(self, catalog: Catalog) -> None:
        self.catalog = catalog
        self.enabled = any(e.barcodes for e in catalog.entries)
        self._detector = cv2.barcode.BarcodeDetector() if self.enabled else None

    def read(self, patch: np.ndarray):
        if not self.enabled or patch.shape[1] < self.MIN_WIDTH:
            return None
        try:
            text, _, _ = self._detector.detectAndDecode(patch)
        except cv2.error:
            return None
        return self.catalog.by_barcode(text) if text else None


class AppearanceIdentifier:
    """Identify by artwork, from photos enrolled in Catalog Studio.

    Each sighting is embedded and matched against the enrolled examples
    (see appearance.py); a readable barcode overrides the match. SKUs that
    were never photographed are still recognised by colour, so a catalog
    can move from colour bands to photos one product at a time.
    """

    name = "appearance"

    def __init__(self, cfg: IdentifyConfig, catalog: Catalog) -> None:
        from .. import appearance

        self.cfg = cfg
        self.catalog = catalog
        self.index = catalog.index()
        self._embed = appearance.embed
        self._confidence = appearance.confidence
        self.barcodes = BarcodeReader(catalog)
        enrolled = [e for e in catalog.entries if e.sku in set(self.index.skus)]
        # Colour may vouch only for products nobody photographed, and only
        # when no photographed product shares their colour: a red sighting the
        # photos rejected must become "unknown", not the one red product that
        # happens to have no photos. If any photographed product has no colour
        # band, its colour is unknown and colour vouches for nothing.
        if any(e.hue is None and not e.achromatic for e in enrolled):
            fallback: list[SkuEntry] = []
        else:
            fallback = [
                e for e in catalog.entries
                if e.sku not in self.index.skus
                and not any(_bands_overlap(e, other) for other in enrolled)
            ]
        self.colour = ColorIdentifier(cfg, Catalog(fallback))
        # A photographed product sharing its colour with one nobody
        # photographed has an invisible rival: the look-alike can never win a
        # match, so nothing catches a crop of it that clears the photographed
        # product's bar. With few photos that bar is one odd view away from
        # letting it through, so it is held to at least the default bar.
        self._floor = {e.sku: appearance.DEFAULT_ACCEPT for e in shadowed(catalog, self.index)
                       if not self.index.well_photographed(e.sku)}

    def identify(self, frame: Frame, detections: list[Detection]) -> list[Item]:
        items: list[Item] = []
        for det in detections:
            patch = crop(frame, det)
            entry = self.barcodes.read(patch)
            if entry is not None:
                items.append(Item(det, entry.sku, entry.label, 0.98, "barcode",
                                  meta={"candidates": [{"sku": entry.sku, "score": 1.0}]}))
                continue
            if patch.size < 16 * 3:
                items.append(Item(det, self.cfg.unknown_sku, "Unidentified", 0.0, "fallback"))
                continue
            matches = self.index.match(self._embed(patch)) if len(self.index) else []
            accept = self.index.accept_for(matches[0].sku) if matches else self.index.accept
            if matches:
                accept = max(accept, self._floor.get(matches[0].sku, 0.0))
            conf = self._confidence(matches, accept, self.index.margin)
            candidates = [{"sku": m.sku, "score": round(m.score, 4)} for m in matches]
            if matches and matches[0].score >= accept:
                entry = self.catalog.by_sku(matches[0].sku)
                items.append(Item(det, matches[0].sku, entry.label if entry else matches[0].sku,
                                  conf, "appearance", meta={"candidates": candidates}))
                continue
            # Not like any photo: perhaps a product that is only colour-banded.
            fallback = self.colour.identify(frame, [det])[0]
            if fallback.sku != self.cfg.unknown_sku:
                fallback.meta["candidates"] = candidates
                items.append(fallback)
                continue
            items.append(Item(det, self.cfg.unknown_sku, "Unidentified", conf, "fallback",
                              meta={"candidates": candidates, **fallback.meta}))
        return items


def shadowed(catalog: Catalog, index) -> list[SkuEntry]:
    """Photographed products that share their colour with an unphotographed one."""
    enrolled = [e for e in catalog.entries if e.sku in set(index.skus)]
    others = [e for e in catalog.entries if e.sku not in set(index.skus)]
    return [e for e in enrolled if any(_bands_overlap(e, o) for o in others)]


class AutoIdentifier:
    """The default: appearance once any product has photos, colour until then.

    Chosen per run (the pipeline rebuilds its identifier when the catalog
    changes), so enrolling the first photos switches a deployment over
    without a config edit.
    """

    def __new__(cls, cfg: IdentifyConfig, catalog: Catalog):  # type: ignore[misc]
        if catalog.exemplars:
            return AppearanceIdentifier(cfg, catalog)
        return ColorIdentifier(cfg, catalog)


BACKENDS = {
    "auto": AutoIdentifier,
    "appearance": AppearanceIdentifier,
    "color": ColorIdentifier,
    "classmap": ClassMapIdentifier,
    "fixture": FixtureIdentifier,
}


def build(cfg: IdentifyConfig, catalog: Catalog) -> Identifier:
    try:
        cls = BACKENDS[cfg.backend]
    except KeyError:
        raise ValueError(
            f"unknown identify backend {cfg.backend!r}; choose from {sorted(BACKENDS)}"
        ) from None
    return cls(cfg, catalog)
