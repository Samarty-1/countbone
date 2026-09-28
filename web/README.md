# countbone dashboard

React + TypeScript + Tailwind v4, built with Vite into `src/countbone/api/static/`.
`countbone serve` serves that build, so **running the dashboard never needs Node**.
You need Node only to change it.

```bash
cd web
npm install
npm run dev        # http://localhost:5173, proxies /api to countbone serve on :8000
npm run build      # typecheck, then write the build into the Python package
```

Run `countbone serve` alongside `npm run dev`. Commit the rebuilt `static/` with any change
to `web/src`, because that build is what ships.

## Layout

```
src/
  lib/            api client and types, queries, routing, status tiers, export
  components/     ui primitives (Button, Badge, ConfidenceBar, …) and the sidebar
  features/
    upload/       dropzone, preview, upload with progress
    pipeline/     live six-stage tracker and telemetry readouts
    results/      metric cards, counts table, export
    review/       "Items to check" drawer: crop vs candidate SKUs, recounts
    inspector/    video player with box overlay and frame timeline
    run/          the run page that composes the above
```

## Where the data comes from

Everything shown comes from the pipeline. Nothing is simulated.

| UI | Source |
| --- | --- |
| Live stage progress, FPS, blur, lighting | `api/telemetry.py`: two plugins the API attaches, published through `GET /api/runs/{id}` while the run is pending |
| Box overlay, frame timeline | `inspector.json`, written per run by the same telemetry and hashed into the audit pack |
| SKU swatches, candidate ranking | `GET /api/catalog`: each SKU's hue band, the same evidence the colour identifier uses |
| Recounts | `POST /api/reviews/{id}` with `resolved_count`. Stored beside the machine count, never over it, and logged to the audit trail |

## Conventions

- Colours come only from the tokens in `src/index.css`. Every text/background pair is measured
  at 4.5:1 or better, so check the numbers there before adding a colour.
- Status is never shown by colour alone: tiers carry a label and confidence carries a number.
- Every action has a keyboard path. The review drawer is built to be driven with `J`/`K`, `1`–`9`,
  `A`, `R` and `Z`.
- Animation respects `prefers-reduced-motion` (see `MotionConfig` in `main.tsx`).
