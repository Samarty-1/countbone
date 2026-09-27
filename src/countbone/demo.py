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


# A range the colour identifier cannot separate: four red cartons told apart
# only by their artwork, plus one blue. This is what a real shelf looks like to
# a hue histogram (one brand, one colour, many products).
LOOKALIKE_SKUS: dict[str, dict] = {
    "RED-PLAIN": {"label": "Red carton, plain", "color": (40, 40, 205), "art": "plain"},
    "RED-STRIPE": {"label": "Red carton, stripes", "color": (40, 40, 205), "art": "stripes"},
    "RED-DOT": {"label": "Red carton, black dot", "color": (40, 40, 205), "art": "dot"},
    "RED-BAND": {"label": "Red carton, dark band", "color": (40, 40, 205), "art": "band"},
    "BLU-PLAIN": {"label": "Blue carton", "color": (200, 110, 40), "art": "plain"},
}


def draw_carton(board: np.ndarray, x1: int, y1: int, x2: int, y2: int,
                color: tuple[int, int, int], art: str = "plain") -> None:
    """One carton: body, outline, a white label patch, and its artwork."""
    cv2.rectangle(board, (x1, y1), (x2, y2), color, -1)
    cv2.rectangle(board, (x1, y1), (x2, y2), (30, 30, 30), 3)
    cv2.rectangle(board, (x1 + 16, y1 + 24), (x2 - 16, y1 + 52), (235, 235, 235), -1)
    w, h = x2 - x1, y2 - y1
    if art == "stripes":
        for k in range(3):
            sx = x1 + int(w * (0.22 + 0.25 * k))
            cv2.rectangle(board, (sx, y1 + 62), (sx + max(4, w // 12), y2 - 8), (235, 235, 235), -1)
    elif art == "dot":
        cv2.circle(board, (x1 + w // 2, y1 + int(h * 0.68)), max(6, int(w * 0.24)), (25, 25, 25), -1)
    elif art == "band":
        cv2.rectangle(board, (x1 + 4, y1 + int(h * 0.62)), (x2 - 4, y1 + int(h * 0.78)), (30, 30, 90), -1)


@dataclass
class DemoScene:
    path: str
    truth: dict[str, int]
    frames: int
    fps: int
    shelf_size: tuple[int, int]
    # Every carton on the board, for tests that check where things are
    # (shelf gaps, cross-video merging): (sku, x1, y1, x2, y2) in board pixels.
    layout: list[tuple[str, int, int, int, int]] | None = None
    # Empty slots between cartons, same coordinates: (row_top, x1, x2).
    empty_slots: list[tuple[int, int, int]] | None = None
    view_x: tuple[int, int] = (0, 0)  # the board range the pan covered

    @property
    def total(self) -> int:
        return sum(self.truth.values())


def _lookalike_shelf(width: int, height: int, rng: random.Random):
    board = np.full((height, width, 3), 168, dtype=np.uint8)
    noise = np.random.default_rng(rng.randint(0, 2**31)).normal(0, 6, board.shape)
    board = np.clip(board.astype(np.float64) + noise, 0, 255).astype(np.uint8)
    for y in (height // 3, 2 * height // 3):
        cv2.rectangle(board, (0, y - 6), (width, y + 6), (120, 120, 120), -1)
    truth: dict[str, int] = {}
    layout, empty = [], []
    box_w, box_h, gap_x, gap_y = 96, 132, 46, 40
    tops = [20, height // 3 + 20, 2 * height // 3 + 20]
    x = 40
    while x + box_w < width - 40:
        for top in tops:
            if rng.random() < 0.15:
                empty.append((top, x, x + box_w))
                continue
            sku = rng.choice(list(LOOKALIKE_SKUS))
            spec = LOOKALIKE_SKUS[sku]
            j = rng.randint(-6, 6)
            x1, y1, x2, y2 = x + j, top, x + j + box_w, top + box_h - gap_y // 2
            draw_carton(board, x1, y1, x2, y2, spec["color"], spec["art"])
            truth[sku] = truth.get(sku, 0) + 1
            layout.append((sku, x1, y1, x2, y2))
        x += box_w + gap_x
    return board, truth, layout, empty


def product_photos(sku: str, n: int = 5, seed: int = 0) -> list[np.ndarray]:
    """What a person enrolling a look-alike SKU would photograph with a phone.

    Close up, a bit rotated, on a random background, with phone-camera
    exposure and softness. Deliberately unlike the shelf video, so enrolment
    is tested across the domain gap it faces in practice.
    """
    spec = LOOKALIKE_SKUS.get(sku) or {"color": SKU_COLORS[sku], "art": "plain"}
    rng = np.random.default_rng(seed)
    photos = []
    for _ in range(n):
        canvas = np.full((460, 380, 3), rng.integers(60, 220, 3), dtype=np.uint8)
        canvas = np.clip(canvas + rng.normal(0, 8, canvas.shape), 0, 255).astype(np.uint8)
        # The same carton as on the shelf, photographed closer: drawn at shelf
        # scale, then enlarged, so its proportions are the product's own.
        small = np.full((120, 104, 3), 168, np.uint8)
        draw_carton(small, 4, 4, 100, 116, spec["color"], spec["art"])
        art = cv2.resize(small, (250, 340), interpolation=cv2.INTER_CUBIC)
        angle = rng.uniform(-6, 6)
        m = cv2.getRotationMatrix2D((125, 170), angle, rng.uniform(0.95, 1.05))
        art = cv2.warpAffine(art, m, (250, 340), borderMode=cv2.BORDER_REPLICATE)
        ox, oy = int(rng.integers(40, 90)), int(rng.integers(40, 90))
        canvas[oy : oy + 340, ox : ox + 250] = art
        gain = rng.uniform(0.8, 1.2)
        canvas = np.clip(canvas.astype(np.float32) * gain, 0, 255).astype(np.uint8)
        photo = canvas[oy - 12 : oy + 352, ox - 12 : ox + 262]  # the user framed it roughly
        photos.append(cv2.GaussianBlur(photo, (3, 3), 0))
    return photos


def _shelf(width: int, height: int, rng: random.Random):
    """Paint a shelf wall with evenly spaced cartons.

    Returns the board, the truth per SKU, every carton's box and every empty
    slot. (The random sequence is unchanged from the first version, so a seed
    still renders the same shelf.)
    """
    board = np.full((height, width, 3), 168, dtype=np.uint8)
    noise = np.random.default_rng(rng.randint(0, 2**31)).normal(0, 6, board.shape)
    board = np.clip(board.astype(np.float64) + noise, 0, 255).astype(np.uint8)

    # shelf edges, so the scene is not just floating boxes
    for y in (height // 3, 2 * height // 3):
        cv2.rectangle(board, (0, y - 6), (width, y + 6), (120, 120, 120), -1)

    truth: dict[str, int] = {}
    layout: list[tuple[str, int, int, int, int]] = []
    empty: list[tuple[int, int, int]] = []
    box_w, box_h = 96, 132
    gap_x, gap_y = 46, 40
    top_offsets = [20, height // 3 + 20, 2 * height // 3 + 20]
    x = 40
    while x + box_w < width - 40:
        for top in top_offsets:
            if rng.random() < 0.18:  # a few empty slots keeps it honest
                empty.append((top, x, x + box_w))
                continue
            sku = rng.choice(list(SKU_COLORS))
            color = SKU_COLORS[sku]
            jitter = rng.randint(-6, 6)
            x1, y1 = x + jitter, top
            x2, y2 = x1 + box_w, y1 + box_h - gap_y // 2
            draw_carton(board, x1, y1, x2, y2, color)
            truth[sku] = truth.get(sku, 0) + 1
            layout.append((sku, x1, y1, x2, y2))
        x += box_w + gap_x
    return board, truth, layout, empty


def make_demo_video(
    path: str | Path = "examples/demo_shelf.mp4",
    seed: int = 7,
    fps: int = 24,
    seconds: float = 6.0,
    view: tuple[int, int] = (960, 540),
    bad_frame_rate: float = 0.08,
    palette: str = "primary",
    window: tuple[float, float] = (0.0, 1.0),
    shelf_views: float = 2.2,
) -> DemoScene:
    """Render a pan across a synthetic shelf. Returns the ground truth with it.

    `bad_frame_rate` blurs a fraction of frames, so the quality gate has
    something real to reject. `palette="lookalike"` paints products that differ
    only in artwork. `window` pans across only part of the shelf (as fractions
    of the full pan): two overlapping windows of the same seed are two videos
    of one shelf, filmed by two people or twice. Shorter `seconds` pan faster.
    """
    rng = random.Random(seed)
    view_w, view_h = view
    shelf_w, shelf_h = int(view_w * shelf_views), view_h
    if palette == "primary":
        board, _, layout, empty = _shelf(shelf_w, shelf_h, rng)
    elif palette == "lookalike":
        board, _, layout, empty = _lookalike_shelf(shelf_w, shelf_h, rng)
    else:
        raise ValueError(f"unknown palette {palette!r}; choose primary or lookalike")

    out_path = Path(path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    frames = int(fps * seconds)
    travel = shelf_w - view_w
    start, end = int(window[0] * travel), int(window[1] * travel)
    # What this video can see: cartons wholly inside the covered range count.
    seen_lo, seen_hi = start, end + view_w
    truth: dict[str, int] = {}
    for sku, x1, _, x2, _ in layout:
        if x1 >= seen_lo and x2 <= seen_hi:
            truth[sku] = truth.get(sku, 0) + 1

    writer, out_path = _open_writer(out_path, fps, view_w, view_h)
    try:
        for i in range(frames):
            # ease-in-out pan: a human hand does not move linearly
            t = i / max(frames - 1, 1)
            eased = 3 * t**2 - 2 * t**3
            x = start + int(eased * (end - start))
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
        layout=[c for c in layout if c[1] >= seen_lo and c[3] <= seen_hi],
        empty_slots=empty,
        view_x=(seen_lo, seen_hi),
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
