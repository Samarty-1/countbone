# countbone

**Video in, counts out.** A stock-counting pipeline where the backbone is the product and every
other capability is a plugin.

Point a phone at a shelf, walk the aisle, and get a per-SKU count with a confidence score and a
queue of the things the system was not sure about.

```
Capture → Pre-process → Detect → Identify → Count → Output
```

That sequence never changes. Guided capture, confidence scoring, multi-frame validation, human
review, exception reports, tolerance rules and audit packs all attach to it through hooks. Adding
a capability means writing a class and naming it in a config file — not editing the pipeline.

---

## Try it in 30 seconds

```bash
pip install -e ".[api,dev]"
countbone demo
```

`demo` renders a synthetic shelf with known ground truth, counts it, and scores itself:

```
synthetic shelf: examples/demo_shelf.mp4  (34 units, 144 frames)

run run_628c61b93d2b  (0.64s)
frames: 27 used, 2 dropped  detections: 416  tracks: 33

  SKU             count  expected   var   conf  truth   err
  ---------------------------------------------------------
  SKU-BLU            11        11    +0    94%     11    +0
  SKU-GRN             8         8    +0    96%      8    +0
  SKU-RED             9        10    -1    90%     10    -1
  SKU-YEL             5         5    +0    95%      5    +0
  TOTAL              33

confidence: 93%   needs review: yes (18 item(s))
  ! 5 object(s) changed identity between frames

absolute count error: 1 of 34 (2.9%)
```

Then on your own footage:

```bash
countbone run shelf.mp4 --expect SKU-RED=10 --expect SKU-BLU=11
countbone serve            # dashboard + API on http://127.0.0.1:8000
```

## What you get

| | |
| --- | --- |
| **A count** | per SKU, with variance against expected stock |
| **A confidence score** | per item, per SKU, per run — not just a number with no error bar |
| **A review queue** | every uncertain item, with the crop the model actually saw |
| **An exception report** | the short list a stock controller reads, in `exceptions.md` |
| **An audit pack** | SHA-256 of the source video, the config, and every artifact produced |
| **A history** | SQLite, one row per SKU per count, so drift and shrinkage are queryable |

## The backbone

Each stage does one thing and is replaceable.

| Stage | Module | What it does | Swappable backends |
| --- | --- | --- | --- |
| Capture | `stages/capture.py` | sample frames from a file or camera | file, camera index |
| Pre-process | `stages/preprocess.py` | normalise, measure blur / lighting / clipping | CLAHE, denoise |
| Detect | `stages/detect.py` | find object boxes | `contour` (no weights), `yolo`, `fixture` |
| Identify | `stages/identify.py` | assign a SKU from the catalog | `color`, `classmap`, `fixture` |
| Count | `stages/count.py` | one physical object = one count | `tracking`, `peak_frame`, `median_frame` |
| Output | `stages/output.py` | JSON, CSV, SQLite | all three, independently |

Counting is the hard part, and it is the part most systems get wrong. A camera panning an aisle
moves every box at once, so `stages/motion.py` estimates the global camera displacement between
frames by phase correlation and the tracker predicts each box forward by it. Without that step,
the demo above counts 56 instead of 34 — one carton becomes several. With it, 33.

## The plugins

Six ship enabled by default; `tolerance` is opt-in because it needs expected counts.

| Plugin | Layer | What it does |
| --- | --- | --- |
| `quality_gate` | capture | drops blurred, dark, blown-out frames and says why |
| `multiframe` | pipeline | an object must be seen in ≥ N frames to count |
| `confidence` | pipeline | scores every item, SKU and run; sets the review flag |
| `tolerance` | analytics | which variances matter, banded by unit value |
| `review_queue` | output | routes uncertain items to a human with evidence attached |
| `exception_report` | output | writes `exceptions.md` / `exceptions.json` |
| `audit_pack` | process | hashes source, config and artifacts into a manifest |

```bash
countbone plugins    # what is installed, in the order it runs
```

## Writing your own

Subclass `Plugin`, override the hooks you care about, and register it:

```python
from countbone import Plugin, register

@register
class ShrinkageAnalytics(Plugin):
    """Flag a SKU that keeps drifting down across counts."""

    name = "shrinkage"
    layer = "analytics"
    priority = 45        # lower numbers run first

    def configure(self, window: int = 5, **_):
        self.window = window

    def on_counts(self, ctx, result):
        for sku_count in result.counts:
            history = ctx.store.sku_history(sku_count.sku, limit=self.window)
            counts = [h["count"] for h in history]
            if len(counts) >= 3 and counts == sorted(counts):     # monotonic decline
                result.warnings.append(f"{sku_count.sku} has fallen every count")
                result.needs_review = True
        return result
```

```yaml
# my-config.yaml
plugins:
  - quality_gate
  - confidence
  - name: shrinkage
    options: { window: 8 }
```

Hooks, in the order the backbone fires them:

| Hook | Gets | Can |
| --- | --- | --- |
| `on_run_start(ctx)` | the context | set up, hash the source |
| `on_frame(ctx, frame)` | one frame | rewrite it, or return `None` to drop it |
| `on_detections(ctx, frame, dets)` | raw boxes | filter, merge, re-score |
| `on_items(ctx, frame, items)` | identified boxes | re-label, add OCR/barcode evidence |
| `on_tracks(ctx, tracks)` | grouped sightings | reject or split tracks |
| `on_counts(ctx, result)` | the finished count | adjust, flag, annotate |
| `on_output(ctx, result)` | the finished count | write files, call an ERP (side effects only) |
| `on_run_end(ctx, result)` | result or `None` | clean up, even after a failure |

A plugin that raises is logged, recorded as a warning on the run, and skipped. One bad plugin
cannot take the backbone down mid-count.

## Honest limitations

- **The default detector is a classical baseline.** `contour` uses edges and contours: it works on
  separated items with visible edges against a contrasting background, and degrades on dense,
  touching, or occluded stock. That limitation is exactly why `confidence` and `review_queue`
  exist. For real inventory, train a detector and use `detect.backend: yolo`.
- **The default identifier matches colour**, not artwork. Real SKUs need a trained classifier, OCR
  or a barcode fallback — all of which fit behind the `Identifier` protocol or the `on_items` hook.
- **The 2.9% demo error is on synthetic footage.** It is a regression guard for the backbone, not a
  claim about a warehouse. Accuracy on real stock depends entirely on the detector you plug in.
- **The audit pack is tamper-evident, not tamper-proof.** Anyone who can rewrite the pack can
  rewrite the hashes. Notarising the manifest hash externally is the next step, deliberately out
  of scope here.
- **Compliance is policy, not code.** Face blurring, retention limits and a DPA are configuration
  and contract decisions; this repo gives you the hooks to implement them, not the legal position.

## Roadmap

Phase 1 — the MVP, and what this repo is: backbone, confidence, review queue, dashboard.
Phase 2 — hardening: anti-gaming controls, blind recounts, sampling audits, retention policy.
Phase 3 — value-add: shrinkage analytics, drift tracking, ERP export, cycle-count scheduling.

Each phase adds plugins. The backbone does not change. See [docs/ROADMAP.md](docs/ROADMAP.md).

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — why the seams are where they are
- [docs/PLUGINS.md](docs/PLUGINS.md) — the full plugin contract and every built-in's options
- [examples/config.example.yaml](examples/config.example.yaml) — every knob, with defaults
- [examples/catalog.example.yaml](examples/catalog.example.yaml) — the SKU catalog format

## Development

```bash
pip install -e ".[api,dev]"
pytest              # 96 tests
ruff check .
```

## License

MIT — see [LICENSE](LICENSE).
