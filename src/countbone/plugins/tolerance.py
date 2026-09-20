"""Analytics-layer plugin: decide which variances actually matter.

A one-unit miscount on 4-dollar cartons is noise. A one-unit miscount on
800-dollar tools is an incident. Tolerance bands turn raw variance into a
decision, and they are a business rule, so they live in config.
"""

from __future__ import annotations

from typing import Any

from ..context import RunContext
from ..types import CountResult
from .base import Plugin, register

DEFAULT_BANDS = [
    # up to unit_value, allowed absolute units, allowed fraction of expected
    {"max_unit_value": 10.0, "abs": 2, "pct": 0.03},
    {"max_unit_value": 100.0, "abs": 1, "pct": 0.01},
    {"max_unit_value": None, "abs": 0, "pct": 0.0},
]


@register
class ToleranceRules(Plugin):
    """Decide which variances matter, by how much the stock is worth."""

    name = "tolerance"
    layer = "analytics"
    priority = 40

    def configure(self, bands: list[dict[str, Any]] | None = None, **_: Any) -> None:
        self.bands = bands or DEFAULT_BANDS
        for band in self.bands:
            if "abs" not in band and "pct" not in band:
                raise ValueError(f"tolerance band needs abs and/or pct: {band}")

    def band_for(self, unit_value: float) -> dict[str, Any]:
        for band in self.bands:
            ceiling = band.get("max_unit_value")
            if ceiling is None or unit_value <= float(ceiling):
                return band
        return self.bands[-1]

    def on_counts(self, ctx: RunContext, result: CountResult) -> CountResult:
        catalog = ctx.state.get("catalog")
        exceptions = []

        for sku_count in result.counts:
            if sku_count.variance is None:
                continue  # nothing expected, so nothing to be out by
            entry = catalog.by_sku(sku_count.sku) if catalog else None
            unit_value = entry.unit_value if entry else 0.0
            band = self.band_for(unit_value)
            allowed = max(
                int(band.get("abs", 0)),
                int(round(float(band.get("pct", 0.0)) * (sku_count.expected or 0))),
            )
            breach = abs(sku_count.variance) > allowed
            sku_count.evidence["tolerance"] = {
                "unit_value": unit_value,
                "allowed_units": allowed,
                "variance": sku_count.variance,
                "within_tolerance": not breach,
                "value_at_risk": round(abs(sku_count.variance) * unit_value, 2),
            }
            if breach:
                exceptions.append(
                    {
                        "sku": sku_count.sku,
                        "counted": sku_count.count,
                        "expected": sku_count.expected,
                        "variance": sku_count.variance,
                        "allowed_units": allowed,
                        "value_at_risk": round(abs(sku_count.variance) * unit_value, 2),
                    }
                )

        if exceptions:
            result.needs_review = True
            result.meta["tolerance_exceptions"] = exceptions
            at_risk = sum(e["value_at_risk"] for e in exceptions)
            result.warnings.append(
                f"{len(exceptions)} SKU(s) outside tolerance, "
                f"{at_risk:.2f} of stock value at risk"
            )
        return result
