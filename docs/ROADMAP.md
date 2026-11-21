# Roadmap

The backbone does not change. Each phase adds plugins.

## Phase 1 — MVP (this repo)

Prove that video in produces a count out, and that the system knows when it is unsure.

- [x] Backbone pipeline: capture → pre-process → detect → identify → count → output
- [x] Global camera motion compensation, so a pan does not multiply the count
- [x] Three counting strategies for three camera setups
- [x] Confidence scoring per item, per SKU, per run
- [x] Human review queue with evidence crops
- [x] Dashboard and HTTP API
- [x] Count history in SQLite
- [x] Exception report and audit pack

## Phase 2 — hardening

Make a count defensible when somebody disputes it.

- [ ] Anti-gaming controls: who filmed, when, device identity, GPS, server-side timestamps
- [x] Blind recount scheduling: a second count with the first one hidden (the audit sample's tasks show neither number)
- [x] Sampling audits: recount 5–10% of SKUs and measure agreement (`insights.sample_audit`, agreement with a 95% interval)
- [ ] Guided capture: pan-speed and coverage feedback while filming
- [ ] Marker verification: ArUco or QR on the shelf proves which shelf was filmed
- [ ] Retention policy and face blurring as configurable capture-layer plugins
- [ ] External notarisation of the audit manifest hash
- [x] Tolerance rules by item value

## Phase 3 — value-add

Turn a count into an operational signal.

- [x] Shrinkage analytics across counts (by cause, SKU, location and month)
- [x] Drift tracking per SKU with alerting (a run of unexplained losses at one bay)
- [x] Discrepancy cause categorisation (miscount / misplacement / receiving error / unexplained loss or gain; theft is never asserted, only left unexplained)
- [ ] ERP export connectors
- [x] Cycle-count scheduling: what to count next, by value and volatility (ABC classes, intervals per class, how often a bay's counts change the book)
- [ ] Finance approval workflow on top of the review queue

## Detector work, orthogonal to the phases

The classical `contour` detector is a baseline that proves the backbone, not a production
detector. Real accuracy comes from:

- [ ] A labelled dataset of the customer's own stock
- [ ] A trained detector behind `detect.backend: yolo`
- [ ] A trained SKU classifier, or OCR/barcode fallback, behind the `Identifier` protocol
- [ ] Accuracy measured against manual counts, per customer, and published in the exception report
