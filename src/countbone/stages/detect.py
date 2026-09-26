"""Stage 3 — Detect. Find object boxes in a frame.

Backends are swappable because the detector is the part most likely to be
replaced per customer: a classical baseline that runs anywhere with no
weights, a YOLO backend for when accuracy matters, and a fixture backend so
tests can assert pipeline behaviour without depending on pixels.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Protocol

import cv2
import numpy as np

from ..config import DetectConfig
from ..types import BBox, Detection, Frame

log = logging.getLogger(__name__)


class Detector(Protocol):
    name: str

    def detect(self, frame: Frame) -> list[Detection]: ...


# --------------------------------------------------------------------------
# helpers


def iou(a: BBox, b: BBox) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix = max(0.0, min(ax2, bx2) - max(ax1, bx1))
    iy = max(0.0, min(ay2, by2) - max(ay1, by1))
    inter = ix * iy
    if inter <= 0:
        return 0.0
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def nms(detections: list[Detection], threshold: float) -> list[Detection]:
    """Greedy non-maximum suppression, highest score wins."""
    kept: list[Detection] = []
    for det in sorted(detections, key=lambda d: d.score, reverse=True):
        if all(iou(det.bbox, k.bbox) < threshold for k in kept):
            kept.append(det)
    return kept


def filter_detections(
    detections: list[Detection], frame: Frame, cfg: DetectConfig
) -> list[Detection]:
    w, h = frame.shape
    frame_area = float(w * h) or 1.0
    out = [
        d
        for d in detections
        if d.score >= cfg.min_score
        and cfg.min_area_frac <= d.area / frame_area <= cfg.max_area_frac
    ]
    out = nms(out, cfg.nms_iou)
    out.sort(key=lambda d: d.score, reverse=True)
    return out[: cfg.max_detections]


# --------------------------------------------------------------------------
# backends


class ContourDetector:
    """Classical edge-and-contour detector. No weights, runs on any machine.

    It is a baseline, not a solved detector: it works on separated items with
    visible edges against a contrasting background, and degrades on dense,
    touching, or occluded stock. That limit is the reason the confidence
    plugin and review queue exist.
    """

    name = "contour"

    def __init__(self, cfg: DetectConfig) -> None:
        self.cfg = cfg

    # Width of the synthetic border added around each frame (see detect()).
    PAD = 12

    def detect(self, frame: Frame) -> list[Detection]:
        image = frame.image
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
        # An object cut off by the frame edge has no edge along the cut, so
        # its outline never closes; RETR_EXTERNAL then reports whatever is
        # *inside* it (a carton's white label) as an object of its own. A
        # border in the frame's median tone closes those outlines against the
        # cut, where the plain background, being close to the median, stays
        # edge-free. Objects touching the border are then dropped below:
        # they are partial, and a pan shows each one whole in another frame.
        pad = self.PAD
        fill = int(np.median(gray))
        gray = cv2.copyMakeBorder(gray, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=fill)
        gray = cv2.GaussianBlur(gray, (5, 5), 0)

        median = float(np.median(gray))
        lo = int(max(0, 0.66 * median))
        hi = int(min(255, 1.33 * median))
        edges = cv2.Canny(gray, lo, hi)
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
        closed = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel, iterations=2)

        contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        detections: list[Detection] = []
        frame_w, frame_h = frame.shape
        for contour in contours:
            x, y, w, h = cv2.boundingRect(contour)
            if w < 8 or h < 8:
                continue
            # Back to frame coordinates; skip anything reaching the frame edge.
            x -= pad
            y -= pad
            if x <= 0 or y <= 0 or x + w >= frame_w or y + h >= frame_h:
                continue
            rect_area = float(w * h)
            fill = float(cv2.contourArea(contour)) / rect_area if rect_area else 0.0
            aspect = w / h if h else 0.0
            if not 0.2 <= aspect <= 5.0:
                continue
            # Score blends how box-like the blob is with how convex it is;
            # a clean product face scores high, a lighting artefact does not.
            hull_area = float(cv2.contourArea(cv2.convexHull(contour))) or 1.0
            solidity = float(cv2.contourArea(contour)) / hull_area
            score = float(np.clip(0.55 * fill + 0.45 * solidity, 0.0, 1.0))
            detections.append(
                Detection(
                    bbox=(float(x), float(y), float(x + w), float(y + h)),
                    score=score,
                    frame_index=frame.index,
                    detector=self.name,
                    meta={"fill": round(fill, 3), "solidity": round(solidity, 3)},
                )
            )
        return filter_detections(detections, frame, self.cfg)


class YoloDetector:
    """Ultralytics backend. Imported lazily so the package stays installable."""

    name = "yolo"

    def __init__(self, cfg: DetectConfig) -> None:
        self.cfg = cfg
        try:
            from ultralytics import YOLO  # type: ignore
        except ImportError as exc:  # pragma: no cover - depends on env
            raise RuntimeError(
                "detect.backend='yolo' needs the optional extra: pip install 'countbone[yolo]'"
            ) from exc
        self.model = YOLO(cfg.model_path or "yolov8n.pt")
        self.names: dict[int, str] = getattr(self.model, "names", {}) or {}

    def detect(self, frame: Frame) -> list[Detection]:  # pragma: no cover - needs weights
        results = self.model.predict(
            frame.image, conf=self.cfg.min_score, device=self.cfg.device, verbose=False
        )
        detections: list[Detection] = []
        for result in results:
            for box in getattr(result, "boxes", []):
                x1, y1, x2, y2 = (float(v) for v in box.xyxy[0].tolist())
                cls = int(box.cls[0]) if box.cls is not None else -1
                detections.append(
                    Detection(
                        bbox=(x1, y1, x2, y2),
                        score=float(box.conf[0]),
                        frame_index=frame.index,
                        detector=self.name,
                        meta={"class_id": cls, "class_name": self.names.get(cls, "")},
                    )
                )
        return filter_detections(detections, frame, self.cfg)


class FixtureDetector:
    """Replays scripted detections. Used by tests and by the offline demo."""

    name = "fixture"

    def __init__(self, cfg: DetectConfig, script: Callable[[Frame], list[Detection]] | None = None):
        self.cfg = cfg
        self.script = script or (lambda frame: [])

    def detect(self, frame: Frame) -> list[Detection]:
        return filter_detections(list(self.script(frame)), frame, self.cfg)


BACKENDS: dict[str, type] = {
    "contour": ContourDetector,
    "yolo": YoloDetector,
    "fixture": FixtureDetector,
}


def build(cfg: DetectConfig) -> Detector:
    try:
        cls = BACKENDS[cfg.backend]
    except KeyError:
        raise ValueError(
            f"unknown detect backend {cfg.backend!r}; choose from {sorted(BACKENDS)}"
        ) from None
    return cls(cfg)
