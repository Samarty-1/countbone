"""Stage 4 - Identify. Decide which SKU each detection is."""

from __future__ import annotations

from typing import Protocol

import cv2
import numpy as np

from ..catalog import Catalog
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
            hue = float(np.median(hsv[:, :, 0]))
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


BACKENDS = {
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
