"""Configuration for a pipeline run.

One YAML file describes the backbone (which detector, how to sample frames,
how to count) and the list of plugins to load. Nothing else configures the
system, so a run is reproducible from the config hash alone.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import yaml


@dataclass
class CaptureConfig:
    every_n_frames: int = 5          # sample rate through the source video
    max_frames: int | None = 400     # hard cap so a long video cannot stall a run
    start_s: float = 0.0
    end_s: float | None = None
    resize_width: int | None = 960   # None keeps native resolution


@dataclass
class PreprocessConfig:
    denoise: bool = False
    clahe: bool = True               # local contrast, helps in poor warehouse light
    grayscale_stats: bool = True     # attach blur/brightness metrics to each frame


@dataclass
class DetectConfig:
    backend: str = "contour"         # contour | yolo | fixture
    min_score: float = 0.25
    min_area_frac: float = 0.0008    # reject specks
    max_area_frac: float = 0.25      # reject the shelf itself
    max_detections: int = 300
    nms_iou: float = 0.45
    model_path: str | None = None    # for the yolo backend
    device: str = "cpu"


@dataclass
class IdentifyConfig:
    backend: str = "color"           # color | classmap | fixture
    catalog: str | None = None       # path to a SKU catalog YAML
    min_confidence: float = 0.2
    unknown_sku: str = "UNKNOWN"


@dataclass
class CountConfig:
    strategy: str = "tracking"       # tracking | peak_frame | median_frame
    track_iou: float = 0.3
    track_max_gap: int = 2           # frames a track may vanish for and survive
    min_hits: int = 2                # a track needs this many sightings to count
    expected: dict[str, int] = field(default_factory=dict)


@dataclass
class OutputConfig:
    dir: str = "runs"
    json: bool = True
    csv: bool = True
    sqlite: str | None = "countbone.db"
    save_crops: bool = True


@dataclass
class PluginSpec:
    name: str
    options: dict[str, Any] = field(default_factory=dict)
    enabled: bool = True


DEFAULT_PLUGINS = [
    PluginSpec("quality_gate"),
    PluginSpec("multiframe"),
    PluginSpec("confidence"),
    PluginSpec("review_queue"),
    PluginSpec("exception_report"),
    PluginSpec("audit_pack"),
]


@dataclass
class Config:
    capture: CaptureConfig = field(default_factory=CaptureConfig)
    preprocess: PreprocessConfig = field(default_factory=PreprocessConfig)
    detect: DetectConfig = field(default_factory=DetectConfig)
    identify: IdentifyConfig = field(default_factory=IdentifyConfig)
    count: CountConfig = field(default_factory=CountConfig)
    output: OutputConfig = field(default_factory=OutputConfig)
    plugins: list[PluginSpec] = field(default_factory=lambda: list(DEFAULT_PLUGINS))

    # ---- construction -------------------------------------------------
    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> Config:
        raw = dict(raw or {})
        plugins_raw = raw.pop("plugins", None)
        sections = {
            "capture": CaptureConfig,
            "preprocess": PreprocessConfig,
            "detect": DetectConfig,
            "identify": IdentifyConfig,
            "count": CountConfig,
            "output": OutputConfig,
        }
        # A misspelled section used to be dropped in silence, so a config that
        # looked applied ran on defaults instead.
        unknown = set(raw) - set(sections)
        if unknown:
            raise ValueError(
                f"unknown config section(s): {', '.join(sorted(unknown))}; "
                f"expected any of {', '.join(sections)}, plugins"
            )
        built = {}
        for key, section_cls in sections.items():
            try:
                built[key] = section_cls(**(raw.get(key) or {}))
            except TypeError as exc:
                raise ValueError(f"bad option in config section {key!r}: {exc}") from None
        cfg = cls(**built)
        if plugins_raw is not None:
            cfg.plugins = [_plugin_spec(p) for p in plugins_raw]
        return cfg

    @classmethod
    def load(cls, path: str | Path | None) -> Config:
        if path is None:
            return cls()
        data = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
        return cls.from_dict(data)

    # ---- serialisation ------------------------------------------------
    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["plugins"] = [
            {"name": p.name, "enabled": p.enabled, "options": p.options} for p in self.plugins
        ]
        return d

    def fingerprint(self) -> str:
        """Stable hash of the whole config: goes into every audit pack."""
        blob = json.dumps(self.to_dict(), sort_keys=True, default=str)
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def _plugin_spec(entry: Any) -> PluginSpec:
    if isinstance(entry, str):
        return PluginSpec(entry)
    if isinstance(entry, dict):
        if "name" in entry:
            return PluginSpec(
                name=entry["name"],
                options=entry.get("options", {}) or {},
                enabled=entry.get("enabled", True),
            )
        # shorthand: {plugin_name: {opt: val}}
        (name, options), = entry.items()
        options = dict(options or {})
        enabled = options.pop("enabled", True)
        return PluginSpec(name=name, options=options, enabled=enabled)
    raise ValueError(f"cannot read plugin spec from {entry!r}")
