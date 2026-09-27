# Countbone: health check, feature roadmap, ecosystem

*Review of branch `dashboard-and-mobile`, 2026-09-27. Nothing in sections 3 and 4
has been built; they are proposals awaiting a decision.*

---

## 1. Health check: what was run, what came back

| Part | Check | Result |
|---|---|---|
| Backend | `pytest` (123 tests), `ruff check` | all pass, lint clean |
| Backend | live `countbone serve --allow-origin …`, HTTP upload → poll → artifacts | works: seed 11 counted 37/37, CORS header correct, inspector.json served |
| Backbone accuracy | `countbone demo` on 7 seeds never used in tests (3, 11, 21, 31, 42, 55, 77) | 6 exact, **seed 21 off by 3 of 32** (see 2.1) |
| Dashboard | `npm run build` (tsc + vite) | builds, 148 kB gzip JS |
| Mobile | `tsc --noEmit` | **was failing (4 errors), fixed in this commit** |
| Mobile | analysis engine tests (10) | all pass |
| Mobile | `expo-doctor` | 21/21 checks pass |
| Mobile | `expo export --platform web` | bundles, but **there are no screens yet** (see 2.2) |

## 2. Findings, in order of how much they matter

### 2.1 A fast walk undercounts silently, with high confidence
Seed 21 counted 29 of 32 at **95% confidence, needs review: no**. Root cause
isolated by re-running at different frame strides:

| every_n_frames | tracks | error |
|---|---|---|
| 1 | 32 | 0 |
| 2 | 32 | 0 |
| 3 | 32 | 0 |
| 5 (default) | 29 | −3 |

The tracker links objects across frames by box overlap. The default stride of 5,
plus 5 of 29 sampled frames rejected by the quality gate, left gaps where items
moved more than about a box width between usable frames. Merged detections were
ruled out: no counted track has an abnormal box area.

Why this matters: confidence only measures colour identification, not tracking
continuity, so the system reports a wrong answer as a certain one. For a
stock-count product, that is the worst failure mode.

Two amplifiers:
- The `tolerance` plugin is not in `DEFAULT_PLUGINS`, so a count that misses
  every expected SKU still says "needs review: no".
- The test seeds all pan slowly, so CI cannot see this.

Proposed fix (not applied):
- Measure per-gap motion ÷ median box width.
- Adaptively re-sample the skipped frames in that window when the ratio exceeds about 0.5.
- Fold a "tracking continuity" term into confidence.
- Enable tolerance whenever expected counts exist.
- Add a fast-pan seed to the tests.

The mobile app's "Slow Down" cue is the capture-side half of this fix.

### 2.2 The mobile app is an engine without a body
Done and tested:
- The analysis engine (blur calibrated to the backend within 1%, exposure,
  motion/shift, scale, edge boxes, debounced guidance cues).
- Theme tokens.
- Permissions.

Not built:
- Every screen: capture, HUD, record button, processing/summary, swipe review, history, settings.
- The camera feeds (VisionCamera native, getUserMedia web).
- The API client.

The app launches to Expo Router's "unmatched route" page. Native builds need
EAS or a Mac or Android SDK, and have not been run anywhere.

### 2.3 No authentication, anywhere
Anyone who can reach the port can:
- Upload.
- Resolve or undo reviews. The `reviewer` field is free text and defaults to "anonymous", so the audit trail is not attributable.
- Submit a server-side path to `/api/runs`.

This is fine on localhost and not sellable. Minimum: API keys per site, and a
signed-in reviewer identity written into `review_decision` audit rows.

### 2.4 Works on synthetic footage; unproven on real shelves
Every accuracy number comes from generated video: flat, coloured, uncluttered
cartons. Real aisles bring:
- Look-alike packaging. The colour identifier can separate maybe 6–8 SKUs by hue, and a real store has thousands.
- Shrink-wrap glare.
- Items stacked behind items. Video only sees facings.
- Partial occlusion by price rails.

The architecture (plugins, audit pack, review loop) will carry over. The
contour detector and colour identifier will not. A `yolo` detector backend
exists, but no learned SKU identifier does.

### 2.5 Operational limits (fine now, fix before multi-site)
- The in-memory `RunTracker`: queued runs are lost on restart.
- One worker thread.
- SQLite.
- Local-disk video.
- Progress by polling.

None of these are bugs at pilot scale.

## 3. Features: add, replace, cut (proposals only)

**P0: required before a paying pilot**
1. **Tracking-continuity confidence and adaptive stride** (2.1). Small change, removes the worst failure.
2. **Learned SKU identity** *(replace the colour identifier)*: an image-embedding model with few-shot enrolment ("photograph 5 facings of a new SKU"), plus reading barcodes and shelf labels when visible.
3. **Auth and attributable reviews** (2.3).
4. **Finish the mobile app** (2.2).
5. **Tolerance on by default** when expected counts exist.

**P1: what makes customers stay**
6. **Location anchoring**: a QR or label per bay/rack scanned at the start of a walk, so counts attach to a location, not just a video.
7. **Overlap de-duplication**: the same bay walked twice, or two phones in adjacent aisles, must not double count.
8. **Offline-first mobile**: queue recordings and resume uploads (tus protocol), since warehouses have Wi-Fi dead zones.
9. **Recount tasks**: a variance creates a task, assigned to a person, with a due date and a closure proof.
10. **ERP/WMS connectors**: pull expected quantities and push approved adjustments. Start with CSV/SFTP and webhooks, then NetSuite, SAP, Odoo, Shopify.
11. **Per-location trend and shrink history** (the SKU history endpoint already exists).

**P2: scale**
12. Postgres, a job queue (arq or Celery), object storage for video, and Server-Sent Events instead of polling *(replace)*.
13. On-device counting for no-connectivity sites. The mobile engine already runs frame analysis in a worklet.
14. Stacked-depth estimation (facings × depth from a side pass). This is a research problem, so keep it out of promises.

**Cut or de-emphasise:** the "lux" readout on the mobile HUD. Phones expose
no calibrated lux sensor to apps on iOS, so it is an estimate. Label it
"light" rather than claiming a unit.

## 4. Ecosystem: products that make customers buy more than one thing

Market context:
- Retail inventory records are wrong most of the time: studies put 60–65% of SKU records inaccurate.
- Correcting them produced 4–8% sales lifts.
- Incumbents split by capture method:
  - Drones for high-bay warehouses (Corvus, Gather AI).
  - Fixed shelf cameras and robots for stores (Focal Systems, Simbe, Trax).
  - Phone scanning (Scandit MatrixScan Count, ShelfView).
  - Dock cameras for receiving (Vimaan).

Countbone's opening: **phone video, no hardware install**. It is cheap to start,
which suits mid-market warehouses, 3PLs and multi-site retailers that cannot
justify drones or shelf cameras.

The ecosystem should follow the stock's journey. Each product reuses the same
video → count → review → audit backbone with a different "expected" source.

```
      RECEIVE ──────────► STORE ──────────► SELL / SHIP
  Countbone Receive    Countbone Count     Countbone Shelf
  (count vs ASN/PO)    (cycle counts)      (gaps, planogram)
            \               |                 /
             └──── Countbone Reconcile ──────┘
          (variance desk, ERP sync, approvals)
                            |
                  Countbone Evidence
         (audit packs → vendor claims, insurance, auditors)
```

| Product | What it does | Why a Count customer buys it | Reuse of today's code |
|---|---|---|---|
| **Receive** | Film a pallet or truck unload; count vs the ASN/PO; flag shorts with photo evidence while the driver is still at the dock | Most inventory errors start at receiving; stops them before they reach the shelf | High: the pipeline as is; expected comes from the ASN instead of the catalog |
| **Shelf** | From the same walk video: out-of-stock gaps, facings, planogram compliance | Zero extra labour: the walk they already do for Count | Medium: new analytics plugin on existing detections |
| **Reconcile** | Variance inbox, approval rules by value (tolerance bands already exist), push adjustments to ERP | Becomes the system finance signs off on, which is the lock-in | High: review queue, tolerance, audit trail |
| **Evidence** | Tamper-evident audit packs (already hashed) turned into vendor chargeback claims, insurance and loss files, external-auditor year-end packs | Turns counting from a cost into recovered money; easy ROI story | High: `audit_pack` plugin already hashes artifacts |
| **Enrol** (Catalog Studio) | Photograph a SKU a few times to teach the identifier | Needed for P0 item 2 anyway; sell it as self-serve onboarding | New |
| **Count-as-a-Service** | Your crews walk their site with the app monthly | Services revenue; also your data engine for training models on real footage | Uses the mobile app |

**Recommended sequencing:**
1. **Count + Reconcile** first. Reconcile is where the money decision lives, and it builds on code that exists.
2. **Receive** second. Same pipeline, a buyer persona the customer already has (the receiving lead), and the fastest ROI.
3. **Evidence** as the premium tier.
4. **Shelf** only for retail customers.

**Pricing shape to test:** per site per month for Count; Reconcile bundled into
a higher tier; Receive per dock door; Evidence as a percentage of recovered
claims or a flat premium add-on.

## Sources
- [Corvus One inventory drones (DroneDJ, 2026)](https://dronedj.com/2026/03/03/corvus-one-inventory-warehouse-drone/)
- [Gather AI drone vision](https://gather.ai/platform/vision/drone)
- [Warehouse drone market outlook (CXTMS)](https://cxtms.com/blog/warehouse-drones-autonomous-inventory-scanning-7-billion-market-2026)
- [Focal Systems retail OS (IBM)](https://www.ibm.com/new/product-blog/focal-systems-boosting-store-performance-with-an-ai-retail-operating-system-and-real-time-data)
- [Planogram compliance landscape (CB Insights)](https://www.cbinsights.com/esp/consumer-&-retail/in-store-tech/planogram-compliance-&-inventory-visibility)
- [Scandit store operations / MatrixScan Count](https://www.scandit.com/industries/retail/store-operations/)
- [Vimaan inbound pallet receiving](https://vimaan.ai/inbound-pallet-receiving-automation/)
- [Dock door verification (iFactory)](https://ifactoryapp.com/ai-vision-camera/ai-vision-dock-door-monitoring-inbound-outbound-verification)
- [Inventory accuracy and phantom inventory (RELEX)](https://www.relexsolutions.com/resources/how-to-optimize-cycle-counting-and-banish-phantom-inventory/)
