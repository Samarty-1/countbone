"""Count synthetic shelves under each config in examples/test_configs and compare.

    python examples/benchmark_configs.py                 # every config, seeds 0-4
    python examples/benchmark_configs.py --seeds 10 examples/test_configs/stride_20.yaml

Each shelf is rendered by countbone.demo with known ground truth, so the
table is an error, not a guess. Two rows are always included:

  defaults            Config() as shipped
  no_motion_comp      defaults, but the tracker ignores camera motion (the
                      ablation behind the README's motion-compensation claim)

The shelves come from the same renderer the pipeline was tuned on: this
ranks configs against each other, it does not predict warehouse accuracy.
"""

from __future__ import annotations

import argparse
import contextlib
import tempfile
from collections.abc import Iterator
from pathlib import Path

from countbone.config import Config
from countbone.demo import make_demo_video
from countbone.pipeline import Pipeline
from countbone.stages import count

HERE = Path(__file__).resolve().parent


@contextlib.contextmanager
def no_motion_compensation() -> Iterator[None]:
    """Tracks predicted with zero camera motion; scene cuts still end tracks."""
    update, observe = count.Tracker.update, count.Tracker.observe_motion

    def blind_update(self, frame_index, items, motion=None):
        return update(self, frame_index, items, {"cut": motion.get("cut")} if motion else None)

    count.Tracker.update = blind_update
    count.Tracker.observe_motion = lambda self, motion: None
    try:
        yield
    finally:
        count.Tracker.update, count.Tracker.observe_motion = update, observe


def score(cfg: Config, seeds: range, media: Path, out: Path) -> tuple[int, int, int]:
    """(shelves counted exactly, total absolute unit error, total units)."""
    exact = err = units = 0
    for seed in seeds:
        scene = make_demo_video(media / f"shelf_{seed}.webm", seed=seed)
        cfg.output.dir = str(out)
        cfg.output.sqlite = None
        result = Pipeline(cfg).run(scene.path)
        got = {c.sku: c.count for c in result.counts if c.count}
        exact += got == scene.truth
        err += sum(abs(got.get(s, 0) - scene.truth.get(s, 0)) for s in set(got) | set(scene.truth))
        units += scene.total
    return exact, err, units


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("configs", nargs="*", type=Path,
                    default=sorted((HERE / "test_configs").glob("*.yaml")))
    ap.add_argument("--seeds", type=int, default=5, help="shelves per config (seeds 0..N-1)")
    args = ap.parse_args()
    seeds = range(args.seeds)
    with tempfile.TemporaryDirectory() as tmp:
        media, out = Path(tmp) / "media", Path(tmp) / "runs"
        media.mkdir()
        rows = [("defaults", score(Config(), seeds, media, out))]
        with no_motion_compensation():
            rows.append(("no_motion_comp", score(Config(), seeds, media, out)))
        rows += [(p.stem, score(Config.load(p), seeds, media, out)) for p in args.configs]
    print(f"{'config':<20}{'exact':>8}{'unit error':>13}")
    for name, (exact, err, units) in rows:
        print(f"{name:<20}{exact:>4}/{len(seeds):<3}{err:>6} of {units:<5}({err / max(units, 1):.1%})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
