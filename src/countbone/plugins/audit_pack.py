"""Process-layer plugin: make a run provable after the fact.

If a count is ever disputed, the argument is about evidence, not opinion. The
audit pack fixes what was counted, from which file, under which configuration,
by hashing the source video and every artifact the run produced.

It is tamper-evident, not tamper-proof: anyone who can rewrite the pack can
rewrite the hashes. Notarising the manifest hash externally is the next step,
and deliberately out of scope here.
"""

from __future__ import annotations

import hashlib
import json
import platform
import time
from pathlib import Path
from typing import Any

from ..context import RunContext
from ..types import CountResult
from .base import Plugin, register


def sha256_file(path: str | Path, chunk: int = 1 << 20) -> str | None:
    p = Path(path)
    if not p.is_file():
        return None
    digest = hashlib.sha256()
    with p.open("rb") as fh:
        while block := fh.read(chunk):
            digest.update(block)
    return digest.hexdigest()


@register
class AuditPack(Plugin):
    """Hash the source, config and artifacts so a count can be proven later."""

    name = "audit_pack"
    layer = "process"
    priority = 90

    def configure(self, hash_source: bool = True, hash_artifacts: bool = True, **_: Any) -> None:
        self.hash_source = bool(hash_source)
        self.hash_artifacts = bool(hash_artifacts)

    def on_run_start(self, ctx: RunContext) -> None:
        # Hash the source before anything touches it, and record when we saw it.
        ctx.state["audit"] = {
            "observed_at": time.time(),
            "source": ctx.source,
            "source_sha256": sha256_file(ctx.source) if self.hash_source else None,
            "host": platform.node(),
            "platform": platform.platform(),
        }

    def on_output(self, ctx: RunContext, result: CountResult) -> None:
        audit = dict(ctx.state.get("audit", {}))
        artifacts: dict[str, Any] = {}
        if self.hash_artifacts:
            for path in sorted(ctx.artifacts_dir.rglob("*")):
                if path.is_file() and path.name != "audit_pack.json":
                    artifacts[str(path.relative_to(ctx.artifacts_dir))] = {
                        "sha256": sha256_file(path),
                        "bytes": path.stat().st_size,
                    }

        manifest = {
            "run_id": result.run_id,
            "created_at": time.time(),
            "source": audit,
            "config_fingerprint": ctx.config.fingerprint(),
            "config": ctx.config.to_dict(),
            "pipeline": {
                "detect": ctx.config.detect.backend,
                "identify": ctx.config.identify.backend,
                "count": ctx.config.count.strategy,
                "plugins": result.meta.get("plugins", []),
            },
            "result": {
                "total": result.total,
                "counts": {c.sku: c.count for c in result.counts},
                "overall_confidence": round(result.overall_confidence, 4),
                "needs_review": result.needs_review,
                "frames_read": result.frames_read,
                "frames_used": result.frames_used,
                "frames_dropped": result.frames_dropped,
            },
            "artifacts": artifacts,
        }
        body = json.dumps(manifest, indent=2, sort_keys=True, default=str)
        manifest_hash = hashlib.sha256(body.encode("utf-8")).hexdigest()
        signed = json.dumps(
            {"manifest_sha256": manifest_hash, "manifest": manifest},
            indent=2,
            sort_keys=True,
            default=str,
        )
        (ctx.artifacts_dir / "audit_pack.json").write_text(signed, encoding="utf-8")
        result.meta["audit"] = {
            "manifest_sha256": manifest_hash,
            "source_sha256": audit.get("source_sha256"),
        }
        if ctx.store is not None:
            ctx.store.add_audit(
                result.run_id,
                "audit_pack",
                {"manifest_sha256": manifest_hash, "source_sha256": audit.get("source_sha256")},
            )
