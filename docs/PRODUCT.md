# What countbone sells

A phone and a video replace the clipboard: film a bay, get the count, and
turn every disagreement with the book into a signed-off correction or
recovered money. No hardware to install.

## The modules

Each module reuses the same backbone (video → count → review → proof); what
changes is where the expected numbers come from and what happens after.

| Module | Buyer | What it does | Where it lives |
|---|---|---|---|
| **Count** | Operations / inventory control | Cycle counts by video. Adaptive sampling, photo-trained product recognition, review queue, recount tasks, walks that merge overlapping videos, printable bay labels | Phone app, dashboard *Counts, Walks, Recount tasks, Locations* |
| **Catalog studio** | Inventory control | Teach products with ~5 photos; readiness and look-alike report; reviewers' corrections become examples | *Catalog studio* |
| **Reconcile** | Finance | Differences as adjustments with a value; rules decide auto-approve / manager / finance; post to Shopify, NetSuite, SAP, a signed webhook, or CSV; period report | *Reconcile* |
| **Receive** | Receiving / procurement | Count a delivery against its PO at the dock; shortages draft supplier claims with the video as evidence | *Receive* |
| **Evidence** | Finance / legal / loss prevention | Ed25519-signed claim packs anyone can verify offline; tamper-evident audit chain | *Evidence & claims* |
| **Shelf** | Retail merchandising | Empty facings with photos and planogram compliance from the same walk | Run → *Shelf & evidence* |
| **Count-as-a-Service** | Customers without spare staff | Your crews film their sites on a schedule; consented footage trains better models | *Service jobs*, COCO export |

## Why a customer stays

- **Reconcile is where finance signs off.** Once approvals and ERP postings
  run through it, it is the system of record for stock corrections.
- **The catalog compounds.** Every correction is a new example; switching
  vendor means re-teaching every product.
- **Evidence pays for itself.** A recovered supplier shortage is a number
  finance can put next to the subscription.

## Running a pilot (4 weeks)

**Week 0, setup (half a day on site).** Deploy (docs/DEPLOY.md). Import
locations and book stock for 2-3 aisles. Print and stick labels. Photograph
the 20-50 fastest-moving products. Create counter accounts; install the app.

**Week 1, calibrate.** Count the pilot aisles daily by video *and* by hand.
Compare in *Counts*. Photograph anything the studio flags; tune the reconcile
limits with the customer's finance lead.

**Weeks 2-3, run.** Video only. Recount tasks close the loop; managers
approve in *Reconcile*. Connect the ERP (or agree the CSV hand-off).
Receive two or three deliveries per week at one dock door.

**Week 4, review.** Report: counts per hour vs. the manual baseline, variance
found and its value, recount hit rate (how often the video was right),
claims raised and recovered, and accuracy against the hand counts from week 1.

**Success criteria to agree up front:** counting time per bay, share of
counts that needed no human input, accuracy vs. hand count on the pilot
products, value of shortages evidenced.

## Pricing shape (to test in pilots)

| Package | Includes | Shape |
|---|---|---|
| Count | Count, Catalog studio, Shelf | per site per month, by bay count |
| Count + Reconcile | adds Reconcile and ERP connectors | higher tier per site |
| Receive | Receive + Evidence for deliveries | per dock door per month |
| Evidence | claim packs, audit exports | premium add-on, or % of recovered claims |
| Count-as-a-Service | our crews + the software | per visit or per bay counted |

## What is true today, and what is not yet

Proven on synthetic footage with known ground truth (see the test suite):

- 30/30 synthetic shelves counted exactly with adaptive sampling; a wrong
  count is flagged, never reported as certain.
- Look-alike products (same colour, different artwork): 10/10 shelves exact
  after 5 photos per product, versus 448 errors by colour alone; an
  unenrolled look-alike is flagged, not misfiled.
- Overlapping videos merged exactly on 12/12 test pairs, with no false merges
  on disjoint pairs.
- Every empty facing found on the test shelves.

**Not yet proven, and must be before promising accuracy numbers to a customer:**

- **Real shelves.** The detector finds boxes by contrast (`contour`); real
  stores bring clutter, glare and occlusion. The YOLO detector backend exists
  but no model has been trained on real shelves yet: the pilot's
  Count-as-a-Service footage (with consent) is how to get one.
- **Depth.** A video sees the front of the shelf. Items stacked behind the
  front facing are not counted; Count is for faced shelves and pallet faces,
  not for deep bins.
- **Native phone builds.** The app is verified in its web preview end to
  end; the iOS/Android camera path (VisionCamera) needs a development build
  on real devices, and the tilt sensor's sign should be checked per device.
- **ERP connectors** are written against the documented APIs (Shopify
  2026-07 GraphQL, NetSuite REST + TBA, SAP S/4HANA OData) and tested
  against mocks of those requests, not against live customer tenants. Do a
  sandbox run with each customer before switching on automatic posting.
- **Scale.** One counting worker per deployment and SQLite. Fine for a pilot
  and a mid-size site; multi-site customers with many phones need the job
  queue and database moved to shared services.
