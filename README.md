# countbone

**Film the shelf. Get the count.** Stock counting by phone video, from the
count itself to the signed-off correction in the ERP and the supplier claim
with the video as proof. No hardware to install.

```
Capture → Pre-process → Detect → Identify → Count → Output
```

That backbone never changes; everything else attaches to it: adaptive
sampling, photo-trained product recognition, review, shelf checks, audit
packs. Around it sits the product:

| Module | What it does |
|---|---|
| **Count** | Cycle counts by video from the phone app, with live coaching; bay QR labels; walks that merge overlapping videos; recount tasks when a count disagrees with the book |
| **Catalog studio** | Teach a product with about five photos; tells look-alikes apart that colour cannot |
| **Reconcile** | Differences become valued adjustments, approved by rules (auto / manager / finance) and posted to Shopify, NetSuite, SAP, a signed webhook, or CSV |
| **Receive** | Film a delivery against its PO; shortages draft supplier claims |
| **Evidence** | Ed25519-signed claim packs anyone can verify offline, over a hash-chained audit trail |
| **Shelf** | Empty facings (with photos) and planogram compliance from the same walk |
| **Count-as-a-Service** | Scheduled crew visits; consented footage exported as COCO training data |

What it is (and is not yet) good for: [docs/PRODUCT.md](docs/PRODUCT.md).

---

## Try it in 30 seconds

```bash
pip install -e ".[api,dev]"
countbone demo
```

`demo` renders a synthetic shelf with known ground truth, counts it, and scores itself:

```
synthetic shelf: examples/demo_shelf.webm  (34 units, 144 frames)

run run_ad7e76965deb  (1.30s)
frames: 26 used, 3 dropped  detections: 388  tracks: 34

  SKU             count  expected   var   conf  truth   err
  ---------------------------------------------------------
  SKU-BLU            11        11    +0    94%     11    +0
  SKU-GRN             8         8    +0    97%      8    +0
  SKU-RED            10        10    +0    95%     10    +0
  SKU-YEL             5         5    +0    97%      5    +0
  TOTAL              34

confidence: 95%   needs review: no (0 item(s))

absolute count error: 0 of 34 (0.0%)
```

## Run the product

```bash
countbone serve                 # http://127.0.0.1:8000
```

The first start prints a **setup code**; open the dashboard, enter it, and
create the admin account (only someone who can see the server's console can
claim a new server). Then add people, bays and products, and install the
phone app ([mobile/README.md](mobile/README.md)).

Accounts from the command line, for scripts and lost passwords:

```bash
countbone user add maria --role manager
countbone user reset-password maria
```

For a customer deployment (Docker, TLS, backups, upgrades), see
[docs/DEPLOY.md](docs/DEPLOY.md). `countbone serve --no-auth` gives a
single-user local demo and refuses to listen on anything but localhost.

## The dashboard

Dark, dense and keyboard-driven, served by `countbone serve`:

- **Counts**: every video counted, live progress, results against the book, the review drawer
  (crop, the model's own candidates, keyboard shortcuts), the frame inspector, and a shelf tab
  with gap photos, planogram differences and a picture of every counted object.
- **Recount tasks, Walks, Receive, Locations** (book stock, planograms, printable QR labels),
  **Catalog studio**, **Reconcile** (inbox, bulk approval, posting, rules, period report),
  **Evidence & claims** (signed packs, pack and audit-chain verification), **Service jobs**, and
  **Settings** (people and roles, API keys, integrations).

The source lives in [`web/`](web/README.md). Its build ships inside the Python package, so running
the dashboard needs no Node.

## The phone app

[`mobile/`](mobile/README.md): scan the bay label, film with live coaching
(sharpness, light, pace, direction, tilt, distance, with a direction arrow and
a status pill), and the video uploads by itself in resumable chunks, even
after a dead zone. Then the summary against the book, swipe-to-review on the
spot, and recount tasks. Try it in a browser with `npm run web`.

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
the demo above counts 52 instead of 34 — one carton becomes several. With it, 34. Motion is tracked through frames the quality gate drops, too: skipping it split every carton in view at a dropped frame (see `docs/ARCHITECTURE.md`).

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

- **The default detector is a classical baseline.** `contour` finds boxes by edges and contrast: it
  works on separated items against a contrasting background and degrades on dense, touching or
  occluded stock. For real stores, train a detector (the consented Count-as-a-Service footage
  exports as COCO for exactly this) and use `detect.backend: yolo`.
- **Product recognition is few-shot, not deep.** The photo index (OpenCV features, nearest
  exemplar, self-calibrated thresholds) separates look-alike packaging on the test range and
  flags products nobody photographed, but it is not a trained deep model; a learned embedder
  drops in behind `appearance.embed`.
- **Accuracy is proven on synthetic footage.** 30/30 shelves exact with adaptive sampling,
  10/10 look-alike shelves after five photos per product, every empty facing found: regression
  guards with known ground truth, not a claim about a warehouse. A pilot measures that
  (see [docs/PRODUCT.md](docs/PRODUCT.md)).
- **Video sees the front of the shelf.** Stock hidden behind the front facing is not counted.
- **Evidence packs are signed, not notarised.** Ed25519 proves a pack came unaltered from this
  deployment; proving *when* needs an external timestamp, which is not built.
- **Compliance is policy, not code.** Face blurring, retention limits and a DPA are configuration
  and contract decisions; this repo gives you the hooks to implement them, not the legal position.

## Roadmap

Done on the `product-suite` branch: accounts and roles, adaptive sampling with continuity-aware
confidence, photo-trained identity, locations and QR labels, walks, recount tasks, Reconcile with
ERP connectors, Receive, signed Evidence packs, shelf checks, Catalog studio, service jobs, the
phone app with an offline upload queue, and a Docker deployment.

Next: a trained detector from pilot footage, external timestamping of evidence, multi-worker
counting on a shared queue and database for multi-site customers, and native-device testing of the
phone app. Review and reasoning: [docs/REVIEW_AND_ROADMAP.md](docs/REVIEW_AND_ROADMAP.md).

## Docs

- [docs/PRODUCT.md](docs/PRODUCT.md): the modules, a pilot playbook, pricing shape, what is proven
- [docs/DEPLOY.md](docs/DEPLOY.md): running it for a customer, backups, upgrades, security checklist
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): why the seams are where they are
- [docs/PLUGINS.md](docs/PLUGINS.md): the full plugin contract and every built-in's options
- [examples/config.example.yaml](examples/config.example.yaml): every knob, with defaults
- [examples/catalog.example.yaml](examples/catalog.example.yaml): the SKU catalog format

## Development

```bash
pip install -e ".[api,dev]"
pytest && ruff check .
cd web && npm ci && npm run build          # dashboard, into the Python package
cd mobile && npm ci && npm run typecheck && npm test
```

## License

MIT — see [LICENSE](LICENSE).
