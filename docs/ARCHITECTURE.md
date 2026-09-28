# Architecture

## The one idea

There is a backbone, and there are plugins. The backbone is the thing that is hard to build and
expensive to change. The plugins are the things every customer wants differently.

```
                        ┌─────────────────────────────────────────┐
   video ──────────────▶│  Capture                                │
                        │    on_frame            (capture layer)  │
                        ├─────────────────────────────────────────┤
                        │  Pre-process                            │
                        │    quality metrics, camera motion       │
                        ├─────────────────────────────────────────┤
                        │  Detect                                 │
                        │    on_detections       (pipeline layer) │
                        ├─────────────────────────────────────────┤
                        │  Identify                               │
                        │    on_items            (pipeline layer) │
                        ├─────────────────────────────────────────┤
                        │  Count                                  │
                        │    on_tracks, on_counts                 │
                        ├─────────────────────────────────────────┤
                        │  Output                                 │
                        │    on_output           (output layer)   │
                        └──────────────┬──────────────────────────┘
                                       │
                          JSON · CSV · SQLite · crops · audit pack
                                       │
                            ┌──────────┴──────────┐
                            │  count history db   │◀── analytics plugins
                            └─────────────────────┘
```

`pipeline.py` is 150 lines and contains no feature logic. If a change requires editing it, the
change is probably a plugin.

## Why the seams are where they are

**Capture is separate from pre-process** because the capture app on a phone will eventually do the
guided-capture work — marker checks, blur warnings, an offline queue — and it needs a seam that
does not know anything about detection.

**Detect is separate from identify** because they fail differently and get replaced on different
schedules. "Is there an object here" generalises across customers; "which SKU is it" does not.
Every customer will bring their own catalog long before they bring their own detector.

**Count is its own stage, not a line inside detect**, because it is where the product's honesty
lives. Counting the same carton twice is the failure that destroys trust, and it can only be
detected across frames — which means it needs a stage that sees all of them.

**Output is side-effect only.** Sinks never change the result. Anything that changes the result
happens on an earlier hook, so the JSON, the CSV, the database row and the audit pack cannot
disagree with each other.

## The counting problem

Three strategies, because there is no single right answer:

| Strategy | Right when | Fails when |
| --- | --- | --- |
| `tracking` | the camera moves across stock | the pan is fast enough to break association |
| `peak_frame` | a fixed camera sees the whole shelf | stock is never all visible at once |
| `median_frame` | a fixed camera with intermittent occlusion | stock genuinely changes during the video |

`tracking` is the default and the interesting one. The tracker (`stages/count.py`) is greedy IoU
association with no Kalman filter and no appearance embedding — with a sampled frame stream, a
motion model would be fitted to almost nothing. What it does have is **global motion
compensation**: `stages/motion.py` estimates the camera's displacement between frames by phase
correlation on a downscaled greyscale copy, and each track is predicted forward by that
displacement before overlap is measured.

The effect on the bundled demo (34 units of ground truth):

| | counted | error |
| --- | ---: | ---: |
| without motion compensation | 52 | +53% |
| with motion compensation | 34 | 0% |

Motion must be accumulated through **every** frame, including those the quality gate drops.
An earlier version only applied motion on frames that reached the tracker, so each dropped frame
left every prediction a whole frame of pan behind; at walking speed that split every object in
view into two tracks. On ten synthetic shelves that bug alone produced errors of up to +36%
(mean 11%). Accumulating it (`Tracker.observe_motion`) brought the same ten to exact totals.

The contour detector also pads each frame with its median tone before finding edges. Without it,
a carton cut off by the frame edge has an open outline, and its label, the next closed shape
inside, was reported as an object of its own: 145 of 145 "unidentified" sightings in one test
video were exactly this.

Track identity is a majority vote across sightings, not the first guess, because identification
flickers and object permanence does not.

## Confidence

Confidence is computed in two places and blended, never invented:

1. `stages/count.py` scores each **track**: mean detection score, mean identification confidence,
   SKU vote agreement, and persistence against `min_hits`.
2. `plugins/confidence.py` scores each **item** (detection × identification × frame quality) and
   folds overall capture quality into the per-SKU number, so a clean count off bad footage is
   never reported as certain.

The run-level number is weighted by count: being unsure about 40 units matters more than being
unsure about one.

## State sharing between plugins

Plugins never import each other. They share through `ctx.state`, a plain dict on the run context:

- `quality_gate` writes `ctx.state["quality"]` → `confidence` reads it
- `pipeline` writes `ctx.state["catalog"]` → `tolerance` reads it
- `review_queue` writes `ctx.state["review_candidates"]` during `on_items`, drains it in
  `on_counts`

That keeps the dependency graph flat: a plugin that is not loaded simply leaves its key absent,
and every reader handles the absence.

## Failure isolation

`plugins/base.fire()` wraps every hook call. A plugin that raises is logged, recorded as a warning
on the result, and skipped. The count still completes. This is deliberate: a broken analytics
plugin must not cost a warehouse its stock count.

## Reproducibility

`Config.fingerprint()` is a SHA-256 of the entire configuration, plugins included. It is written
into the run row, the result JSON and the audit pack. Two runs with the same fingerprint over the
same source hash are expected to produce the same counts, and there is a test that asserts it.
