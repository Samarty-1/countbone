"""Training data from real counts: the data engine behind Count-as-a-Service.

Every counted video is labelled footage: boxes from the detector, identities
from the identifier, and corrections from people. Exported as COCO (the
format every detection trainer reads), it is what a learned detector and
identifier for real shelves get trained on.

Only runs whose customer consented (a service job with data consent) are
exported unless an admin explicitly asks for all runs, and a reviewer's
decision always overrides the machine's label.
"""

from __future__ import annotations

import io
import json
import zipfile
from typing import Any

import cv2

from ..stages.capture import read_frame
from . import Services
from .final import _meta


def _labels_by_track(run: dict[str, Any]) -> dict[int, str | None]:
    """Reviewer overrides per track: a SKU, or None for 'not an item'."""
    out: dict[int, str | None] = {}
    for r in run.get("reviews") or []:
        meta = _meta(r)
        if meta.get("scope") != "item" or meta.get("track_id") is None or r["status"] == "pending":
            continue
        tid = int(meta["track_id"])
        if r["status"] == "rejected":
            out[tid] = None
        elif r["status"] == "corrected" and r.get("resolved_sku"):
            out[tid] = r["resolved_sku"]
        elif r["status"] == "accepted":
            out[tid] = meta.get("track_sku") or r["sku"]
    return out


def export_coco(services: Services, run_ids: list[str], frames_per_run: int = 8,
                unknown_sku: str = "UNKNOWN") -> bytes:
    store = services.store
    images, annotations, categories = [], [], {}
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for run_id in run_ids:
            run = store.get_run(run_id)
            inspector = services.output_dir / run_id / "inspector.json"
            if run is None or not inspector.is_file():
                continue
            doc = json.loads(inspector.read_text(encoding="utf-8"))
            overrides = _labels_by_track(run)
            frames = {f["index"]: f for f in doc.get("frames", [])}
            by_frame: dict[int, list[dict[str, Any]]] = {}
            for b in doc.get("boxes", []):
                if not b.get("counted"):
                    continue
                by_frame.setdefault(b["frame"], []).append(b)
            # The frames with the most counted objects, spread over the walk.
            chosen = sorted(by_frame, key=lambda i: -len(by_frame[i]))[: frames_per_run * 3]
            chosen = sorted(chosen)[:: max(1, len(chosen) // max(frames_per_run, 1))][:frames_per_run]
            for fi in chosen:
                meta = frames.get(fi)
                if meta is None:
                    continue
                img = read_frame(run["source"], meta["source_index"],
                                 services.extra.get("resize_width", 960))
                if img is None:
                    continue
                name = f"images/{run_id}_{meta['source_index']:06d}.jpg"
                ok, enc = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 92])
                if not ok:
                    continue
                zf.writestr(name, enc.tobytes())
                image_id = len(images) + 1
                images.append({"id": image_id, "file_name": name, "width": img.shape[1],
                               "height": img.shape[0], "run_id": run_id,
                               "location": run.get("location")})
                for b in by_frame[fi]:
                    tid = b.get("track_id")
                    sku = overrides.get(tid, b.get("track_sku") or b["sku"]) if tid is not None else b["sku"]
                    if sku is None or sku == unknown_sku:
                        continue  # rejected by a person, or never named
                    cat = categories.setdefault(sku, {"id": len(categories) + 1, "name": sku})
                    x1, y1, x2, y2 = b["bbox"]
                    annotations.append({
                        "id": len(annotations) + 1, "image_id": image_id, "category_id": cat["id"],
                        "bbox": [round(x1, 1), round(y1, 1), round(x2 - x1, 1), round(y2 - y1, 1)],
                        "area": round((x2 - x1) * (y2 - y1), 1), "iscrowd": 0,
                        "track_id": tid, "reviewed": tid in overrides,
                    })
        coco = {
            "info": {"description": "Countbone counted shelves", "version": "1"},
            "images": images, "annotations": annotations,
            "categories": list(categories.values()),
        }
        zf.writestr("annotations.json", json.dumps(coco))
    return buf.getvalue()
