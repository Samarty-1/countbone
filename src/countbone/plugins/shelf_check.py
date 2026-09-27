"""Analytics-layer plugin: empty shelf space and layout, from the same walk.

A count says how many; a shelf check says where the holes are. Both come
from one video, so a customer buying counts gets gap detection for no extra
filming.

Gaps: counted objects are grouped into shelf rows by height, sorted along
the shelf (world coordinates, so camera motion is already removed), and any
stretch between neighbours wider than a typical gap plus most of an object
is empty facing space. Stretches at a row's ends count too when other rows
show the shelf continues there. Each gap gets a photo: the frame where it
was nearest the middle of the view, re-read from the source and marked.

Layout: if the location has a planogram (the intended SKU order per row,
top row first), each observed row is aligned to its planned row and the
differences named: a missing facing, a wrong product in a slot, an
unexpected extra.
"""

from __future__ import annotations

import difflib
import json
from typing import Any

import cv2
import numpy as np

from ..context import RunContext
from ..stages.capture import read_frame
from ..types import CountResult
from .base import Plugin, register


def rows_of(objects: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Cluster objects into shelf rows by vertical position, top row first."""
    if not objects:
        return []
    med_h = float(np.median([o["h"] for o in objects]))
    ordered = sorted(objects, key=lambda o: o["y"])
    rows: list[list[dict[str, Any]]] = [[ordered[0]]]
    for o in ordered[1:]:
        if o["y"] - np.mean([p["y"] for p in rows[-1]]) > 0.5 * med_h:
            rows.append([o])
        else:
            rows[-1].append(o)
    return [sorted(r, key=lambda o: o["x"]) for r in rows]


def find_gaps(objects: list[dict[str, Any]], min_fill: float = 0.8) -> list[dict[str, Any]]:
    rows = rows_of(objects)
    if not rows or len(objects) < 4:
        return []
    med_w = float(np.median([o["w"] for o in objects]))
    spacings = [b["x"] - b["w"] / 2 - (a["x"] + a["w"] / 2)
                for r in rows for a, b in zip(r, r[1:], strict=False)]
    typical = float(np.median(spacings)) if spacings else 0.2 * med_w
    typical = max(0.0, typical)
    pitch = med_w + typical
    threshold = typical + min_fill * med_w
    # The shelf's extent, from every row: a short row next to longer ones
    # is missing its end facings; a row can only be judged against others.
    lo = min(o["x"] - o["w"] / 2 for o in objects)
    hi = max(o["x"] + o["w"] / 2 for o in objects)
    gaps = []
    for ri, row in enumerate(rows):
        y = float(np.median([o["y"] for o in row]))
        h = float(np.median([o["h"] for o in row]))
        # Sweep left to right. The shelf's ends act as virtual neighbours one
        # typical gap beyond the outermost objects seen in any row.
        edge, left = lo - typical, None
        for right in [*row, None]:
            start = hi + typical if right is None else right["x"] - right["w"] / 2
            span = start - edge
            if span > threshold and not (left is None and right is None):
                gaps.append({
                    "row": ri,
                    "x1": round(edge + (typical if left is None else 0.0), 1),
                    "x2": round(start - (typical if right is None else 0.0), 1),
                    "y": round(y, 1), "h": round(h, 1),
                    "missing_facings": max(1, int(round((span - typical) / pitch))),
                    "between": [left["sku"] if left else None, right["sku"] if right else None],
                    # Row-end gaps rest on other rows showing the shelf goes on;
                    # at a video's edge that is weaker evidence than an interior gap.
                    "at_row_end": left is None or right is None,
                })
            if right is not None:
                edge, left = right["x"] + right["w"] / 2, right
    return gaps


def check_planogram(rows: list[list[dict[str, Any]]], plan: list[list[str]],
                    gaps: list[dict[str, Any]]) -> dict[str, Any]:
    issues = []
    planned = matched = 0
    for ri, planned_row in enumerate(plan):
        observed = [o["sku"] for o in rows[ri]] if ri < len(rows) else []
        planned += len(planned_row)
        sm = difflib.SequenceMatcher(a=planned_row, b=observed, autojunk=False)
        for op, i1, i2, j1, j2 in sm.get_opcodes():
            if op == "equal":
                matched += i2 - i1
            elif op == "delete":
                for i in range(i1, i2):
                    issues.append({"row": ri, "position": i, "kind": "missing",
                                   "expected": planned_row[i], "found": None})
            elif op == "insert":
                for j in range(j1, j2):
                    issues.append({"row": ri, "position": i1, "kind": "unexpected",
                                   "expected": None, "found": observed[j]})
            else:  # replace
                for k in range(max(i2 - i1, j2 - j1)):
                    exp = planned_row[i1 + k] if i1 + k < i2 else None
                    got = observed[j1 + k] if j1 + k < j2 else None
                    kind = "misplaced" if exp and got else ("missing" if exp else "unexpected")
                    issues.append({"row": ri, "position": i1 + k, "kind": kind,
                                   "expected": exp, "found": got})
    for ri in range(len(plan), len(rows)):
        for o in rows[ri]:
            issues.append({"row": ri, "position": None, "kind": "unexpected",
                           "expected": None, "found": o["sku"]})
    return {"planned_facings": planned, "matching": matched,
            "compliance": round(matched / planned, 4) if planned else None, "issues": issues}


@register
class ShelfCheck(Plugin):
    """Find empty facings and planogram differences from the walk video."""

    name = "shelf_check"
    layer = "analytics"
    priority = 45

    def configure(self, min_fill: float = 0.8, photos: bool = True, max_photos: int = 20,
                  **_: Any) -> None:
        self.min_fill = float(min_fill)
        self.photos = bool(photos)
        self.max_photos = int(max_photos)

    def on_frame_tracked(self, ctx: RunContext, frame, items) -> None:
        views: list[tuple[int, float, float, int, int]] = ctx.setdefault("shelf_views", list)
        ox, oy = frame.meta.get("offset", (0.0, 0.0))
        w, h = frame.shape
        views.append((frame.source_index, float(ox), float(oy), w, h))

    def on_counts(self, ctx: RunContext, result: CountResult) -> CountResult:
        objects = result.meta.get("tracks_world") or []
        unknown = ctx.config.identify.unknown_sku
        objects = [o for o in objects if o["sku"] != unknown] or objects
        gaps = find_gaps(objects, self.min_fill)
        report: dict[str, Any] = {
            "rows": len(rows_of(objects)),
            "objects": len(objects),
            "gaps": gaps,
            "missing_facings": sum(g["missing_facings"] for g in gaps),
        }
        plan = (ctx.state.get("run_context") or {}).get("planogram")
        if plan:
            report["planogram"] = check_planogram(rows_of(objects), plan, gaps)
        if self.photos and gaps:
            self._photos(ctx, gaps)
        (ctx.artifacts_dir / "shelf.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        result.meta["shelf"] = {
            "gaps": len(gaps),
            "missing_facings": report["missing_facings"],
            "compliance": (report.get("planogram") or {}).get("compliance"),
        }
        return result

    def _photos(self, ctx: RunContext, gaps: list[dict[str, Any]]) -> None:
        views = ctx.state.get("shelf_views") or []
        if not views:
            return
        out = ctx.artifacts_dir / "gaps"
        out.mkdir(exist_ok=True)
        cache: dict[int, np.ndarray | None] = {}
        for n, gap in enumerate(gaps[: self.max_photos]):
            gx = (gap["x1"] + gap["x2"]) / 2
            # The view whose centre was closest to the gap: world = image - offset.
            src, ox, oy, w, h = min(views, key=lambda v: abs((v[3] / 2 - v[1]) - gx))
            if src not in cache:
                try:
                    cache[src] = read_frame(ctx.source, src, ctx.config.capture.resize_width)
                except Exception:  # noqa: BLE001 - a photo is a nicety, never a failure
                    cache[src] = None
            img = cache[src]
            if img is None:
                continue
            img = img.copy()
            x1, x2 = int(gap["x1"] + ox), int(gap["x2"] + ox)
            y1, y2 = int(gap["y"] - gap["h"] / 2 + oy), int(gap["y"] + gap["h"] / 2 + oy)
            cv2.rectangle(img, (x1, y1), (x2, y2), (40, 40, 230), 3)
            cv2.putText(img, f"empty x{gap['missing_facings']}", (max(4, x1), max(18, y1 - 6)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (40, 40, 230), 2, cv2.LINE_AA)
            name = f"gap_{n + 1:02d}.jpg"
            cv2.imwrite(str(out / name), img, [cv2.IMWRITE_JPEG_QUALITY, 85])
            gap["photo"] = f"gaps/{name}"
