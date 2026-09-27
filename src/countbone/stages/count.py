"""Stage 5 - Count. Turn per-frame sightings into one number per SKU.

This is the stage that decides whether the product is trustworthy, because
the hard problem is not detecting a box, it is knowing that the box in frame
12 is the same box as in frame 11.

Three strategies, chosen per deployment:

  tracking      link sightings across frames into tracks, count the tracks.
                Right for a camera panning across stock. Over-counts if the
                pan is fast enough to break association.
  peak_frame    take the largest count seen in any single frame.
                Right for a fixed camera on a static shelf. Under-counts
                anything never visible all at once.
  median_frame  the median per-frame count, robust to a few bad frames.
                Right for a fixed camera with intermittent occlusion.
"""

from __future__ import annotations

import statistics
from collections import Counter, defaultdict

import numpy as np

from ..catalog import Catalog
from ..config import CountConfig
from ..types import CountResult, Item, SkuCount, Track
from .detect import iou


class Tracker:
    """Greedy IoU tracker. Deliberately simple and inspectable.

    No Kalman filter and no appearance embedding: with a sampled frame stream
    the motion model would be fitted to almost nothing. Association is IoU
    against the last known box, and a track survives `max_gap` missed frames.
    """

    def __init__(self, iou_threshold: float = 0.3, max_gap: int = 2) -> None:
        self.iou_threshold = iou_threshold
        self.max_gap = max_gap
        self.tracks: list[Track] = []
        self._last_box: dict[int, tuple[float, float, float, float]] = {}
        self._last_cum: dict[int, tuple[float, float]] = {}
        self._cum = (0.0, 0.0)  # running camera displacement since the first frame
        self._next_id = 1

    def update(
        self, frame_index: int, items: list[Item], motion: dict[str, float] | None = None
    ) -> None:
        """Associate this frame's items with existing tracks.

        `motion` is the global scene displacement since the previous frame. A
        panning camera moves every box at once, so predicting each track
        forward by that displacement is what keeps one physical carton as one
        track instead of one per frame.
        """
        self.observe_motion(motion)

        live = [
            t for t in self.tracks if frame_index - t.last_frame <= self.max_gap + 1
        ]
        unmatched = list(items)
        # Highest-overlap pairs first, so a crowded shelf does not get stolen
        # matches by whichever item happened to be listed first.
        pairs = sorted(
            (
                (
                    iou(
                        self._predict(t, frame_index, motion),
                        item.detection.bbox,
                    ),
                    t,
                    item,
                )
                for t in live
                for item in items
            ),
            key=lambda p: p[0],
            reverse=True,
        )
        used_tracks: set[int] = set()
        used_items: set[int] = set()
        for score, track, item in pairs:
            if score < self.iou_threshold:
                break
            if track.track_id in used_tracks or id(item) in used_items:
                continue
            self._attach(track, item, frame_index)
            used_tracks.add(track.track_id)
            used_items.add(id(item))

        for item in unmatched:
            if id(item) in used_items:
                continue
            track = Track(
                track_id=self._next_id,
                sku=item.sku,
                first_frame=frame_index,
                last_frame=frame_index,
            )
            self._next_id += 1
            self.tracks.append(track)
            self._attach(track, item, frame_index)

    def observe_motion(self, motion: dict[str, float] | None) -> None:
        """Add one frame's camera displacement to the running total.

        Called for every frame, including ones the quality gate drops: the
        camera moved during a dropped frame too. Skip that, and every track's
        prediction lags by a whole frame of pan, which at walking speed is
        enough to split each object in view into two tracks and count it twice.
        """
        if motion and motion.get("estimated"):
            self._cum = (self._cum[0] + motion["dx"], self._cum[1] + motion["dy"])

    def _predict(
        self, track: Track, frame_index: int, motion: dict[str, float] | None
    ) -> tuple[float, float, float, float]:
        """Where this track's box should be now, given how far the camera moved."""
        x1, y1, x2, y2 = self._last_box[track.track_id]
        seen_cum = self._last_cum.get(track.track_id, self._cum)
        dx = self._cum[0] - seen_cum[0]
        dy = self._cum[1] - seen_cum[1]
        return (x1 + dx, y1 + dy, x2 + dx, y2 + dy)

    def _attach(self, track: Track, item: Item, frame_index: int) -> None:
        item.track_id = track.track_id
        # Where the object sits on the shelf, in the first frame's pixel
        # coordinates: its image position minus how far the scene has slid.
        # Stable across the whole walk, so cross-video merging and shelf-gap
        # checks can reason about the shelf rather than the screen.
        cx, cy = item.detection.centroid
        x1, y1, x2, y2 = item.detection.bbox
        item.meta["world"] = (
            round(cx - self._cum[0], 1), round(cy - self._cum[1], 1),
            round(x2 - x1, 1), round(y2 - y1, 1),
        )
        track.items.append(item)
        track.last_frame = frame_index
        # A track's SKU is the majority vote of its sightings, not the first
        # guess: identification flickers, object permanence does not.
        track.sku = Counter(i.sku for i in track.items).most_common(1)[0][0]
        self._last_box[track.track_id] = item.detection.bbox
        self._last_cum[track.track_id] = self._cum


def track_world(track: Track) -> dict[str, float] | None:
    """A track's shelf position and size: the median over its sightings."""
    pts = [i.meta["world"] for i in track.items if "world" in i.meta]
    if not pts:
        return None
    arr = np.asarray(pts, dtype=np.float64)
    x, y, w, h = np.median(arr, axis=0)
    return {"x": round(float(x), 1), "y": round(float(y), 1),
            "w": round(float(w), 1), "h": round(float(h), 1)}


def _track_confidence(track: Track, min_hits: int) -> float:
    """How much we believe this track is one real object."""
    if not track.items:
        return 0.0
    detect_term = float(np.mean([i.detection.score for i in track.items]))
    id_term = float(np.mean([i.id_confidence for i in track.items]))
    # agreement: what share of sightings voted for the winning SKU
    votes = Counter(i.sku for i in track.items)
    agreement = votes[track.sku] / len(track.items)
    persistence = min(1.0, track.hits / max(min_hits, 1))
    return float(np.clip(
        0.35 * detect_term + 0.30 * id_term + 0.20 * agreement + 0.15 * persistence, 0.0, 1.0
    ))


def expected_for(sku: str, cfg: CountConfig, catalog: Catalog,
                 override: dict[str, int] | None) -> int | None:
    """The number this SKU should have come to.

    A per-run expectation (a location's book quantity, a purchase order's
    lines) replaces the global ones outright: a bay's stock has nothing to
    do with the catalog-wide default.
    """
    if override is not None:
        return override.get(sku)
    entry = catalog.by_sku(sku)
    return cfg.expected.get(sku, entry.expected if entry else None)


def count_from_tracks(
    tracks: list[Track], cfg: CountConfig, catalog: Catalog,
    expected: dict[str, int] | None = None,
) -> list[SkuCount]:
    grouped: dict[str, list[Track]] = defaultdict(list)
    for track in tracks:
        if track.hits >= cfg.min_hits:
            grouped[track.sku].append(track)

    counts: list[SkuCount] = []
    for sku, sku_tracks in grouped.items():
        entry = catalog.by_sku(sku)
        confidences = [_track_confidence(t, cfg.min_hits) for t in sku_tracks]
        counts.append(
            SkuCount(
                sku=sku,
                count=len(sku_tracks),
                label=entry.label if entry else sku,
                confidence=float(np.mean(confidences)) if confidences else 0.0,
                expected=expected_for(sku, cfg, catalog, expected),
                evidence={
                    "strategy": "tracking",
                    "tracks": [t.track_id for t in sku_tracks],
                    "mean_hits": round(float(np.mean([t.hits for t in sku_tracks])), 2),
                    "min_confidence": round(min(confidences), 4) if confidences else 0.0,
                },
            )
        )
    return sorted(counts, key=lambda c: c.sku)


def count_per_frame(
    per_frame: dict[int, list[Item]], cfg: CountConfig, catalog: Catalog, how: str,
    expected: dict[str, int] | None = None,
) -> list[SkuCount]:
    """peak_frame / median_frame: aggregate the per-frame tallies."""
    tallies: dict[str, list[int]] = defaultdict(list)
    confidences: dict[str, list[float]] = defaultdict(list)
    skus = {i.sku for items in per_frame.values() for i in items}
    for items in per_frame.values():
        frame_counts = Counter(i.sku for i in items)
        for sku in skus:
            tallies[sku].append(frame_counts.get(sku, 0))
        for item in items:
            confidences[item.sku].append(
                0.5 * item.detection.score + 0.5 * item.id_confidence
            )

    counts = []
    for sku, series in tallies.items():
        value = max(series) if how == "peak_frame" else int(round(statistics.median(series)))
        if value <= 0:
            continue
        entry = catalog.by_sku(sku)
        spread = (max(series) - min(series)) if series else 0
        # Wide frame-to-frame disagreement is itself evidence of uncertainty.
        stability = 1.0 / (1.0 + spread / max(value, 1))
        base = float(np.mean(confidences[sku])) if confidences[sku] else 0.0
        counts.append(
            SkuCount(
                sku=sku,
                count=value,
                label=entry.label if entry else sku,
                confidence=float(np.clip(0.7 * base + 0.3 * stability, 0.0, 1.0)),
                expected=expected_for(sku, cfg, catalog, expected),
                evidence={
                    "strategy": how,
                    "per_frame_min": min(series),
                    "per_frame_max": max(series),
                    "frames": len(series),
                },
            )
        )
    return sorted(counts, key=lambda c: c.sku)


def finalise(
    result: CountResult,
    tracks: list[Track],
    per_frame: dict[int, list[Item]],
    cfg: CountConfig,
    catalog: Catalog,
    expected: dict[str, int] | None = None,
) -> CountResult:
    if cfg.strategy == "tracking":
        result.counts = count_from_tracks(tracks, cfg, catalog, expected)
    elif cfg.strategy in ("peak_frame", "median_frame"):
        result.counts = count_per_frame(per_frame, cfg, catalog, cfg.strategy, expected)
    else:
        raise ValueError(
            f"unknown count strategy {cfg.strategy!r}; "
            "choose from tracking, peak_frame, median_frame"
        )
    # An expected SKU that was never seen is the worst miss there is (the
    # shelf is empty), and without a row it would have no variance to flag.
    seen = {c.sku for c in result.counts}
    wanted = expected if expected is not None else {
        **catalog.expected_counts(), **cfg.expected
    }
    for sku, qty in sorted(wanted.items()):
        if sku in seen or qty is None:
            continue
        entry = catalog.by_sku(sku)
        result.counts.append(
            SkuCount(
                sku=sku,
                count=0,
                label=entry.label if entry else sku,
                # Nothing was seen, so there is no identification to doubt;
                # the variance, not the confidence, is what flags this row.
                confidence=1.0,
                expected=int(qty),
                evidence={"strategy": "not_seen"},
            )
        )
    result.counts.sort(key=lambda c: c.sku)
    result.tracks = len(tracks)
    if result.counts:
        total = sum(c.count for c in result.counts) or 1
        # Weight by count: being unsure about 40 units matters more than
        # being unsure about one.
        result.overall_confidence = sum(c.confidence * c.count for c in result.counts) / total
    return result
