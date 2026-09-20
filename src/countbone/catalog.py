"""The SKU catalog: what the system is allowed to call things.

Identification is a closed-set problem in a stockroom. The catalog is the set,
and it is customer data, not code, so it lives in YAML.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


@dataclass
class SkuEntry:
    sku: str
    label: str = ""
    hue: tuple[int, int] | None = None   # OpenCV hue range 0-179, may wrap past 179
    min_saturation: int = 60             # below this the patch is treated as achromatic
    achromatic: bool = False             # matches greys/whites/blacks instead of a hue
    classes: list[str] = field(default_factory=list)  # detector class names that map here
    unit_value: float = 0.0              # used by the tolerance plugin
    expected: int | None = None

    def matches_hue(self, hue: float) -> bool:
        if self.hue is None:
            return False
        lo, hi = self.hue
        if lo <= hi:
            return lo <= hue <= hi
        return hue >= lo or hue <= hi  # wraps through 0 (red)

    def hue_center_distance(self, hue: float) -> float:
        """0.0 dead centre of the band, 1.0 at its edge. Drives confidence."""
        if self.hue is None:
            return 1.0
        lo, hi = self.hue
        span = (hi - lo) if lo <= hi else (180 - lo + hi)
        if span <= 0:
            return 1.0
        offset = (hue - lo) % 180
        return min(1.0, abs(offset - span / 2) / (span / 2))


@dataclass
class Catalog:
    entries: list[SkuEntry] = field(default_factory=list)

    @classmethod
    def load(cls, path: str | Path | None) -> Catalog:
        if path is None:
            return cls.default()
        raw = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
        return cls.from_dict(raw)

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> Catalog:
        entries = []
        for item in raw.get("skus", []) or []:
            hue = item.get("hue")
            entries.append(
                SkuEntry(
                    sku=item["sku"],
                    label=item.get("label", item["sku"]),
                    hue=tuple(hue) if hue else None,  # type: ignore[arg-type]
                    min_saturation=item.get("min_saturation", 60),
                    achromatic=item.get("achromatic", False),
                    classes=list(item.get("classes", []) or []),
                    unit_value=float(item.get("unit_value", 0.0)),
                    expected=item.get("expected"),
                )
            )
        return cls(entries)

    @classmethod
    def default(cls) -> Catalog:
        """A primary-colour catalog so the demo and tests work out of the box."""
        return cls(
            [
                SkuEntry("SKU-RED", "Red carton", hue=(170, 10), unit_value=4.50),
                SkuEntry("SKU-YEL", "Yellow carton", hue=(20, 35), unit_value=3.20),
                SkuEntry("SKU-GRN", "Green carton", hue=(45, 85), unit_value=6.80),
                SkuEntry("SKU-BLU", "Blue carton", hue=(95, 130), unit_value=5.10),
            ]
        )

    def by_sku(self, sku: str) -> SkuEntry | None:
        return next((e for e in self.entries if e.sku == sku), None)

    def by_class(self, class_name: str) -> SkuEntry | None:
        name = (class_name or "").lower()
        return next((e for e in self.entries if name in [c.lower() for c in e.classes]), None)

    def expected_counts(self) -> dict[str, int]:
        return {e.sku: e.expected for e in self.entries if e.expected is not None}

    def __len__(self) -> int:
        return len(self.entries)
