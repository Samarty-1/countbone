"""Output-layer plugin: the one-page summary a stock controller reads.

Not a dashboard and not the raw JSON: the short list of things that are wrong
or uncertain, in the order they should be dealt with.
"""

from __future__ import annotations

import json
from typing import Any

from ..context import RunContext
from ..types import CountResult
from .base import Plugin, register


@register
class ExceptionReport(Plugin):
    """Write the short list of variances and doubts a controller reads."""

    name = "exception_report"
    layer = "output"
    priority = 60

    def configure(self, markdown: bool = True, json_report: bool = True, **_: Any) -> None:
        self.markdown = bool(markdown)
        self.json_report = bool(json_report)

    def on_output(self, ctx: RunContext, result: CountResult) -> None:
        report = self._build(result)
        if self.json_report:
            (ctx.artifacts_dir / "exceptions.json").write_text(
                json.dumps(report, indent=2), encoding="utf-8"
            )
        if self.markdown:
            (ctx.artifacts_dir / "exceptions.md").write_text(
                self._render(result, report), encoding="utf-8"
            )
        if ctx.store is not None:
            ctx.store.add_audit(result.run_id, "exception_report", report)

    @staticmethod
    def _build(result: CountResult) -> dict[str, Any]:
        variances = [
            {
                "sku": c.sku,
                "counted": c.count,
                "expected": c.expected,
                "variance": c.variance,
                "within_tolerance": c.evidence.get("tolerance", {}).get("within_tolerance"),
            }
            for c in result.counts
            if c.variance not in (None, 0)
        ]
        return {
            "run_id": result.run_id,
            "total_counted": result.total,
            "overall_confidence": round(result.overall_confidence, 4),
            "needs_review": result.needs_review,
            "variances": sorted(
                variances, key=lambda v: abs(v["variance"] or 0), reverse=True
            ),
            "low_confidence_skus": [
                {"sku": c.sku, "count": c.count, "confidence": round(c.confidence, 4)}
                for c in result.counts
                if c.evidence.get("below_threshold")
            ],
            "reviews_pending": sum(1 for r in result.reviews if r.status == "pending"),
            "frames_dropped": result.frames_dropped,
            "warnings": result.warnings,
        }

    @staticmethod
    def _render(result: CountResult, report: dict[str, Any]) -> str:
        lines = [
            f"# Exception report - {result.run_id}",
            "",
            f"Source: `{result.source}`",
            f"Counted: **{report['total_counted']}** units across "
            f"{len(result.counts)} SKU(s)",
            f"Confidence: **{report['overall_confidence']:.0%}**",
            f"Needs review: **{'yes' if report['needs_review'] else 'no'}** "
            f"({report['reviews_pending']} item(s) queued)",
            "",
        ]
        if report["variances"]:
            lines += ["## Variance against expected", "",
                      "| SKU | Counted | Expected | Variance | Within tolerance |",
                      "| --- | ---: | ---: | ---: | :--- |"]
            for v in report["variances"]:
                within = {True: "yes", False: "**no**", None: "-"}[v["within_tolerance"]]
                lines.append(
                    f"| {v['sku']} | {v['counted']} | {v['expected']} | "
                    f"{v['variance']:+d} | {within} |"
                )
            lines.append("")
        if report["low_confidence_skus"]:
            lines += ["## Low confidence", ""]
            for c in report["low_confidence_skus"]:
                lines.append(f"- `{c['sku']}`: counted {c['count']} at {c['confidence']:.0%}")
            lines.append("")
        if report["warnings"]:
            lines += ["## Warnings", ""] + [f"- {w}" for w in report["warnings"]] + [""]
        if not (report["variances"] or report["low_confidence_skus"] or report["warnings"]):
            lines += ["No exceptions raised. Count is clean.", ""]
        return "\n".join(lines)
