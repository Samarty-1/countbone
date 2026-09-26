"""Synthetic stock footage, so the pipeline can be run and tested anywhere.

A fixed camera pans across a shelf of coloured cartons. The ground truth is
returned alongside the file, which is what makes it useful in tests: the
pipeline can be scored, not just executed.
"""

from __future__ import annotations

import contextlib
import os
import random
import sys
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

SKU_COLORS: dict[str, tuple[int, int, int]] = {
    # BGR, chosen to sit in the middle of the default catalog's hue bands
    "SKU-RED": (40, 40, 205),
    "SKU-YEL": (40, 200, 225),
    "SKU-GRN": (60, 170, 60),
    "SKU-BLU": (200, 110, 40),
}


@dataclass
class DemoScene:
    path: str
    truth: dict[str, int]
    frames: int
    fps: int
    shelf_size: tuple[int, int]

    @property
    def total(self) -> int:
        return sum(self.truth.values())


def _shelf(width: int, height: int, rng: random.Random) -> tuple[np.ndarray, dict[str, int]]:
    """Paint a shelf wall with evenly spaced cartons."""
    board = np.full((height, width, 3), 168, dtype=np.uint8)
    noise = np.random.default_rng(rng.randint(0, 2**31)).normal(0, 6, board.shape)
    board = np.clip(board.astype(np.float64) + noise, 0, 255).astype(np.uint8)

    # shelf edges, so the scene is not just floating boxes
    for y in (height // 3, 2 * height // 3):
        cv2.rectangle(board, (0, y - 6), (width, y + 6), (120, 120, 120), -1)

    truth: dict[str, int] = {}
    box_w, box_h = 96, 132
    gap_x, gap_y = 46, 40
    top_offsets = [20, height // 3 + 20, 2 * height // 3 + 20]
    x = 40
    while x + box_w < width - 40:
        for top in top_offsets:
            if rng.random() < 0.18:  # a few empty slots keeps it honest
                continue
            sku = rng.choice(list(SKU_COLORS))
            color = SKU_COLORS[sku]
            jitter = rng.randint(-6, 6)
            x1, y1 = x + jitter, top
            x2, y2 = x1 + box_w, y1 + box_h - gap_y // 2
            cv2.rectangle(board, (x1, y1), (x2, y2), color, -1)
            cv2.rectangle(board, (x1, y1), (x2, y2), (30, 30, 30), 3)
            # a label patch, so the box is not a flat colour field
            cv2.rectangle(
                board, (x1 + 16, y1 + 24), (x2 - 16, y1 + 52), (235, 235, 235), -1
            )
            truth[sku] = truth.get(sku, 0) + 1
        x += box_w + gap_x
    return board, truth


def make_demo_video(
    path: str | Path = "examples/demo_shelf.mp4",
    seed: int = 7,
    fps: int = 24,
    seconds: float = 6.0,
    view: tuple[int, int] = (960, 540),
    bad_frame_rate: float = 0.08,
) -> DemoScene:
    """Render a pan across a synthetic shelf. Returns the ground truth with it.

    `bad_frame_rate` blurs a fraction of frames, so the quality gate has
    something real to reject.
    """
    rng = random.Random(seed)
    view_w, view_h = view
    shelf_w, shelf_h = int(view_w * 2.2), view_h
    board, truth = _shelf(shelf_w, shelf_h, rng)

    out_path = Path(path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    frames = int(fps * seconds)

    writer, out_path = _open_writer(out_path, fps, view_w, view_h)
    try:
        travel = shelf_w - view_w
        for i in range(frames):
            # ease-in-out pan: a human hand does not move linearly
            t = i / max(frames - 1, 1)
            eased = 3 * t**2 - 2 * t**3
            x = int(eased * travel)
            frame = board[0:view_h, x : x + view_w].copy()
            if rng.random() < bad_frame_rate:
                frame = cv2.GaussianBlur(frame, (21, 21), 0)
            writer.write(frame)
    finally:
        writer.release()

    return DemoScene(
        path=str(out_path),
        truth=truth,
        frames=frames,
        fps=fps,
        shelf_size=(shelf_w, shelf_h),
    )


@contextlib.contextmanager
def _native_stderr_silenced():
    """Point file descriptor 2 at the null device for the duration.

    Python-level redirection cannot catch output written by C libraries, so
    this swaps the descriptor itself, and always restores it.
    """
    try:
        sys.stderr.flush()
        saved = os.dup(2)
    except (OSError, ValueError):  # no real stderr (e.g. some IDE consoles)
        yield
        return
    devnull = os.open(os.devnull, os.O_WRONLY)
    try:
        os.dup2(devnull, 2)
        yield
    finally:
        os.dup2(saved, 2)
        os.close(saved)
        os.close(devnull)


def _open_writer(path: Path, fps: int, w: int, h: int):
    """A format a browser can play if this OpenCV build can write one.

    The dashboard's frame inspector plays the source video, and no browser
    plays OpenCV's usual mp4v. VP8 WebM is written by the pip wheels and
    played by every current browser. (H.264 would be nicer, but the wheels
    ship no encoder and probing for one prints codec errors on every run.)
    mp4v and MJPG remain as last resorts. Never fail silently.
    """
    attempts = [
        (path.with_suffix(".webm"), "VP80"),
        (path.with_suffix(".mp4"), "mp4v"),
        (path.with_suffix(".avi"), "MJPG"),
    ]
    for candidate, fourcc in attempts:
        # FFmpeg prints a harmless "tag VP80 is not supported ... webm" notice
        # from native code while it picks the right tag itself; keep it off
        # the user's terminal. Failures still surface through isOpened().
        with _native_stderr_silenced():
            writer = cv2.VideoWriter(
                str(candidate), cv2.VideoWriter_fourcc(*fourcc), fps, (w, h)
            )
        if writer.isOpened():
            return writer, candidate
        writer.release()
    raise RuntimeError(
        "OpenCV could not open any video writer (tried VP80, mp4v and MJPG); "
        "install a build of opencv with video support"
    )
