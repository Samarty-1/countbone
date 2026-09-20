"""Stage 1 — Capture. Turn a video source into a stream of sampled frames."""

from __future__ import annotations

import logging
from collections.abc import Iterator
from pathlib import Path

import cv2

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


def frames(source: str | int, cfg: CaptureConfig) -> Iterator[Frame]:
    """Yield sampled, optionally downscaled frames.

    Sampling is by frame index rather than by time so that a variable-rate
    file still gives an even spread of the shelf.
    """
    cap = open_source(source)
    fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
    step = max(1, int(cfg.every_n_frames))
    emitted = 0
    source_index = -1

    try:
        while True:
            ok, image = cap.read()
            if not ok:
                break
            source_index += 1
            ts = source_index / fps if fps > 0 else float(source_index)
            if ts < cfg.start_s:
                continue
            if cfg.end_s is not None and ts > cfg.end_s:
                break
            if source_index % step:
                continue
            if cfg.resize_width and image.shape[1] > cfg.resize_width:
                scale = cfg.resize_width / image.shape[1]
                image = cv2.resize(
                    image,
                    (cfg.resize_width, max(1, int(round(image.shape[0] * scale)))),
                    interpolation=cv2.INTER_AREA,
                )
            yield Frame(
                index=emitted,
                source_index=source_index,
                timestamp_s=round(ts, 4),
                image=image,
                meta={"fps": round(fps, 3)},
            )
            emitted += 1
            if cfg.max_frames and emitted >= cfg.max_frames:
                log.info("capture stopped at max_frames=%d", cfg.max_frames)
                break
    finally:
        cap.release()
