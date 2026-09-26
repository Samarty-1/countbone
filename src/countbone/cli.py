"""Command line interface.

    countbone run video.mp4          count a video
    countbone demo                   generate synthetic footage and count it
    countbone serve                  dashboard + API
    countbone plugins                what is installed
    countbone reviews                what is waiting for a human
    countbone history SKU            how this SKU has counted over time
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import datetime

from .config import Config
from .pipeline import Pipeline
from .plugins import base as plugin_base
from .store.db import Store
from .types import CountResult


def _load_config(args: argparse.Namespace) -> Config:
    cfg = Config.load(getattr(args, "config", None))
    if getattr(args, "out", None):
        cfg.output.dir = args.out
    if getattr(args, "db", None):
        cfg.output.sqlite = args.db
    if getattr(args, "strategy", None):
        cfg.count.strategy = args.strategy
    if getattr(args, "detector", None):
        cfg.detect.backend = args.detector
    if getattr(args, "catalog", None):
        cfg.identify.catalog = args.catalog
    for pair in getattr(args, "expect", None) or []:
        sku, _, value = pair.partition("=")
        if not value.strip().lstrip("-").isdigit():
            raise SystemExit(f"--expect needs SKU=INTEGER, got {pair!r}")
        cfg.count.expected[sku.strip()] = int(value)
    return cfg


def _print_result(result: CountResult, truth: dict[str, int] | None = None) -> None:
    print(f"\nrun {result.run_id}  ({result.duration_s:.2f}s)")
    print(f"source: {result.source}")
    print(
        f"frames: {result.frames_used} used, {result.frames_dropped} dropped"
        f"  detections: {result.detections}  tracks: {result.tracks}"
    )
    header = f"\n  {'SKU':<14}{'count':>7}{'expected':>10}{'var':>6}{'conf':>7}"
    if truth:
        header += f"{'truth':>7}{'err':>6}"
    print(header)
    print("  " + "-" * (len(header) - 3))
    for c in result.counts:
        line = (
            f"  {c.sku:<14}{c.count:>7}"
            f"{'' if c.expected is None else c.expected:>10}"
            f"{'' if c.variance is None else format(c.variance, '+d'):>6}"
            f"{c.confidence:>7.0%}"
        )
        if truth is not None:
            actual = truth.get(c.sku, 0)
            line += f"{actual:>7}{c.count - actual:>+6d}"
        print(line)
    print(f"  {'TOTAL':<14}{result.total:>7}")
    print(f"\nconfidence: {result.overall_confidence:.0%}   "
          f"needs review: {'yes' if result.needs_review else 'no'} "
          f"({len(result.reviews)} item(s))")
    for w in result.warnings:
        print(f"  ! {w}")
    outputs = result.meta.get("outputs", {})
    if outputs:
        print("\nwrote: " + ", ".join(f"{k} -> {v}" for k, v in outputs.items()))


def _pipeline(cfg: Config) -> Pipeline:
    """A pipeline that also writes inspector.json, like one run from the API.

    Without it, a video counted from the CLI appears in the dashboard (same
    database) but can never be opened in its frame inspector. There is no one
    to report live progress to here, so progress goes nowhere.
    """
    from .api import telemetry  # no web dependencies: safe without the [api] extra

    pipeline = Pipeline(cfg)
    pipeline.plugins = telemetry.attach(pipeline.plugins, lambda *_, **__: None)
    return pipeline


# -- commands -------------------------------------------------------------
def cmd_run(args: argparse.Namespace) -> int:
    cfg = _load_config(args)
    result = _pipeline(cfg).run(args.video)
    if args.json:
        print(json.dumps(result.to_dict(), indent=2))
    else:
        _print_result(result)
    return 2 if result.needs_review else 0


def cmd_demo(args: argparse.Namespace) -> int:
    from .demo import make_demo_video

    cfg = _load_config(args)
    scene = make_demo_video(args.video or "examples/demo_shelf.mp4", seed=args.seed)
    print(f"synthetic shelf: {scene.path}  ({scene.total} units, {scene.frames} frames)")
    cfg.count.expected = dict(scene.truth)
    result = _pipeline(cfg).run(scene.path)
    _print_result(result, truth=scene.truth)
    error = abs(result.total - scene.total)
    print(f"\nabsolute count error: {error} of {scene.total} "
          f"({error / max(scene.total, 1):.1%})")
    return 0


def cmd_serve(args: argparse.Namespace) -> int:
    import uvicorn

    from .api.app import create_app

    cfg = _load_config(args)
    app = create_app(cfg, allow_origins=args.allow_origin or ())
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
    return 0


def cmd_plugins(args: argparse.Namespace) -> int:
    print(f"{'name':<20}{'layer':<12}{'priority':>9}  description")
    print("-" * 78)
    for name, cls in sorted(
        plugin_base.available().items(), key=lambda kv: (kv[1].priority, kv[0])
    ):
        doc = (cls.__doc__ or "").strip().split("\n")[0]
        print(f"{name:<20}{cls.layer:<12}{cls.priority:>9}  {doc[:40]}")
    return 0


def cmd_reviews(args: argparse.Namespace) -> int:
    store = Store(args.db or Config().output.sqlite or "countbone.db")
    rows = store.reviews(status=args.status)
    if not rows:
        print(f"no reviews with status {args.status!r}")
        return 0
    print(f"{'review_id':<20}{'run':<20}{'sku':<14}{'conf':>6}  reason")
    print("-" * 80)
    for r in rows:
        print(
            f"{r['review_id']:<20}{r['run_id']:<20}{r['sku']:<14}"
            f"{(r['confidence'] or 0):>6.0%}  {r['reason']}"
        )
    return 0


def cmd_history(args: argparse.Namespace) -> int:
    store = Store(args.db or Config().output.sqlite or "countbone.db")
    rows = store.sku_history(args.sku, limit=args.limit)
    if not rows:
        print(f"no counts recorded for {args.sku}")
        return 1
    print(f"{'when':<20}{'count':>7}{'expected':>10}{'var':>6}{'conf':>7}  run")
    print("-" * 78)
    for r in rows:
        when = datetime.fromtimestamp(r["counted_at"]).strftime("%Y-%m-%d %H:%M:%S")
        print(
            f"{when:<20}{r['count']:>7}"
            f"{'' if r['expected'] is None else r['expected']:>10}"
            f"{'' if r['variance'] is None else format(r['variance'], '+d'):>6}"
            f"{(r['confidence'] or 0):>7.0%}  {r['run_id']}"
        )
    counts = [r["count"] for r in rows]
    print(f"\n{len(counts)} counts, mean {sum(counts) / len(counts):.1f}, "
          f"range {min(counts)}-{max(counts)}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="countbone",
        description="Video in, counts out. Everything else is a plugin.",
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    sub = parser.add_subparsers(dest="command", required=True)

    def common(p: argparse.ArgumentParser) -> None:
        p.add_argument("-c", "--config", help="YAML config file")
        p.add_argument("-o", "--out", help="output directory (default: runs)")
        p.add_argument("--db", help="sqlite path (default: countbone.db)")

    run = sub.add_parser("run", help="count a video")
    run.add_argument("video", help="video file, or a camera index")
    common(run)
    run.add_argument("--strategy", choices=["tracking", "peak_frame", "median_frame"])
    run.add_argument("--detector", choices=["contour", "yolo", "fixture"])
    run.add_argument("--catalog", help="SKU catalog YAML")
    run.add_argument("--expect", action="append", metavar="SKU=N",
                     help="expected count, repeatable")
    run.add_argument("--json", action="store_true", help="print the full result as JSON")
    run.set_defaults(func=cmd_run)

    demo = sub.add_parser("demo", help="generate synthetic footage and count it")
    demo.add_argument("--video", help="where to write the synthetic file")
    demo.add_argument("--seed", type=int, default=7)
    common(demo)
    demo.add_argument("--strategy", choices=["tracking", "peak_frame", "median_frame"])
    demo.set_defaults(func=cmd_demo)

    serve = sub.add_parser("serve", help="run the dashboard and API")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8000)
    serve.add_argument(
        "--allow-origin", action="append", metavar="ORIGIN",
        help="let a browser app on this origin call the API, e.g. the mobile app's "
             "web preview at http://localhost:8081 (repeatable; none by default). "
             "Native apps need no origin.",
    )
    common(serve)
    serve.set_defaults(func=cmd_serve)

    plugins = sub.add_parser("plugins", help="list installed plugins")
    plugins.set_defaults(func=cmd_plugins)

    reviews = sub.add_parser("reviews", help="list the human review queue")
    reviews.add_argument("--status", default="pending",
                         choices=["pending", "accepted", "rejected", "corrected"])
    reviews.add_argument("--db")
    reviews.set_defaults(func=cmd_reviews)

    history = sub.add_parser("history", help="count history for one SKU")
    history.add_argument("sku")
    history.add_argument("--limit", type=int, default=50)
    history.add_argument("--db")
    history.set_defaults(func=cmd_history)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.WARNING,
        format="%(levelname)s %(name)s: %(message)s",
    )
    try:
        return args.func(args)
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        return 130
    except Exception as exc:  # noqa: BLE001 - CLI boundary
        if args.verbose:
            raise
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
