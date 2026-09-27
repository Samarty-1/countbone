"""Catalog Studio: set up products by photographing them.

Everything a customer needs to add a product without us: create the SKU,
upload about five photos, see whether the system can already tell it from
its look-alikes, and test it on a new photo. Reviewers' corrections feed
back in: a crop a person relabelled becomes an example of the right SKU.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from .. import appearance
from ..catalog import Catalog, SkuEntry
from ..security import role_at_least
from ..types import new_id
from . import Forbidden, OpsError, Services

MAX_PHOTO_BYTES = 12 * 1024 * 1024
SKU_CHARS = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.:/ ")


def estimate_colour(images: list[np.ndarray]) -> dict[str, Any] | None:
    """A product's colour band, learned from its photos.

    Colour identification still covers the products nobody photographed,
    but only where no photographed product shares their colour (see
    identify.AppearanceIdentifier). A photographed product with no known
    colour would block colour identification for the whole catalog, so its
    colour is measured here: the circular mean hue of the product (vivid
    pixels only), as a band of +-12, or achromatic for a grey/black/white box.
    """
    from ..stages.identify import circular_hue

    hues, sats = [], []
    for img in images:
        crop = appearance.product_crop(img)
        hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
        sats.append(float(np.median(hsv[:, :, 1])))
        vivid = hsv[hsv[:, :, 1] >= 60]
        if len(vivid) >= 50:
            hues.append(circular_hue(vivid.reshape(-1, 1, 3)))
    if not sats:
        return None
    if float(np.median(sats)) < 60 or not hues:
        return {"achromatic": True, "hue": None}
    angles = np.asarray(hues) * (2 * np.pi / 180)
    centre = float(np.mod(np.arctan2(np.sin(angles).mean(), np.cos(angles).mean()) * 180 / (2 * np.pi), 180))
    return {"achromatic": False, "hue": [int(round(centre - 12)) % 180, int(round(centre + 12)) % 180]}


def learn_colour(store, sku: str) -> None:
    """Set a Studio product's colour band from its photos, if it has none."""
    row = store.get_sku(sku)
    if row is None or row.get("hue") or row.get("achromatic"):
        return
    images = [img for p in store.list_photos(sku) if p["source"] == "upload"
              and (img := cv2.imread(p["path"])) is not None]
    if not images:
        return
    colour = estimate_colour(images)
    if colour:
        store.upsert_sku(sku, {"hue": colour["hue"], "achromatic": int(colour["achromatic"])}, None)


def load_catalog(base: Catalog, store) -> Catalog:
    """The configured catalog, plus Studio products and every enrolled photo."""
    # Products photographed before colours were learned get theirs now, once.
    for row in store.list_skus():
        if row["photos"] and not row.get("hue") and not row.get("achromatic"):
            learn_colour(store, row["sku"])
    studio = [
        SkuEntry(
            sku=r["sku"], label=r["label"] or r["sku"],
            hue=tuple(r["hue"]) if r.get("hue") else None,  # type: ignore[arg-type]
            min_saturation=int(r.get("min_saturation") or 60),
            achromatic=bool(r.get("achromatic")),
            unit_value=float(r.get("unit_value") or 0), barcodes=list(r.get("barcodes") or []),
            source="studio",
        )
        for r in store.list_skus()
    ]
    catalog = base.merged(studio)
    known = {e.sku for e in catalog.entries}
    catalog.exemplars = [
        appearance.Exemplar(r["sku"], r["vector"], r["photo_id"], r["kind"])
        for r in store.all_vectors()
        if r["version"] == appearance.EMBED_VERSION and r["sku"] in known
    ]
    return catalog


def validate_sku(sku: str) -> str:
    sku = (sku or "").strip()
    if not sku or len(sku) > 64 or not set(sku) <= SKU_CHARS:
        raise OpsError("a SKU is 1-64 characters: letters, digits, - _ . : / and spaces")
    return sku


def save_sku(services: Services, sku: str, fields: dict[str, Any], actor: dict[str, Any]) -> dict[str, Any]:
    if not role_at_least(actor["role"], "manager"):
        raise Forbidden("editing the catalog needs a manager")
    sku = validate_sku(sku)
    hue = fields.get("hue")
    if hue is not None:
        if not (isinstance(hue, (list, tuple)) and len(hue) == 2 and all(0 <= int(h) <= 179 for h in hue)):
            raise OpsError("hue is two numbers from 0 to 179")
        fields["hue"] = [int(h) for h in hue]
    if fields.get("unit_value") is not None and float(fields["unit_value"]) < 0:
        raise OpsError("unit value cannot be negative")
    row = services.store.upsert_sku(sku, fields, actor["user_id"])
    services.store.add_audit(f"sku:{sku}", "sku_saved", {"sku": sku, **fields}, actor=actor["username"])
    return row


def _decode(data: bytes) -> np.ndarray:
    if len(data) > MAX_PHOTO_BYTES:
        raise OpsError("photos must be under 12 MB")
    image = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise OpsError("that file is not an image OpenCV can read (use JPEG or PNG)")
    h, w = image.shape[:2]
    if min(h, w) < 48:
        raise OpsError("the photo is too small; get closer to the product")
    # Keep what is stored and embedded to a sensible size.
    if max(h, w) > 1600:
        s = 1600 / max(h, w)
        image = cv2.resize(image, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
    return image


def add_photo(services: Services, sku: str, data: bytes, actor: dict[str, Any] | None,
              source: str = "upload", run_id: str | None = None,
              review_id: str | None = None) -> dict[str, Any]:
    store = services.store
    if store.get_sku(sku) is None:
        entry = services.current_catalog().by_sku(sku)
        if entry is None:
            raise OpsError(f"no product {sku}; create it first")
        # A configured (YAML) product gets a Studio row the first time it is photographed.
        store.upsert_sku(sku, {"label": entry.label, "unit_value": entry.unit_value,
                               "hue": list(entry.hue) if entry.hue else None,
                               "barcodes": entry.barcodes}, actor["user_id"] if actor else None)
    image = _decode(data)
    photo_id = new_id("pho")
    folder = services.data_dir / "catalog" / "".join(c if c.isalnum() else "_" for c in sku)
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{photo_id}.jpg"
    cv2.imwrite(str(path), image, [cv2.IMWRITE_JPEG_QUALITY, 92])
    vectors = appearance.vectors_for_photo(image, photo_id, sku)
    store.add_photo(sku, str(path), source, actor["user_id"] if actor else None,
                    [(v.kind, v.vector) for v in vectors], appearance.EMBED_VERSION,
                    run_id=run_id, review_id=review_id, photo_id=photo_id)
    store.add_audit(f"sku:{sku}", "sku_photo_added",
                    {"photo_id": photo_id, "source": source, "run_id": run_id,
                     "review_id": review_id}, actor=actor["username"] if actor else "system")
    if source == "upload":
        learn_colour(store, sku)
    return store.get_photo(photo_id)  # type: ignore[return-value]


def learn_from_review(services: Services, review: dict[str, Any], actor: dict[str, Any]) -> str | None:
    """A reviewer named what a crop shows: keep it as an example of that SKU.

    Only for decisions that say what the object *is* (accepted as the
    model's guess, or corrected to another SKU) on products that are
    photo-enrolled, so a colour-only catalog is not silently converted.
    """
    if review["status"] not in ("accepted", "corrected") or not review.get("crop_path"):
        return None
    sku = review.get("resolved_sku") if review["status"] == "corrected" else review["sku"]
    unknown = services.extra.get("unknown_sku", "UNKNOWN")
    if not sku or sku == unknown:
        return None
    catalog = services.current_catalog()
    if sku not in {e.sku for e in catalog.exemplars}:
        return None
    path = services.output_dir / review["run_id"] / review["crop_path"]
    if not path.is_file():
        return None
    photo = add_photo(services, sku, path.read_bytes(), actor, source="review",
                      run_id=review["run_id"], review_id=review["review_id"])
    return photo["photo_id"]


def delete_photo(services: Services, photo_id: str, actor: dict[str, Any]) -> None:
    if not role_at_least(actor["role"], "manager"):
        raise Forbidden("editing the catalog needs a manager")
    photo = services.store.get_photo(photo_id)
    if photo is None:
        raise OpsError("no such photo")
    services.store.delete_photo(photo_id)
    Path(photo["path"]).unlink(missing_ok=True)
    services.store.add_audit(f"sku:{photo['sku']}", "sku_photo_deleted", {"photo_id": photo_id},
                             actor=actor["username"])


def identify_photo(services: Services, data: bytes, k: int = 3) -> dict[str, Any]:
    """Try the catalog on a photo: what would a sighting like this be called?"""
    catalog = services.current_catalog()
    index = catalog.index()
    if not len(index):
        raise OpsError("no products have photos yet")
    product = appearance.product_crop(_decode(data))
    matches = index.match(appearance.embed(product), k=k)
    accept = index.accept_for(matches[0].sku) if matches else index.accept
    return {
        "matches": [{"sku": m.sku, "score": round(m.score, 4),
                     "label": (catalog.by_sku(m.sku) or SkuEntry(m.sku)).label} for m in matches],
        "decision": matches[0].sku if matches and matches[0].score >= accept else None,
        "confidence": round(appearance.confidence(matches, accept, index.margin), 4),
        "accept": round(accept, 4),
    }


def quality(services: Services) -> dict[str, Any]:
    """How ready each enrolled product is, and what it could be mistaken for.

    For each product: how many photos, how consistently its held-out probes
    are recognised as itself (leave-one-photo-out), and the closest other
    product. A product with one photo, or one its probes confuse with a
    neighbour, needs more (or more varied) photos before it is trusted.
    """
    catalog = services.current_catalog()
    index = catalog.index()
    probes = [e for e in catalog.exemplars if e.kind == "probe"]
    photos: dict[str, set[str]] = {}
    for e in catalog.exemplars:
        photos.setdefault(e.sku, set()).add(e.group)
    per: dict[str, dict[str, Any]] = {}
    for sku in index.skus:
        own = [p for p in probes if p.sku == sku]
        correct = 0
        confusions: dict[str, int] = {}
        tested = 0
        for p in own:
            if len(photos.get(sku, ())) < 2:
                break
            scores = index._scores(p.vector, exclude_group=p.group)
            best = index.skus[int(np.argmax(scores))]
            tested += 1
            if best == sku:
                correct += 1
            else:
                confusions[best] = confusions.get(best, 0) + 1
        centroid = index.centroids[index.skus.index(sku)]
        sims = index.centroids @ centroid
        others = [(index.skus[i], float(s)) for i, s in enumerate(sims) if index.skus[i] != sku]
        nearest = max(others, key=lambda t: t[1]) if others else (None, None)
        n_photos = len(photos.get(sku, ()))
        accuracy = correct / tested if tested else None
        status = ("needs photos" if n_photos < 3 else
                  "confusable" if accuracy is not None and accuracy < 0.9 else "ready")
        per[sku] = {
            "photos": n_photos, "self_recognition": None if accuracy is None else round(accuracy, 3),
            "confused_with": confusions, "nearest": nearest[0],
            "nearest_similarity": None if nearest[1] is None else round(nearest[1], 4),
            "accept_threshold": round(index.accept_for(sku), 4), "status": status,
        }
    # Colour-only products a photographed look-alike now shadows: sightings
    # of these become "unknown" until they are photographed too.
    from ..stages.identify import _bands_overlap

    enrolled = [e for e in catalog.entries if e.sku in set(index.skus)]
    conflicts = []
    for e in catalog.entries:
        if e.sku in set(index.skus):
            continue
        blockers = [o.sku for o in enrolled if _bands_overlap(e, o)]
        if blockers:
            conflicts.append({"sku": e.sku, "label": e.label, "shares_colour_with": blockers})
    return {"products": per, "calibration": index.calibration, "colour_conflicts": conflicts,
            "enrolled": len(index.skus), "generated_at": time.time()}
