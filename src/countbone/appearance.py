"""Appearance embeddings: teach the system a product from a handful of photos.

The colour identifier can separate as many SKUs as there are distinct hues,
which on a real shelf is a handful. Products are told apart by their artwork:
where the colours are, and the shapes of logos, text and stripes. This module
turns a product image into a vector that captures both, and a small index
that matches new sightings against enrolled examples.

Design choices, for a pilot rather than a benchmark:

* No deep-learning runtime. Everything is OpenCV + NumPy, runs on a laptop
  CPU at thousands of crops a second, and is deterministic. The embedder is a
  single function (`embed`) so a learned model (ONNX) can replace it later
  without touching the index, the catalog or the API.
* Few-shot by nearest exemplar. Five photos per SKU are stored as-is (plus a
  few augmented copies); a sighting is scored against its closest exemplar,
  blended with the SKU's centroid. Adding a photo takes effect immediately,
  with no training step, which is what makes review corrections usable as
  new examples.
* Open set. A sighting unlike every enrolled SKU is reported as unknown
  rather than forced onto the nearest one; a shelf always holds something
  nobody enrolled.
"""

from __future__ import annotations

import zlib
from dataclasses import dataclass

import cv2
import numpy as np

SIZE = 64
EMBED_VERSION = 1  # bump when `embed` changes: stored vectors must be recomputed
_GRID = 4          # orientation cells
_LAYOUT_GRID = 8   # colour-layout cells: where colour sits is what tells look-alikes apart
_ORIENT_BINS = 8


def _prepare(bgr: np.ndarray, inset: float = 0.06) -> np.ndarray:
    h, w = bgr.shape[:2]
    dy, dx = int(h * inset), int(w * inset)
    core = bgr[dy : h - dy or h, dx : w - dx or w] if h > 8 and w > 8 else bgr
    small = cv2.resize(core, (SIZE, SIZE), interpolation=cv2.INTER_AREA)
    # A mild blur narrows the gap between crisp enrolment photos and
    # motion-softened video crops more than it costs detail.
    return cv2.GaussianBlur(small, (3, 3), 0)


def _l2(v: np.ndarray) -> np.ndarray:
    n = float(np.linalg.norm(v))
    return v / n if n > 1e-9 else v


def _colour_hist(hsv: np.ndarray) -> np.ndarray:
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    chroma = s >= 40
    hs, _, _ = np.histogram2d(
        h[chroma].ravel(), np.minimum(s[chroma].ravel(), 255),
        bins=(18, 3), range=((0, 180), (40, 256)),
    )
    grey, _ = np.histogram(v[~chroma].ravel(), bins=8, range=(0, 256))
    hist = np.concatenate([hs.ravel(), grey]).astype(np.float32)
    hist /= max(hist.sum(), 1.0)
    return np.sqrt(hist)  # Hellinger: big bins stop drowning small ones


def _layout(lab: np.ndarray) -> np.ndarray:
    g = _LAYOUT_GRID
    cells = lab.reshape(g, SIZE // g, g, SIZE // g, 3).mean(axis=(1, 3))
    feats = cells.reshape(-1, 3).astype(np.float32)
    feats[:, 0] = (feats[:, 0] - 128.0) / 128.0 * 0.5  # lightness matters less than colour
    feats[:, 1:] = (feats[:, 1:] - 128.0) / 64.0
    return feats.ravel()


def _orientations(gray: np.ndarray) -> np.ndarray:
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    mag, ang = cv2.cartToPolar(gx, gy)
    ang = np.mod(ang, np.pi)  # unsigned: an edge is an edge whichever side is darker
    bins = np.minimum((ang / np.pi * _ORIENT_BINS).astype(np.int32), _ORIENT_BINS - 1)
    step = SIZE // _GRID
    out = np.zeros((_GRID, _GRID, _ORIENT_BINS), np.float32)
    for gy_ in range(_GRID):
        for gx_ in range(_GRID):
            sl = (slice(gy_ * step, (gy_ + 1) * step), slice(gx_ * step, (gx_ + 1) * step))
            out[gy_, gx_] = np.bincount(
                bins[sl].ravel(), weights=mag[sl].ravel(), minlength=_ORIENT_BINS
            )
    # Normalise per cell so contrast changes do not matter, keep an overall
    # edge-energy term so a plain box and a busy label still differ.
    energy = out.sum(axis=2, keepdims=True)
    cells = out / np.maximum(energy, 1e-6)
    density = np.log1p(energy / (step * step)) / 5.0
    return np.concatenate([np.sqrt(cells).ravel(), density.ravel()])


def embed(bgr: np.ndarray) -> np.ndarray:
    """A unit vector describing how a product looks. Cosine = similarity."""
    if bgr is None or bgr.size == 0 or bgr.ndim != 3:
        raise ValueError("embed needs a colour image")
    img = _prepare(bgr)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB).astype(np.float32)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
    parts = [
        # Weights measured on a look-alike range (same red packaging, different
        # artwork): the colour histogram alone cannot tell those apart and, at
        # full weight, made unenrolled products look enrolled.
        (_colour_hist(hsv), 0.3),
        (_layout(lab), 2.0),
        (_orientations(gray), 1.0),
    ]
    return _l2(np.concatenate([_l2(p) * w for p, w in parts]).astype(np.float32))


def product_crop(photo: np.ndarray) -> np.ndarray:
    """The product in an enrolment photo, without the table it stood on.

    Video crops are tight boxes from the detector; a phone photo has a
    margin of whatever was behind the product. Embedding that margin teaches
    the index the background. The product is taken to be the largest strong
    rectangle-ish outline covering a fair share of the photo; if none is
    found the photo is assumed to be framed on the product already.
    """
    h, w = photo.shape[:2]
    gray = cv2.cvtColor(photo, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(gray, 40, 120)
    edges = cv2.dilate(edges, np.ones((5, 5), np.uint8), iterations=2)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    # An outline broken by glare or a label comes out as several contours;
    # the product is the union of the substantial ones. Anything touching
    # the photo's edge is background running out of frame.
    boxes = []
    for c in contours:
        x, y, bw, bh = cv2.boundingRect(c)
        if bw * bh < 0.01 * w * h:
            continue
        if x <= 2 or y <= 2 or x + bw >= w - 2 or y + bh >= h - 2:
            continue
        boxes.append((x, y, x + bw, y + bh))
    if not boxes:
        return photo
    x1 = min(b[0] for b in boxes)
    y1 = min(b[1] for b in boxes)
    x2 = max(b[2] for b in boxes)
    y2 = max(b[3] for b in boxes)
    frac = (x2 - x1) * (y2 - y1) / float(w * h)
    if not 0.2 <= frac <= 0.97:
        return photo
    # The dilation grew the outline outward; take back roughly what it added.
    t = 4
    return photo[y1 + t : y2 - t, x1 + t : x2 - t]


def augment(bgr: np.ndarray, rng: np.random.Generator, n: int = 3) -> list[np.ndarray]:
    """Plausible variations of one enrolment photo.

    Five phone photos are not five viewpoints of a shelf: video crops are
    smaller, softer, differently lit and slightly off-centre. Stretching each
    photo across those conditions is what lets five photos generalise.
    """
    out = []
    h, w = bgr.shape[:2]
    for _ in range(n):
        img = bgr.astype(np.float32)
        img = img * rng.uniform(0.75, 1.2) + rng.uniform(-18, 18)
        img = np.clip(img, 0, 255).astype(np.uint8)
        # a slightly loose or tight crop
        m = rng.uniform(-0.06, 0.08)
        dx, dy = int(w * m), int(h * m)
        if dx > 0 and dy > 0:
            img = img[dy : h - dy, dx : w - dx]
        elif dx < 0 or dy < 0:
            img = cv2.copyMakeBorder(img, -min(dy, 0), -min(dy, 0), -min(dx, 0), -min(dx, 0),
                                     cv2.BORDER_REPLICATE)
        # video-like softness and scale
        scale = rng.uniform(0.25, 0.6)
        small = cv2.resize(img, (max(8, int(img.shape[1] * scale)), max(8, int(img.shape[0] * scale))),
                           interpolation=cv2.INTER_AREA)
        k = int(rng.choice([1, 3, 5]))
        if k > 1:
            small = cv2.GaussianBlur(small, (k, k), 0)
        out.append(small)
    return out


@dataclass
class Match:
    sku: str
    score: float  # cosine similarity, blended nearest-exemplar and centroid


@dataclass
class Exemplar:
    """One stored vector: an enrolment photo, or an augmented copy of one."""

    sku: str
    vector: np.ndarray
    group: str            # the photo it came from; copies of one photo share it
    kind: str = "train"   # train: matched against | probe: only used to calibrate


def vectors_for_photo(photo: np.ndarray, group: str, sku: str,
                      rng: np.random.Generator | None = None) -> list[Exemplar]:
    """Everything one enrolment photo contributes: itself, 3 training copies
    under video-like conditions, and 4 held-out probes for calibration."""
    # Seeded from the photo's id, not hash(): str hashes change per process.
    rng = rng or np.random.default_rng(zlib.crc32(group.encode()))
    product = product_crop(photo)
    out = [Exemplar(sku, embed(product), group, "train")]
    out += [Exemplar(sku, embed(a), group, "train") for a in augment(product, rng, 3)]
    out += [Exemplar(sku, embed(a), group, "probe") for a in augment(product, rng, 4)]
    return out


DEFAULT_ACCEPT = 0.93   # used until a catalog has enough photos to calibrate
DEFAULT_MARGIN = 0.02


class ExemplarIndex:
    """Nearest-exemplar matching against enrolled products, self-calibrating.

    The similarity a genuine sighting reaches depends on the products (a
    range of look-alikes scores everything high), so no constant threshold
    is right for every customer. The index measures its own: each held-out
    probe is scored against everything except the photo it came from, which
    is how a real sighting (a view no photo captured exactly) is scored.
    `accept` is set just under the low tail of those scores, so about 98% of
    genuine sightings clear it and anything less alike is called unknown.
    """

    def __init__(self, exemplars: list[Exemplar] | dict[str, np.ndarray]) -> None:
        if isinstance(exemplars, dict):  # plain {sku: vectors}: one group per vector
            exemplars = [
                Exemplar(sku, v, f"{sku}:{i}")
                for sku, vecs in exemplars.items()
                for i, v in enumerate(np.asarray(vecs, np.float32))
            ]
        train = [e for e in exemplars if e.kind == "train"]
        self.skus: list[str] = sorted({e.sku for e in train})
        pos = {s: i for i, s in enumerate(self.skus)}
        if train:
            self.matrix = np.vstack([e.vector for e in train]).astype(np.float32)
            self.owner = np.asarray([pos[e.sku] for e in train], np.int32)
            self.groups = np.asarray([e.group for e in train])
            self.centroids = np.vstack([
                _l2(self.matrix[self.owner == i].mean(axis=0)) for i in range(len(self.skus))
            ])
        else:
            self.matrix = np.zeros((0, 1), np.float32)
            self.owner = np.zeros(0, np.int32)
            self.groups = np.zeros(0, dtype=object)
            self.centroids = np.zeros((0, 1), np.float32)
        self.accept = DEFAULT_ACCEPT
        self.margin = DEFAULT_MARGIN
        self.accept_by_sku: dict[str, float] = {}
        self.calibration: dict[str, float | int | str] = {"source": "default"}
        self._calibrate([e for e in exemplars if e.kind == "probe"])

    def __len__(self) -> int:
        return len(self.skus)

    def _scores(self, vec: np.ndarray, exclude_group: str | None = None) -> np.ndarray:
        sims = self.matrix @ vec
        if exclude_group is not None:
            sims = np.where(self.groups == exclude_group, -1.0, sims)
        best = np.full(len(self.skus), -1.0, np.float32)
        np.maximum.at(best, self.owner, sims)
        central = self.centroids @ vec
        return 0.7 * best + 0.3 * central

    def match(self, vec: np.ndarray, k: int = 3) -> list[Match]:
        """Best-first SKUs for one embedding."""
        if not self.skus:
            return []
        scores = self._scores(vec)
        order = np.argsort(-scores)[:k]
        return [Match(self.skus[i], float(scores[i])) for i in order]

    def _calibrate(self, probes: list[Exemplar], max_probes: int = 2000) -> None:
        usable = [p for p in probes if p.sku in self.skus]
        # A SKU needs a second photo for its probes to be scored without
        # their own photo; below a handful of such probes, keep the default.
        own: list[float] = []
        by_sku: dict[str, list[float]] = {}
        for p in usable[:max_probes]:
            i = self.skus.index(p.sku)
            if not np.any((self.groups != p.group) & (self.owner == i)):
                continue
            score = float(self._scores(p.vector, exclude_group=p.group)[i])
            own.append(score)
            by_sku.setdefault(p.sku, []).append(score)
        if len(own) < 8:
            return
        low = float(np.percentile(own, 2))
        self.accept = float(np.clip(low - 0.005, 0.5, 0.99))
        # The spread of genuine scores sets how big a lead counts as decisive.
        self.margin = float(np.clip((np.percentile(own, 50) - low) / 2, 0.005, 0.1))
        # Per SKU, too: a plain box matches its own photos very closely, so
        # an unenrolled look-alike that merely resembles it must clear that
        # SKU's own bar, not the loosest bar in the catalog. Measured on a
        # look-alike range, this took unenrolled-product rejection from 0% to
        # over 90% of sightings, with no wrong acceptances.
        for sku, scores in by_sku.items():
            if len(scores) >= 6:
                self.accept_by_sku[sku] = float(
                    np.clip(np.percentile(scores, 5) - 0.005, 0.5, 0.995)
                )
        self.calibration = {"source": "probes", "probes": len(own),
                            "accept": round(self.accept, 4), "margin": round(self.margin, 4),
                            "per_sku": {k: round(v, 4) for k, v in self.accept_by_sku.items()}}

    def accept_for(self, sku: str) -> float:
        return self.accept_by_sku.get(sku, self.accept)


def confidence(matches: list[Match], accept: float, margin: float) -> float:
    """How sure a match is: absolute similarity and the lead over the runner-up.

    Both matter: a sighting can look a lot like two SKUs (high score, no
    lead), or be closest to one while resembling nothing much (a lead, low
    score). Either way a person should look.
    """
    if not matches:
        return 0.0
    top = matches[0].score
    if top < accept:
        # Unlike anything enrolled: at most a weak hint, never a decision.
        return float(0.3 * np.clip(top / max(accept, 1e-6), 0.0, 1.0))
    second = matches[1].score if len(matches) > 1 else accept - margin
    absolute = np.clip((top - accept) / max(1.0 - accept, 1e-6), 0.0, 1.0)
    lead = np.clip((top - second) / max(margin, 1e-6), 0.0, 1.0)
    return float(np.clip(0.35 + 0.35 * absolute + 0.30 * lead, 0.0, 1.0))
