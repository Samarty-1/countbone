"""Stage 1 — Capture. Turn a video source into a stream of sampled frames."""

from __future__ import annotations

import logging
from collections.abc import Iterator
from pathlib import Path

import cv2
import numpy as np

from ..config import CaptureConfig
from ..types import Frame

log = logging.getLogger(__name__)


class CaptureError(RuntimeError):
    pass


def open_source(source: str | int) -> cv2.VideoCapture:
    if isinstance(source, str) and not source.isdigit():
        if not Path(source).exists():
            raise CaptureError(f"video source not found: {source}")
        cap = cv2.VideoCapture(source)
    else:
        cap = cv2.VideoCapture(int(source))
    if not cap.isOpened():
        raise CaptureError(f"could not open video source: {source}")
    return cap


def probe(source: str | int) -> dict:
    """Metadata without decoding the whole file."""
    cap = open_source(source)
    try:
        fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
        frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        return {
            "fps": round(fps, 3),
            "frame_count": frames,
            "width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
            "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
            "duration_s": round(frames / fps, 3) if fps > 0 else None,
        }
    finally:
        cap.release()


def read_frame(source: str, source_index: int, resize_width: int | None = None) -> np.ndarray | None:
    """One frame by its index in the source, at pipeline resolution.

    For after-the-fact evidence (a shelf gap, a dataset image): the pipeline
    keeps no pixels once a frame has gone past, and the source is on disk.
    Reads forward rather than seeking, because frame-accurate seeking is
    unreliable across codecs and a wrong frame would be wrong evidence.
    """
    cap = open_source(source)
    try:
        for _ in range(source_index + 1):
            ok, image = cap.read()
            if not ok:
                return None
        return _resize(image, resize_width)
    finally:
        cap.release()


def _timestamp(cap: cv2.VideoCapture, source_index: int, fps: float) -> float:
    """When the frame just read is shown, in seconds from the start.

    Phones record variable frame rate, so index / average-fps drifts: on a
    VFR clip it was measured over a second out, which puts the frame
    inspector's boxes on the wrong carton. The container's own timestamp is
    right for both constant and variable rate. Some backends (cameras) report
    0 for every frame; then the old estimate is all there is.
    """
    pos = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
    if pos > 0 or source_index == 0:
        return pos
    return source_index / fps if fps > 0 else float(source_index)


def _resize(image: np.ndarray, width: int | None) -> np.ndarray:
    if width and image.shape[1] > width:
        scale = width / image.shape[1]
        return cv2.resize(
            image,
            (width, max(1, int(round(image.shape[0] * scale)))),
            interpolation=cv2.INTER_AREA,
        )
    return image


PROBE_WIDTH = 160  # the look-ahead shift check runs on a thumbnail


def _thumb(image: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    scale = PROBE_WIDTH / gray.shape[1]
    small = cv2.resize(
        gray, (PROBE_WIDTH, max(1, int(round(gray.shape[0] * scale)))),
        interpolation=cv2.INTER_AREA,
    )
    return small.astype(np.float32)


class Sampler:
    """Decides which source frames become pipeline frames, and adapts.

    A fixed stride is blind to the two things that break counting: the
    camera moving further between samples than the tracker can follow, and
    the quality gate rejecting a sample, which silently doubles the gap to
    the next one. At a fixed stride of 5 both cost real cartons (an item at
    the aisle's edge seen in one usable frame is discarded as noise).

    So sampling is closed-loop:

    * look-ahead: before a sample is emitted, a thumbnail phase correlation
      measures how far the scene moved since the last emitted frame. If that
      is more than `max_shift_frac` of an object's width, the skipped frames
      in between are emitted first (they are still in memory), so no gap the
      tracker has to bridge is ever that large;
    * the stride shrinks toward whatever keeps the shift near `target_shift_frac`
      of an object width, and grows back to `every_n_frames` when the camera
      slows;
    * after the pipeline drops a frame, the very next source frame is taken,
      instead of waiting a whole stride.

    Decoding already reads every frame, so this costs thumbnails, not I/O.
    """

    def __init__(self, cfg: CaptureConfig) -> None:
        self.base = max(1, int(cfg.every_n_frames))
        self.adaptive = bool(cfg.adaptive)
        self.target_shift_frac = float(cfg.target_shift_frac)
        self.max_shift_frac = float(cfg.max_shift_frac)
        self.step = self.base
        self.retry = False
        self.box_px: float | None = None     # a typical object width, fed back by the pipeline
        self.frame_width: int | None = None
        self.truncated = False
        self.stats = {"emitted": 0, "backfilled": 0, "retries": 0, "min_step": self.base}
        self._speed: float | None = None     # px per source frame, smoothed
        self._window: np.ndarray | None = None

    # -- feedback from the pipeline --------------------------------------
    def feedback(self, kept: bool, box_px: float | None = None) -> None:
        if box_px and box_px > 0:
            self.box_px = float(box_px)
        if not self.adaptive:
            return
        if not kept:
            self.retry = True
            self.stats["retries"] += 1
        else:
            self.retry = False

    # -- decisions -------------------------------------------------------
    def _object_px(self) -> float:
        if self.box_px:
            return self.box_px
        # Before the first detection: assume objects about a tenth of the frame.
        return 0.1 * (self.frame_width or PROBE_WIDTH * 6)

    def due(self, gap: int) -> bool:
        """Is the frame `gap` source frames after the last emitted one due?"""
        if not self.adaptive:
            return gap >= self.base
        return self.retry or gap >= self.step

    def shift(self, prev: np.ndarray, curr: np.ndarray, gap: int) -> float | None:
        """Scene shift between two thumbnails, in full-resolution pixels.

        None when it cannot be trusted: a weak correlation, or an answer the
        recent speed says is implausible (a repeating shelf can alias a big
        move into a small one).
        """
        if prev.shape != curr.shape:
            return None
        if self._window is None or self._window.shape != curr.shape:
            self._window = cv2.createHanningWindow((curr.shape[1], curr.shape[0]), cv2.CV_32F)
        (dx, dy), response = cv2.phaseCorrelate(prev, curr, self._window)
        if response < 0.1:
            return None
        scale = (self.frame_width or PROBE_WIDTH) / PROBE_WIDTH
        moved = float(np.hypot(dx, dy)) * scale
        if self._speed is not None and gap > 0:
            predicted = self._speed * gap
            if predicted > 0.5 * self._object_px() and moved < 0.4 * predicted:
                return None
        return moved

    def observe(self, moved: float | None, gap: int) -> None:
        """Adapt the stride from the measured speed."""
        if not self.adaptive or gap <= 0:
            return
        if moved is None:
            self.step = 1
        else:
            speed = moved / gap
            self._speed = speed if self._speed is None else 0.5 * self._speed + 0.5 * speed
            target = self.target_shift_frac * self._object_px()
            ideal = int(target / max(self._speed, 1e-6))
            self.step = int(min(self.base, max(1, ideal)))
        self.stats["min_step"] = min(self.stats["min_step"], self.step)

    def too_far(self, moved: float | None) -> bool:
        return moved is None or moved > self.max_shift_frac * self._object_px()


def frames(
    source: str | int, cfg: CaptureConfig, sampler: Sampler | None = None
) -> Iterator[Frame]:
    """Yield sampled, optionally downscaled frames.

    Sampling is by frame index rather than by time so that a variable-rate
    file still gives an even spread of the shelf. Pass a Sampler (and feed it
    back) for closed-loop sampling; without one the stride is fixed.
    """
    cap = open_source(source)
    fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
    sampler = sampler or Sampler(CaptureConfig(**{**cfg.__dict__, "adaptive": False}))
    emitted = 0
    source_index = -1
    last_index: int | None = None
    last_thumb: np.ndarray | None = None
    # Frames skipped since the last emitted one, kept so a gap that turns out
    # too wide can be filled in after the fact. Bounded by the stride.
    skipped: list[tuple[int, float, np.ndarray]] = []

    def make(idx: int, ts: float, image: np.ndarray, gap: int, backfill: bool) -> Frame:
        nonlocal emitted
        frame = Frame(
            index=emitted,
            source_index=idx,
            timestamp_s=round(ts, 4),
            image=image,
            meta={"fps": round(fps, 3), "gap": gap, "backfill": backfill},
        )
        emitted += 1
        sampler.stats["emitted"] = emitted
        return frame

    try:
        while True:
            ok, image = cap.read()
            if not ok:
                break
            source_index += 1
            ts = _timestamp(cap, source_index, fps)
            if ts < cfg.start_s:
                continue
            if cfg.end_s is not None and ts > cfg.end_s:
                break
            image = _resize(image, cfg.resize_width)
            if sampler.frame_width is None:
                sampler.frame_width = image.shape[1]

            gap = source_index - last_index if last_index is not None else 0
            if last_index is not None and not sampler.due(gap):
                skipped.append((source_index, ts, image))
                # Only frames since the last emission are useful for backfill.
                if len(skipped) > sampler.base:
                    skipped.pop(0)
                continue

            thumb = _thumb(image) if sampler.adaptive else None
            to_emit: list[tuple[int, float, np.ndarray, bool]] = []
            if last_thumb is not None and thumb is not None:
                moved = sampler.shift(last_thumb, thumb, gap)
                if skipped and sampler.too_far(moved):
                    to_emit = [(i, t, img, True) for i, t, img in skipped]
                    sampler.stats["backfilled"] += len(skipped)
                sampler.observe(moved, gap)
            to_emit.append((source_index, ts, image, False))
            skipped = []

            for idx, t, img, backfill in to_emit:
                frame_gap = idx - last_index if last_index is not None else 0
                yield make(idx, t, img, frame_gap, backfill)
                last_index = idx
                if cfg.max_frames and emitted >= cfg.max_frames:
                    sampler.truncated = True
                    log.warning("capture stopped at max_frames=%d", cfg.max_frames)
                    return
            last_thumb = thumb
    finally:
        cap.release()
