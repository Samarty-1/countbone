"""Count a place once, however many videos cover it.

Two people film adjacent stretches of one aisle and their videos overlap;
or one person films a bay twice because the first pass was shaky. Adding
the runs double counts everything in the overlap. This merges them.

Every counted object carries a shelf position (the tracker's world
coordinates: where it sat in the run's first frame, with camera motion
removed). Two videos of one shelf see the same objects in the same
arrangement, just shifted (and scaled, if one was filmed from further
back). So:

1. Normalise scale by the median object size of each run.
2. Every same-SKU pair across the runs proposes an offset. Score each
   offset by the objects it lines up (same SKU, within a third of an object)
   minus the conflicts it creates (an object where the other video saw
   nothing, or saw a different SKU). The conflict term is what defeats a
   repeating shelf: shifting by one facing lines up plenty of objects, but
   on a shelf with any variety it also puts SKUs on top of the wrong SKUs.
3. Accept the best offset only if it is clearly supported and clearly
   better than the runner-up; a shelf of one identical product is honestly
   ambiguous, and is flagged for a person instead of guessed.
4. Pair objects one to one; each pair is one object. The union is the count.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from typing import Any

import numpy as np


@dataclass
class Placed:
    sku: str
    x: float
    y: float
    w: float
    h: float
    run_id: str
    track_id: int | None = None


@dataclass
class Alignment:
    status: str                      # aligned | disjoint | ambiguous
    dx: float = 0.0
    dy: float = 0.0
    scale: float = 1.0
    matched: int = 0
    conflicts: int = 0
    runner_up: float | None = None
    detail: str = ""


@dataclass
class Merged:
    objects: list[Placed] = field(default_factory=list)
    alignments: list[dict[str, Any]] = field(default_factory=list)
    duplicates: int = 0

    def counts(self) -> dict[str, int]:
        return dict(sorted(Counter(o.sku for o in self.objects).items()))


def _median(values: list[float], default: float = 1.0) -> float:
    return float(np.median(values)) if values else default


def _score(b: np.ndarray, b_sku: list[str], dx: float, dy: float, tx: float, ty: float,
           a_xy: np.ndarray, a_sku: np.ndarray, a_lo: float, a_hi: float,
           pad: float) -> tuple[int, int, int]:
    """(matched, conflicts, objects in the overlap) for one proposed offset.

    Symmetric: inside the stretch both videos cover, every object either
    video saw must be explained by the other. An object one saw where the
    other saw empty shelf is a conflict, whichever video it is in; checking
    only one direction let two different stretches of a regular shelf "line
    up" and delete real cartons as duplicates.
    """
    shifted = b + np.array([dx, dy])
    # Judge the overlap away from its ragged ends: an object at the very edge
    # of one video's coverage was only ever partly in view there, and the
    # detector rightly drops partial objects, so its absence proves nothing.
    b_lo, b_hi = float(shifted[:, 0].min() + pad), float(shifted[:, 0].max() - pad)
    lo, hi = max(a_lo + 2 * pad, b_lo), min(a_hi - 2 * pad, b_hi)
    if hi <= lo:
        return 0, 0, 0
    matched = conflicts = in_overlap = 0
    for (x, y), sku in zip(shifted, b_sku, strict=True):
        if not lo <= x <= hi:
            continue
        in_overlap += 1
        near = (np.abs(a_xy[:, 0] - x) <= tx) & (np.abs(a_xy[:, 1] - y) <= ty)
        if near.any() and (a_sku[near] == sku).any():
            matched += 1
        else:
            conflicts += 1
    for (x, y), _ in zip(a_xy, a_sku, strict=True):
        if not lo <= x <= hi:
            continue
        in_overlap += 1
        near = (np.abs(shifted[:, 0] - x) <= tx) & (np.abs(shifted[:, 1] - y) <= ty)
        if not near.any():
            conflicts += 1
    return matched, conflicts, in_overlap


def align(a: list[Placed], b: list[Placed], max_candidates: int = 4000) -> Alignment:
    """Find how `b` sits on `a`'s shelf coordinates."""
    if not a or not b:
        return Alignment("disjoint", detail="one of the runs counted nothing")
    wa, wb = _median([p.w for p in a]), _median([p.w for p in b])
    ha = _median([p.h for p in a])
    scale = wa / wb if wb > 0 else 1.0
    a_xy = np.array([[p.x, p.y] for p in a], np.float64)
    a_sku = np.array([p.sku for p in a])
    b_xy = np.array([[p.x * scale, p.y * scale] for p in b], np.float64)
    b_sku = [p.sku for p in b]
    tx, ty = 0.35 * wa, 0.35 * ha
    a_lo, a_hi = float(a_xy[:, 0].min() - wa / 2), float(a_xy[:, 0].max() + wa / 2)

    cands = [(ax - bx, ay - by)
             for (ax, ay), sa in zip(a_xy, a_sku, strict=True)
             for (bx, by), sb in zip(b_xy, b_sku, strict=True) if sa == sb]
    if not cands:
        return Alignment("disjoint", scale=scale, detail="no SKU in common")
    if len(cands) > max_candidates:
        idx = np.random.default_rng(0).choice(len(cands), max_candidates, replace=False)
        cands = [cands[i] for i in idx]
    # Offsets within a third of an object are the same proposal; score each once.
    buckets: dict[tuple[int, int], tuple[float, float]] = {}
    for dx, dy in cands:
        buckets.setdefault((round(dx / tx), round(dy / ty)), (dx, dy))

    scored = []
    for dx, dy in buckets.values():
        m, c, n = _score(b_xy, b_sku, dx, dy, tx, ty, a_xy, a_sku, a_lo, a_hi, wa / 2)
        scored.append((m - 2.0 * c, m, c, dx, dy, n))
    scored.sort(key=lambda s: -s[0])
    best = scored[0]
    _, matched, conflicts, dx, dy, in_overlap = best
    # The runner-up must be a genuinely different placement, not a
    # neighbouring bucket of the same one.
    runner = next((s for s in scored[1:]
                   if abs(s[3] - dx) > 0.6 * wa or abs(s[4] - dy) > 0.6 * ha), None)

    # Deleting a real object is worse than keeping a duplicate a person can
    # spot, so an overlap must be proven: several objects, nearly all of the
    # overlapping stretch explained from both sides, no contradictions to speak of.
    if matched < 4:
        return Alignment("disjoint", dx, dy, scale, matched, conflicts,
                         detail="fewer than four objects line up: the videos do not overlap")
    if conflicts > max(1, 0.1 * matched) or 2 * matched < 0.85 * in_overlap:
        return Alignment("disjoint", dx, dy, scale, matched, conflicts,
                         detail="the best overlap contradicts itself: treated as separate stretches")
    if runner is not None and runner[0] >= 0.8 * best[0] and runner[1] >= 3:
        return Alignment("ambiguous", dx, dy, scale, matched, conflicts, runner_up=runner[0],
                         detail="two placements fit about equally well (a repetitive shelf); "
                                "a person should confirm the overlap")
    # Refine: average displacement of the objects that line up.
    shifted = b_xy + np.array([dx, dy])
    diffs = []
    for (x, y), sku in zip(shifted, b_sku, strict=True):
        near = (np.abs(a_xy[:, 0] - x) <= tx) & (np.abs(a_xy[:, 1] - y) <= ty) & (a_sku == sku)
        if near.any():
            j = int(np.argmin(np.hypot(a_xy[:, 0] - x, a_xy[:, 1] - y) + (~near) * 1e9))
            diffs.append(a_xy[j] - np.array([x, y]))
    if diffs:
        d = np.mean(diffs, axis=0)
        dx, dy = dx + float(d[0]), dy + float(d[1])
    return Alignment("aligned", dx, dy, scale, matched, conflicts,
                     runner_up=runner[0] if runner else None)


def merge(runs: list[tuple[str, list[Placed]]]) -> Merged:
    """Merge runs into one set of objects, largest run first as the anchor."""
    out = Merged()
    if not runs:
        return out
    ordered = sorted(runs, key=lambda r: -len(r[1]))
    anchor_id, anchor = ordered[0]
    placed = list(anchor)
    out.alignments.append({"run_id": anchor_id, "status": "anchor", "objects": len(anchor)})
    for run_id, objs in ordered[1:]:
        al = align(placed, objs)
        entry = {"run_id": run_id, "objects": len(objs), **{
            k: (round(v, 2) if isinstance(v, float) else v) for k, v in al.__dict__.items()}}
        if al.status != "aligned":
            # Not provably the same stretch: keep every object, and say so.
            placed += objs
            entry["duplicates"] = 0
            out.alignments.append(entry)
            continue
        wa = _median([p.w for p in placed])
        ha = _median([p.h for p in placed])
        tx, ty = 0.35 * wa, 0.35 * ha
        taken: set[int] = set()
        dupes = 0
        additions = []
        for p in objs:
            x, y = p.x * al.scale + al.dx, p.y * al.scale + al.dy
            best_j, best_d = None, None
            for j, q in enumerate(placed):
                if j in taken or q.sku != p.sku:
                    continue
                if abs(q.x - x) <= tx and abs(q.y - y) <= ty:
                    d = (q.x - x) ** 2 + (q.y - y) ** 2
                    if best_d is None or d < best_d:
                        best_j, best_d = j, d
            if best_j is not None:
                taken.add(best_j)
                dupes += 1
            else:
                additions.append(Placed(p.sku, x, y, p.w * al.scale, p.h * al.scale,
                                        p.run_id, p.track_id))
        placed += additions
        out.duplicates += dupes
        entry["duplicates"] = dupes
        out.alignments.append(entry)
    out.objects = placed
    return out


def objects_from_run(run: dict[str, Any]) -> list[Placed]:
    """A run's counted objects, with reviewers' item decisions applied."""
    from .final import _meta  # one definition of how reviews are read

    decisions: dict[int, tuple[str, str | None]] = {}
    for r in run.get("reviews") or []:
        meta = _meta(r)
        if meta.get("scope") == "item" and meta.get("track_id") is not None and r["status"] != "pending":
            decisions[int(meta["track_id"])] = (r["status"], r.get("resolved_sku"))
    objs = []
    for t in (run.get("meta") or {}).get("tracks_world") or []:
        sku = t["sku"]
        status, target = decisions.get(int(t["track_id"]), ("accepted", None))
        if status == "rejected":
            continue
        if status == "corrected" and target:
            sku = target
        objs.append(Placed(sku, t["x"], t["y"], t["w"], t["h"], run["run_id"], t["track_id"]))
    return objs
