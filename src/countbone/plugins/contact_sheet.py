"""Output-layer plugin: one picture of every object that was counted.

A count is easiest to trust, and hardest to dispute, when every unit behind
the number can be seen. For each counted object this keeps its clearest
sighting, writes it to tracks/, and lays them out on a contact sheet
grouped by SKU. The sheet goes into the audit pack (it is written before
the pack is hashed) and into evidence packs.
"""

from __future__ import annotations

from typing import Any

import cv2
import numpy as np

from ..context import RunContext
from ..types import CountResult
from .base import Plugin, register

THUMB_H = 96


@register
class ContactSheet(Plugin):
    """Save the clearest crop of each counted object and a contact sheet."""

    name = "contact_sheet"
    layer = "output"
    priority = 80  # after the review queue and exception report, before the audit pack

    def configure(self, max_objects: int = 600, columns: int = 12, save_tracks: bool = True,
                  **_: Any) -> None:
        self.max_objects = int(max_objects)
        self.columns = int(columns)
        self.save_tracks = bool(save_tracks)

    def on_frame_tracked(self, ctx: RunContext, frame, items) -> None:
        best: dict[int, tuple[float, np.ndarray]] = ctx.setdefault("contact_best", dict)
        h, w = frame.image.shape[:2]
        for item in items:
            tid = item.track_id
            if tid is None:
                continue
            score = item.confidence
            if tid in best and best[tid][0] >= score:
                continue
            x1, y1, x2, y2 = item.detection.bbox
            xi1, yi1 = max(0, int(x1)), max(0, int(y1))
            xi2, yi2 = min(w, int(round(x2))), min(h, int(round(y2)))
            if xi2 - xi1 < 4 or yi2 - yi1 < 4:
                continue
            crop = frame.image[yi1:yi2, xi1:xi2]
            scale = THUMB_H / crop.shape[0]
            thumb = cv2.resize(crop, (max(8, int(crop.shape[1] * scale)), THUMB_H),
                               interpolation=cv2.INTER_AREA)
            best[tid] = (score, thumb)
            if len(best) > self.max_objects * 3:
                # Bounded: forget the weakest of the uncounted-so-far.
                worst = min(best, key=lambda k: best[k][0])
                del best[worst]

    def on_tracks(self, ctx: RunContext, tracks):
        ctx.state["contact_counted"] = {
            t.track_id: t.sku for t in tracks if t.hits >= ctx.config.count.min_hits
        }
        return tracks

    def on_output(self, ctx: RunContext, result: CountResult) -> None:
        best: dict[int, tuple[float, np.ndarray]] = ctx.state.get("contact_best", {})
        counted: dict[int, str] = ctx.state.get("contact_counted", {})
        rows = [(sku, tid, best[tid][1]) for tid, sku in sorted(counted.items(), key=lambda kv: (kv[1], kv[0]))
                if tid in best][: self.max_objects]
        if not rows:
            return
        out = ctx.artifacts_dir
        if self.save_tracks:
            (out / "tracks").mkdir(exist_ok=True)
            for sku, tid, img in rows:
                cv2.imwrite(str(out / "tracks" / f"t{tid:05d}_{sku}.jpg"), img)
        sheet = self._sheet(rows)
        cv2.imwrite(str(out / "contact_sheet.jpg"), sheet, [cv2.IMWRITE_JPEG_QUALITY, 88])
        result.meta.setdefault("outputs", {})["contact_sheet"] = str(out / "contact_sheet.jpg")
        result.meta["contact_sheet"] = {"objects": len(rows)}

    def _sheet(self, rows: list[tuple[str, int, np.ndarray]]) -> np.ndarray:
        cell_w, label_h, pad = 84, 18, 6
        cells = []
        for sku, tid, img in rows:
            cell = np.full((THUMB_H + label_h, cell_w, 3), 245, np.uint8)
            im = img[:, : cell_w] if img.shape[1] > cell_w else img
            x0 = (cell_w - im.shape[1]) // 2
            cell[:THUMB_H, x0 : x0 + im.shape[1]] = im
            text = f"{sku} #{tid}"
            cv2.putText(cell, text[:14], (3, THUMB_H + 13), cv2.FONT_HERSHEY_SIMPLEX, 0.36,
                        (30, 30, 30), 1, cv2.LINE_AA)
            cells.append(cell)
        cols = min(self.columns, len(cells))
        nrows = (len(cells) + cols - 1) // cols
        h = nrows * (THUMB_H + label_h + pad) + pad
        w = cols * (cell_w + pad) + pad
        sheet = np.full((h, w, 3), 255, np.uint8)
        for i, cell in enumerate(cells):
            r, c = divmod(i, cols)
            y, x = pad + r * (THUMB_H + label_h + pad), pad + c * (cell_w + pad)
            sheet[y : y + cell.shape[0], x : x + cell.shape[1]] = cell
        return sheet
