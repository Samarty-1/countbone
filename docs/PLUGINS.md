# Plugins

Everything that is not the backbone is a plugin. This is the full contract and the options for
each built-in.

## The contract

```python
from countbone import Plugin, register

@register
class MyPlugin(Plugin):
    name = "my_plugin"      # required, unique; this is the name used in config
    layer = "pipeline"      # capture | pipeline | output | analytics | process
    priority = 100          # lower runs first, within every hook

    def configure(self, threshold: float = 0.5, **_):
        """Validate options here. Raise on bad config; never fail late."""
        self.threshold = float(threshold)
```

Options come from the config file and are passed to `configure()` as keyword arguments. Accept
`**_` so an unknown key from a newer config does not crash an older plugin.

### Hooks

| Hook | Signature | Return | Notes |
| --- | --- | --- | --- |
| `on_run_start` | `(ctx)` | — | before any frame is read |
| `on_frame` | `(ctx, frame)` | `Frame` or `None` | `None` drops the frame |
| `on_detections` | `(ctx, frame, detections)` | `list[Detection]` | before identification |
| `on_items` | `(ctx, frame, items)` | `list[Item]` | the frame is still in hand here |
| `on_tracks` | `(ctx, tracks)` | `list[Track]` | after grouping, before counting |
| `on_counts` | `(ctx, result)` | `CountResult` | the last chance to change the answer |
| `on_output` | `(ctx, result)` | — | side effects only; the result is final |
| `on_run_end` | `(ctx, result \| None)` | — | always runs, even after a failure |

Returning `None` from a transforming hook means "unchanged" everywhere except `on_frame`, where it
means "drop this frame".

### The context

| Attribute | What it is |
| --- | --- |
| `ctx.config` | the full `Config` for this run |
| `ctx.run_id` | the run identifier |
| `ctx.source` | the video path or camera index |
| `ctx.store` | the `Store`, or `None` if persistence is off |
| `ctx.artifacts_dir` | per-run directory; created on first access |
| `ctx.state` | shared dict for passing data between plugins |
| `ctx.warn(msg)` | record a warning on the run |
| `ctx.setdefault(key, factory)` | get-or-create in `ctx.state` |

### Registering

Importing the module is what registers the plugin, so for a plugin outside this package, import it
before building the pipeline:

```python
import my_package.plugins          # runs the @register decorators
from countbone import Config, Pipeline

cfg = Config.load("my-config.yaml")   # can now name "my_plugin"
Pipeline(cfg).run("shelf.mp4")
```

---

## Built-ins

### `quality_gate` — capture, priority 10

Drops frames the detector cannot work with, and records why.

| Option | Default | Meaning |
| --- | --- | --- |
| `min_blur` | `45.0` | variance of the Laplacian; below this the frame is soft |
| `min_brightness` | `35.0` | mean luminance floor |
| `max_brightness` | `225.0` | mean luminance ceiling |
| `max_clipped_frac` | `0.28` | fraction of pixels crushed to black or blown to white |
| `max_drop_rate` | `0.5` | above this share of dropped frames, warn and flag for review |

Requires `preprocess.grayscale_stats: true`.

### `multiframe` — pipeline, priority 20

An object must be corroborated across frames.

| Option | Default | Meaning |
| --- | --- | --- |
| `min_frames` | `2` | sightings needed before a track is kept |
| `min_agreement` | `0.6` | share of sightings that must agree on the SKU |
| `drop_unstable` | `false` | discard flickering tracks instead of flagging them |

The default flags rather than drops: unstable identity is usually a real object seen badly.

### `confidence` — pipeline, priority 30

Scores items, SKUs and the run, and sets `needs_review`.

| Option | Default | Meaning |
| --- | --- | --- |
| `detect_weight` | `0.45` | weight on the detector's score |
| `identify_weight` | `0.40` | weight on identification confidence |
| `quality_weight` | `0.15` | weight on frame quality |
| `item_threshold` | `0.55` | below this an item is a review candidate |
| `sku_threshold` | `0.60` | below this a SKU count is doubtful |
| `run_threshold` | `0.65` | below this the whole run needs review |

Weights are normalised, so editing one cannot silently rescale the score.

### `tolerance` — analytics, priority 40

Turns raw variance into a decision, banded by unit value from the catalog. Not enabled by default,
because it only does something when expected counts exist.

| Option | Default |
| --- | --- |
| `bands` | `[{max_unit_value: 10, abs: 2, pct: 0.03}, {max_unit_value: 100, abs: 1, pct: 0.01}, {max_unit_value: null, abs: 0, pct: 0.0}]` |

The allowance for a SKU is `max(abs, round(pct × expected))`. A `max_unit_value: null` band is the
catch-all and must come last. Breaches are priced: `value_at_risk = |variance| × unit_value`.

### `review_queue` — output, priority 50

Routes what the system is unsure about to a person, with the crop attached.

| Option | Default | Meaning |
| --- | --- | --- |
| `sku_threshold` | `0.60` | raise one task for a whole doubtful SKU |
| `item_threshold` | `0.55` | raise a task per uncertain item |
| `max_items` | `40` | cap per run; the rest are counted as truncated |
| `save_crops` | `true` | write JPEG crops into `<run>/crops/` |
| `review_unknown` | `true` | always review anything identified as `UNKNOWN` |

A doubtful SKU is one review task, not one per unit.

### `exception_report` — output, priority 60

Writes `exceptions.md` and `exceptions.json`: variances ordered by size, low-confidence SKUs, and
warnings. Also stored in the audit table.

| Option | Default |
| --- | --- |
| `markdown` | `true` |
| `json_report` | `true` |

### `audit_pack` — process, priority 90

Writes `audit_pack.json`: SHA-256 of the source video, the full config and its fingerprint, the
plugin list, the result summary, and a hash of every artifact the run produced — then a hash of
that manifest.

| Option | Default |
| --- | --- |
| `hash_source` | `true` |
| `hash_artifacts` | `true` |

Runs last so it can hash the outputs of earlier output plugins. Tamper-evident, not tamper-proof.

---

## Plugin ideas that fit the existing hooks

Nothing below needs a backbone change.

| Idea | Layer | Hook |
| --- | --- | --- |
| ArUco / QR marker verification | capture | `on_frame` |
| Guided capture feedback (pan too fast, too close) | capture | `on_frame` |
| Offline queue / deferred upload | capture | `on_run_start`, `on_run_end` |
| OCR or barcode fallback identification | pipeline | `on_items` |
| Shelf-region masking | pipeline | `on_detections` |
| Shrinkage analytics across counts | analytics | `on_counts` + `ctx.store.sku_history` |
| Drift tracking per SKU | analytics | `on_counts` |
| Discrepancy cause categorisation | analytics | `on_counts` |
| Blind recount scheduling | process | `on_run_end` |
| Sampling audit (recount 5–10%) | process | `on_counts` |
| Anti-gaming: who filmed, when, from where | process | `on_run_start` |
| ERP / CSV export to an API | output | `on_output` |
| Face blurring for PDPA | capture | `on_frame` |
| Retention: auto-delete footage after N days | process | `on_run_end` |
