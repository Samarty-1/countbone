"""Core data types passed between backbone stages.

Everything a plugin sees is one of these. They are plain dataclasses on
purpose: plugins mutate/replace them, and nothing here should depend on the
web layer, the database, or a particular detector.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any

import numpy as np

BBox = tuple[float, float, float, float]  # x1, y1, x2, y2 in pixels


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


@dataclass
class Frame:
    """A single sampled frame moving through the pipeline."""

    index: int  # index within the sampled sequence, not the source video
    source_index: int  # frame number in the source video
    timestamp_s: float
    image: np.ndarray
    meta: dict[str, Any] = field(default_factory=dict)

    @property
    def shape(self) -> tuple[int, int]:
        h, w = self.image.shape[:2]
        return w, h


@dataclass
class Detection:
    """Something the detector believes is an object, before we know what it is."""

    bbox: BBox
    score: float
    frame_index: int
    detector: str = "unknown"
    meta: dict[str, Any] = field(default_factory=dict)

    @property
    def area(self) -> float:
        x1, y1, x2, y2 = self.bbox
        return max(0.0, x2 - x1) * max(0.0, y2 - y1)

    @property
    def centroid(self) -> tuple[float, float]:
        x1, y1, x2, y2 = self.bbox
        return (x1 + x2) / 2.0, (y1 + y2) / 2.0


@dataclass
class Item:
    """A detection that has been given an identity (a SKU)."""

    detection: Detection
    sku: str
    label: str = ""
    id_confidence: float = 0.0
    id_source: str = "classifier"  # classifier | ocr | barcode | fallback
    track_id: int | None = None
    confidence: float = 0.0  # filled in by the confidence plugin
    meta: dict[str, Any] = field(default_factory=dict)

    @property
    def frame_index(self) -> int:
        return self.detection.frame_index


@dataclass
class Track:
    """The same physical object observed across several frames."""

    track_id: int
    sku: str
    items: list[Item] = field(default_factory=list)
    first_frame: int = 0
    last_frame: int = 0

    @property
    def hits(self) -> int:
        return len(self.items)

    @property
    def mean_score(self) -> float:
        return float(np.mean([i.detection.score for i in self.items])) if self.items else 0.0

    @property
    def best_item(self) -> Item | None:
        return max(self.items, key=lambda i: i.detection.score, default=None)


@dataclass
class SkuCount:
    """The answer, per SKU."""

    sku: str
    count: int
    label: str = ""
    confidence: float = 0.0
    expected: int | None = None
    evidence: dict[str, Any] = field(default_factory=dict)

    @property
    def variance(self) -> int | None:
        return None if self.expected is None else self.count - self.expected


@dataclass
class ReviewItem:
    """Something the pipeline was not sure enough about to decide alone."""

    review_id: str
    run_id: str
    sku: str
    reason: str
    confidence: float
    frame_index: int
    bbox: BBox | None = None
    crop_path: str | None = None
    status: str = "pending"  # pending | accepted | rejected | corrected
    resolved_sku: str | None = None
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass
class CountResult:
    """Everything the run produced. This is what the output layer emits."""

    run_id: str
    source: str
    counts: list[SkuCount] = field(default_factory=list)
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    frames_read: int = 0
    frames_used: int = 0
    frames_dropped: int = 0
    detections: int = 0
    tracks: int = 0
    overall_confidence: float = 0.0
    needs_review: bool = False
    reviews: list[ReviewItem] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    meta: dict[str, Any] = field(default_factory=dict)

    @property
    def total(self) -> int:
        return sum(c.count for c in self.counts)

    @property
    def duration_s(self) -> float:
        return (self.finished_at or time.time()) - self.started_at

    def to_dict(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "source": self.source,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "duration_s": round(self.duration_s, 3),
            "frames_read": self.frames_read,
            "frames_used": self.frames_used,
            "frames_dropped": self.frames_dropped,
            "detections": self.detections,
            "tracks": self.tracks,
            "total": self.total,
            "overall_confidence": round(self.overall_confidence, 4),
            "needs_review": self.needs_review,
            "warnings": self.warnings,
            "counts": [
                {
                    "sku": c.sku,
                    "label": c.label,
                    "count": c.count,
                    "confidence": round(c.confidence, 4),
                    "expected": c.expected,
                    "variance": c.variance,
                    "evidence": c.evidence,
                }
                for c in self.counts
            ],
            "reviews": [
                {
                    "review_id": r.review_id,
                    "sku": r.sku,
                    "reason": r.reason,
                    "confidence": round(r.confidence, 4),
                    "frame_index": r.frame_index,
                    "bbox": list(r.bbox) if r.bbox else None,
                    "crop_path": r.crop_path,
                    "status": r.status,
                }
                for r in self.reviews
            ],
            "meta": self.meta,
        }
