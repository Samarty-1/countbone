# Changes in PR #1: fixes on top of `product-suite`

**PR:** https://github.com/Samarty-1/countbone/pull/1
**Branch:** `claude/festive-lovelace-11ifz7`, built on `product-suite`
**Status when this was written:** all 8 CI checks green on `30948ae`, no merge conflicts, not merged yet

PR #1 includes the whole `product-suite` branch (platform, dashboard, mobile app,
deploy docs). It also adds **three commits** that fix problems found while reviewing
that branch. This file covers only those three commits. Each fix has a test.

| Commit | What it does |
|---|---|
| `c7e03f1` | Phone app: checksums on uploads, recordings tied to whoever filmed them, frames turned upright before analysis |
| `56cf4d0` | Server: fixes the login lockout, the upload memory DoS and self-approval, plus smaller defects |
| `30948ae` | Identify: products with few photos are held to the default match bar when a look-alike exists |

---

## 1. Security fixes (server)

### Anyone could lock every user out of sign-in
- **Problem:** behind Caddy, every request came from Caddy's IP address. The
  per-address failure counter never reset. About 14 wrong passwords from anyone
  locked **every** user out for 15 minutes, and this could be repeated.
- **Fix:**
  - `countbone serve --forwarded-allow-ips` (env `FORWARDED_ALLOW_IPS`, default
    `127.0.0.1`) makes uvicorn trust `X-Forwarded-For` from that proxy.
  - `docker-compose.yml` sets `FORWARDED_ALLOW_IPS=*`. Port 8000 is only
    `expose`d, so Caddy is the only thing that can reach it.
  - Failures now decay after 15 quiet minutes.
  - Per-user allowance is 5; per-address allowance is 50, so one person's typos
    don't block a shared office router.
  - The throttle's memory is bounded. A successful sign-in clears only that
    username's count.
- **Files:** `src/countbone/security.py`, `src/countbone/cli.py`,
  `docker-compose.yml`, `docs/DEPLOY.md` (new checklist item)
- ⚠️ **Deployers:** never use `*` when port 8000 is open to the network. Anyone
  could then fake their address in the audit trail.

### One upload request could use up all the server's memory
- **Problem:** the resumable-upload `PUT` read the whole body before checking the
  64 MB chunk limit, and the proxy allows 8 GB.
- **Fix:**
  - The body is streamed with a hard cap.
  - File writes run off the event loop.
  - Chunks and `complete` calls are processed one at a time per upload.
  - The single-request upload checks the size before copying anything to disk.
- **File:** `src/countbone/api/routes_runs.py`

### A manager could approve their own count change
- **Problem:** one person could film a count, correct it and approve the change to
  the book, with no second person involved.
- **Fix:** two new reconcile rules, both **on by default** and switchable in the
  dashboard (Reconcile page):
  - `independent_recount`: the recount can't be done by, or assigned to, the
    person whose count is disputed.
  - `four_eyes`: nobody can approve an adjustment they counted or recounted.
- If the first counter uploads a recount video anyway, the task stays open and the
  audit log records `recount_refused`. Post-run processing no longer crashes on this.
- "My tasks" now also shows unassigned recounts the user is allowed to do.
- **Files:** `src/countbone/ops/reconcile.py`, `src/countbone/ops/tasks.py`,
  `src/countbone/api/routes_ops.py`, `src/countbone/store/repos.py`,
  `web/src/features/reconcile/ReconcilePage.tsx`, `web/src/lib/api.ts`

## 2. Smaller server fixes

| Change | Why |
|---|---|
| `POST /complete` accepts an optional `sha256` | So the client can hash while sending |
| Another user's recording id returns **403** (was 409) | Clients retry on 409, so they kept retrying forever |
| Partial uploads abandoned for 7 days are deleted (checked at startup too) | Stops them filling the disk; the same recording can start again |
| Browser WebM reporting 1000 fps or a negative frame count is treated as unknown | `location_tag` believed the 1000 fps and scanned 8000 frames looking for a label that should be in the first 8 s |
| Counters see only teammates' names and roles, not their sign-in times | Least privilege |
| The live-run tracker keeps only the newest 500 finished runs | Memory used to grow without limit |

**Files:** `routes_runs.py`, `api/app.py`, `stages/capture.py`,
`plugins/location_tag.py`, `routes_admin.py`, `api/jobs.py`

## 3. Counting accuracy: look-alike products (`30948ae`)

- **Problem:** CI on Python 3.10 once counted a plain red carton as `RED-DOT`, a
  photographed product with the same colour. Each product's match bar is
  calibrated from its own photos. With only 5 photos, that bar swung between
  0.914 and 0.968 depending on which photos were used, while plain-red cartons
  scored up to about 0.885. An unlucky photo set left almost no gap.
- **Fix:** if a product has **fewer than 8 photos** (`MIN_PHOTOS_FOR_OWN_BAR`)
  and shares its colour with a product nobody photographed, it must reach at
  least the default bar (0.93). Products with 8 or more photos keep their own
  bar; in testing it never dropped below 0.935. Products without a look-alike
  are unchanged.
- Catalog Studio now shows the bar actually applied and suggests adding photos.
- **Files:** `src/countbone/appearance.py`, `src/countbone/stages/identify.py`,
  `src/countbone/ops/catalog.py`, `web/src/features/studio/StudioPage.tsx`

## 4. Phone app fixes (`mobile/`)

| Change | Why |
|---|---|
| The upload queue computes SHA-256 while sending (re-reading the part the server already has on resume) and sends it with `complete` | A file damaged on the way is refused instead of counted. The server supported this, but the app never sent a hash |
| Each queued recording remembers who filmed it | Before, if someone signed out, the next person's sign-in uploaded it under their name. Now it waits, and the queue shows whose it is |
| Frames are turned upright using `Frame.orientation` before analysis | The sensor delivers landscape frames to a portrait phone, so walking along a shelf looked like vertical motion. Pace, direction and "Hold level" were all wrong on real devices (the web preview can't show this) |
| The tilt sign is flipped | The "tilt up/down" cue pointed the wrong way |
| Detection boxes stay on screen between measurements and move with the pan; box timing uses the wall clock | `frame.timestamp` uses different units on iOS and Android |

**Files:** `api/uploadQueue.ts`, `api/client.ts`, `state/session.tsx`,
`app/(tabs)/queue.tsx`, `camera/CameraFeed.tsx`, `analysis/*`

---

## How to check it before merging

```bash
git fetch origin claude/festive-lovelace-11ifz7
git checkout claude/festive-lovelace-11ifz7

# Server: 203 tests, run on Python 3.10 and 3.11
pip install -e ".[api,dev]"
ruff check .
pytest -q

# Dashboard
cd web && npm ci && npm run build && cd ..

# Phone app
cd mobile && npm ci && npm run typecheck && npm test
```

To see only these three commits:

```bash
git log --oneline origin/product-suite..origin/claude/festive-lovelace-11ifz7
git diff origin/product-suite origin/claude/festive-lovelace-11ifz7
```

New tests to read: `tests/test_platform.py` (throttle, uploads,
separation of duties, 403, cleanup), `tests/test_pipeline.py` (WebM fps),
`tests/test_accuracy_features.py` (look-alike bar), `mobile/src/analysis/analysis.test.ts`
(rotated pan).

## Things to know after merging

- **Deployers:** set `--forwarded-allow-ips` to your proxy's address.
  `docker-compose.yml` already does this.
- **Behaviour change:** `four_eyes` and `independent_recount` are on by default. A
  single-person site must turn them off on the dashboard's Reconcile page, or
  adjustments can never be approved.
- **Catalog:** products with fewer than 8 photos that have an unphotographed
  look-alike may now go to review more often. Add photos to fix this.
