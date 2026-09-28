# countbone mobile

The phone app counters use on the floor: pick what you are filming (a bay by
scanning its QR label, a delivery, or a recount), film it with live
coaching, and it uploads by itself, even after a dead zone.

Expo SDK 57, Expo Router (`src/app`), React Native 0.86.

## Try it in a browser (no phone needed)

```bash
# the server, allowing the preview's origin
countbone serve --allow-origin http://localhost:8081

cd mobile
npm install
npm run web          # http://localhost:8081
```

Sign in with the server address (`http://127.0.0.1:8000`) and an account.
In the viewfinder, **Replay** plays a video file through the same guidance
and recording path the camera uses, so the whole flow can be tried on a desk.

## On a phone

The camera uses VisionCamera (a native module), so Expo Go is not enough:
make a development build.

```bash
npx eas-cli@latest build --profile development --platform android   # or ios
npx expo start --dev-client
```

Permissions are declared in `app.json` (camera; microphone only if audio is
turned on; motion). Check on each target device that the tilt cue points the
right way (see `src/sensors/useTilt.ts`).

## How it fits together

| Path | What |
|---|---|
| `src/analysis/` | frame metrics and the guidance engine; plain TypeScript, runs in the camera worklet, the browser and `node --test` |
| `src/camera/CameraFeed.tsx` | VisionCamera: Y-plane analysis in a frame worklet, MP4 recording, live ISO/shutter |
| `src/camera/CameraFeed.web.tsx` | getUserMedia or a replayed file, MediaRecorder |
| `src/api/uploadQueue.ts` | the offline queue: resumable 4 MB chunks, idempotent by recording id, retries with back-off |
| `src/storage/recordings*.ts` | recordings kept in app storage (IndexedDB on the web) until the server has them |
| `src/app/` | screens: sign-in, Count, capture, scan, run summary, review, Recounts, Uploads, Settings |

## Checks

```bash
npm run typecheck
npm test            # analysis engine
npx expo lint
npx expo-doctor
```
