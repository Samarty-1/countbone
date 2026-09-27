"""Capture-layer plugin: read the bay's QR label from the video itself.

Each bay carries a printed label (see ops.labels) encoding its location
code. Filming it at the start of a walk ties the count to the place without
typing anything. The phone app scans it before recording; this reads it
from the frames too, so:

* a video uploaded without a location still lands on the right bay;
* a video filed under one bay that shows another bay's label is flagged,
  because counting against the wrong book quantity is a silent error.
"""

from __future__ import annotations

from typing import Any

import cv2

from ..context import RunContext
from ..types import CountResult
from .base import Plugin, register

PREFIX = "CB1:LOC:"


def parse_label(text: str) -> str | None:
    text = (text or "").strip()
    if text.upper().startswith(PREFIX):
        code = text[len(PREFIX):].strip()
        return code or None
    return None


def label_payload(code: str) -> str:
    return f"{PREFIX}{code}"


_detector: cv2.QRCodeDetector | None = None


def read_labels_at(image) -> list[tuple[str, tuple[float, float, float, float]]]:
    """Location labels in an image, with where each one is (x1, y1, x2, y2)."""
    global _detector
    if _detector is None:
        _detector = cv2.QRCodeDetector()
    try:
        ok, texts, points, _ = _detector.detectAndDecodeMulti(image)
    except cv2.error:
        return []
    if not ok or points is None:
        return []
    out = []
    for text, quad in zip(texts, points, strict=False):
        code = parse_label(text)
        if code:
            xs, ys = quad[:, 0], quad[:, 1]
            out.append((code, (float(xs.min()), float(ys.min()), float(xs.max()), float(ys.max()))))
    return out


def read_labels(image) -> list[str]:
    return [code for code, _ in read_labels_at(image)]


def find_location(source: str, seconds: float = 8.0, stride: int = 3,
                  width: int = 1280) -> str | None:
    """The first location label in the opening seconds of a video."""
    from ..stages.capture import _resize, open_source

    cap = open_source(source)
    try:
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        limit = int(fps * seconds)
        for i in range(limit):
            ok, image = cap.read()
            if not ok:
                return None
            if i % stride:
                continue
            codes = read_labels(_resize(image, width))
            if codes:
                return codes[0]
    finally:
        cap.release()
    return None


@register
class LocationTag(Plugin):
    """Read bay QR labels in the video and check them against the run's location."""

    name = "location_tag"
    layer = "capture"
    priority = 20

    def configure(self, search_every: int = 3, watch_every: int = 12, **_: Any) -> None:
        self.search_every = max(1, int(search_every))
        self.watch_every = max(1, int(watch_every))

    def on_run_start(self, ctx: RunContext) -> None:
        ctx.state["labels_seen"] = {}
        ctx.state["label_in_view"] = False

    def on_frame(self, ctx: RunContext, frame):
        seen: dict[str, int] = ctx.state.setdefault("labels_seen", {})
        # While a label is in view, look at every frame: its printed squares
        # are box-shaped, and each frame they are not removed from is a frame
        # where the detector may take the label for stock.
        in_view = ctx.state.get("label_in_view", False)
        every = 1 if in_view else (self.watch_every if seen else self.search_every)
        if frame.index % every == 0:
            found = read_labels_at(frame.image)
            ctx.state["label_in_view"] = bool(found)
            if found:
                frame.meta["label_boxes"] = [box for _, box in found]
            for code, _ in found:
                seen.setdefault(code, frame.index)
        return frame

    def on_detections(self, ctx: RunContext, frame, detections):
        boxes = frame.meta.get("label_boxes")
        if not boxes:
            return detections
        keep = []
        for det in detections:
            x1, y1, x2, y2 = det.bbox
            area = max(1e-6, (x2 - x1) * (y2 - y1))
            inside = False
            for bx1, by1, bx2, by2 in boxes:
                # The label's area, grown a little to cover its quiet zone and
                # the printed code beneath it.
                w, h = bx2 - bx1, by2 - by1
                gx1, gy1, gx2, gy2 = bx1 - 0.15 * w, by1 - 0.15 * h, bx2 + 0.15 * w, by2 + 0.45 * h
                ix = max(0.0, min(x2, gx2) - max(x1, gx1))
                iy = max(0.0, min(y2, gy2) - max(y1, gy1))
                if ix * iy / area >= 0.5:
                    inside = True
                    break
            if not inside:
                keep.append(det)
        return keep

    def on_counts(self, ctx: RunContext, result: CountResult) -> CountResult:
        seen: dict[str, int] = ctx.state.get("labels_seen") or {}
        run_ctx = ctx.state.setdefault("run_context", {})
        filed = run_ctx.get("location")
        codes = sorted(seen, key=seen.get)  # in the order they appeared
        result.meta["labels_seen"] = codes
        if not codes:
            return result
        if filed and filed not in codes:
            result.warnings.append(
                f"the video shows the label for {', '.join(codes)} but was filed under {filed}"
            )
            result.needs_review = True
        elif not filed:
            run_ctx["location"] = codes[0]
            run_ctx["location_source"] = "label_in_video"
        if len(codes) > 1:
            result.warnings.append(
                f"labels for {len(codes)} locations appear in one video ({', '.join(codes)}); "
                "film one bay per video so each is counted against its own stock"
            )
            result.needs_review = True
        return result
