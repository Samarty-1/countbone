# countbone mobile

Expo (SDK 57) + Expo Router + VisionCamera 5. Films the aisle with live guidance, uploads the
take to `countbone serve`, follows the count, and lets a person swipe through the review queue.

The same screens run in a browser, with a webcam or a replayed video file standing in for the
phone camera, so guidance and the whole upload → count → review loop can be tested from a desk.

## Run it

```bash
# terminal 1: the API, allowing the web preview's origin
countbone serve --host 0.0.0.0 --allow-origin http://localhost:8081

# terminal 2
cd mobile
npm install
npx expo start --web          # browser preview on http://localhost:8081
npx expo run:android          # or run:ios: a development build (VisionCamera is native code,
                              # so Expo Go cannot run the camera screen)
```

A phone needs the server's network address (Settings → Server, e.g. `192.168.1.20:8000`); the
default guess is the machine running Metro. The browser preview defaults to the page's own host
on port 8000.

The camera needs a secure page in the browser: `localhost` works, a LAN IP over plain `http`
does not. To try the preview in Chrome on a phone, use `chrome://inspect` port forwarding or an
https tunnel.

## Checks

```bash
npm run typecheck
npx expo lint
npm test                     # the analysis core, under node --test, no device needed
```

## Layout

```
src/
  analysis/       frame metrics + guidance engine: plain TS, worklet-safe, unit-tested
  capture/
    CaptureScreen.tsx      native: VisionCamera preview, recorder, YUV frame processor
    CaptureScreen.web.tsx  browser: getUserMedia or a replayed file, MediaRecorder
    CaptureChrome.tsx      the viewfinder layout both share
    overlay.tsx            warning banner, direction arrow, framing grid, outlines,
                           stats readout, record button
    haptics.ts             record start/stop buzz, and a buzz when a bad cue appears mid-take
    useGuidance.ts         engine + motion-sensor tilt, rate-limited into React state
  review/SwipeCard.tsx     swipe right to accept, left to reject
  lib/            API client, settings (AsyncStorage), unsent-recordings store, formatting
  app/            routes: home, capture, upload/[id], run/[id] (processing → summary),
                  run/[id]/review, history, settings
```

## How the pieces fit

| Screen | What it does | Talks to |
| --- | --- | --- |
| Capture | ~10 analysed frames/s feed `GuidanceEngine`; cues come from the same thresholds the backend quality gate uses | nothing (all on device) |
| Upload | XHR upload with progress; the take stays on the device until the server accepts it | `POST /api/runs/upload` |
| Processing | polls the live telemetry: stage, frames read / expected, kept / dropped, tracks | `GET /api/runs/{id}` |
| Summary | per-SKU counts, variance, confidence tier, warnings, why frames were dropped | `GET /api/runs/{id}`, `/api/catalog` |
| Review | one card per pending review; unidentified items need a SKU before they can be accepted; whole-SKU reviews take a recount; undo reopens | `POST /api/reviews/{id}` |
| History | server runs, runs still in flight, and takes not yet uploaded | `GET /api/runs` |

## Known limits

- Native frame orientation is taken from `Frame.orientation` (EXIF semantics) and has only been
  verified in unit tests, not yet on a device. If a sideways walk reads as "Hold level", this
  mapping (`rotationOf` in `CaptureScreen.tsx`) is the first place to look.
- Browser takes are held in memory. Reloading the tab loses a take that has not uploaded.
  Native takes are files and survive a restart.
- Object outlines are a cheap edge preview, not the detector. On dense shelves they often find
  labels instead of cartons.
- WebM from MediaRecorder has no frame rate or duration in its header. The server still counts
  it correctly, but reports placeholder values for both, and the summary hides them.
