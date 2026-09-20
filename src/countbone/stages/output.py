"""Stage 6 - Output. Emit the result in the formats a customer consumes.

Sinks are side-effect only: they never change the result. Anything that
changes the result is a plugin on an earlier hook.
"""

from __future__ import annotations

import csv
import json
import logging
from pathlib import Path

from ..config import OutputConfig
from ..context import RunContext
from ..types import CountResult

log = logging.getLogger(__name__)


def write_json(ctx: RunContext, result: CountResult) -> Path:
    path = ctx.artifacts_dir / "result.json"
    path.write_text(json.dumps(result.to_dict(), indent=2), encoding="utf-8")
    return path


def write_csv(ctx: RunContext, result: CountResult) -> Path:
    path = ctx.artifacts_dir / "counts.csv"
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(
            ["run_id", "sku", "label", "count", "expected", "variance", "confidence"]
        )
        for c in result.counts:
            writer.writerow(
                [
                    result.run_id,
                    c.sku,
                    c.label,
                    c.count,
                    "" if c.expected is None else c.expected,
                    "" if c.variance is None else c.variance,
                    round(c.confidence, 4),
                ]
            )
    return path


def emit(ctx: RunContext, result: CountResult, cfg: OutputConfig) -> dict[str, str]:
    written: dict[str, str] = {}
    if cfg.json:
        written["json"] = str(write_json(ctx, result))
    if cfg.csv:
        written["csv"] = str(write_csv(ctx, result))
    if ctx.store is not None:
        ctx.store.save_run(result, config_fingerprint=ctx.config.fingerprint())
        written["sqlite"] = ctx.store.path
    log.info("run %s wrote %s", result.run_id, ", ".join(written) or "nothing")
    return written
