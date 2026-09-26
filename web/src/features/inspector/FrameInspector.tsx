import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BoxSelect,
  ChevronLeft,
  ChevronRight,
  CircleSlash,
  Eye,
  EyeOff,
  Film,
  Pause,
  Play,
  ScanEye,
  SkipBack,
  SkipForward,
} from "lucide-react";
import { videoUrl, type CatalogEntry, type InspectorBox, type InspectorDoc } from "@/lib/api";
import { cn } from "@/lib/cn";
import { num, pct, timecode } from "@/lib/format";
import { useInspector } from "@/lib/queries";
import { Badge, Card, CardHeader, Empty, IconButton, Kbd, Skeleton, Swatch } from "@/components/ui";

const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);

/** Space on a focused button already clicks it; handling it too would double-fire. */
const activatesOnSpace = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.tagName === "BUTTON" || el.tagName === "A");

/** The identity the object was counted as (majority of its sightings). */
const idOf = (b: InspectorBox) => b.track_sku ?? b.sku;
/** This frame's colour guess disagreed with the object's counted identity. */
const flickered = (b: InspectorBox) => b.track_sku != null && b.track_sku !== b.sku;
/** A filter matches the counted identity or this frame's guess (reviews name the latter). */
const matches = (b: InspectorBox, sku: string) => idOf(b) === sku || b.sku === sku;

/** Sampled frames are sparse; find the one the player is currently showing. */
function frameAt(frames: InspectorDoc["frames"], t: number, halfStep: number): number | null {
  let lo = 0;
  let hi = frames.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid]!.t <= t + 1e-3) (best = mid), (lo = mid + 1);
    else hi = mid - 1;
  }
  if (best < 0) return null;
  // Past the last sample by more than a step: the pipeline never saw this.
  return t - frames[best]!.t > halfStep * 2 ? null : best;
}

function Timeline({
  doc,
  boxesByFrame,
  current,
  onSeek,
  skuFilter,
}: {
  doc: InspectorDoc;
  boxesByFrame: Map<number, InspectorBox[]>;
  current: number | null;
  onSeek: (i: number) => void;
  skuFilter: string | null;
}) {
  const max = Math.max(1, ...doc.frames.map((f) => boxesByFrame.get(f.index)?.length ?? 0));
  const ref = useRef<HTMLDivElement>(null);
  const seekFromPointer = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    const i = Math.round(((clientX - r.left) / r.width) * (doc.frames.length - 1));
    onSeek(Math.max(0, Math.min(doc.frames.length - 1, i)));
  };
  return (
    <div className="px-4 pt-3 pb-2">
      <div className="mb-1.5 flex items-center justify-between text-[11px] text-subtle">
        <span>Sampled frames · bar height = objects seen</span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1"><span className="size-2 rounded-sm bg-muted/60" />kept</span>
          <span className="flex items-center gap-1"><span className="size-2 rounded-sm bg-bad/70" />dropped</span>
        </span>
      </div>
      <div
        ref={ref}
        role="slider"
        tabIndex={0}
        aria-label="Frame"
        aria-valuemin={0}
        aria-valuemax={doc.frames.length - 1}
        aria-valuenow={current ?? 0}
        aria-valuetext={current != null ? `Frame ${current + 1} of ${doc.frames.length}` : "No frame"}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          seekFromPointer(e.clientX);
        }}
        onPointerMove={(e) => e.buttons === 1 && seekFromPointer(e.clientX)}
        className="relative flex h-10 cursor-pointer touch-none items-end gap-px rounded-md bg-bg px-px"
      >
        {doc.frames.map((f) => {
          const boxes = boxesByFrame.get(f.index) ?? [];
          const hits = skuFilter ? boxes.filter((b) => matches(b, skuFilter)).length : boxes.length;
          // Dropped frames are marked, not emphasised: at full height they drown the data.
          const h = f.kept ? Math.max(8, (hits / max) * 100) : 45;
          return (
            <span
              key={f.index}
              aria-hidden
              className={cn(
                "min-w-px flex-1 rounded-t-[1px]",
                !f.kept ? "bg-bad/45" : f.index === current ? "bg-accent" : hits ? "bg-muted/50" : "bg-line-strong",
              )}
              style={{ height: `${h}%` }}
            />
          );
        })}
        {current != null && (
          <span
            aria-hidden
            className="pointer-events-none absolute -top-1 -bottom-1 w-0.5 rounded-full bg-accent shadow-[0_0_8px] shadow-accent"
            style={{ left: `${(current / Math.max(1, doc.frames.length - 1)) * 100}%` }}
          />
        )}
      </div>
    </div>
  );
}

export function FrameInspector({
  runId,
  catalog,
  initialFrame,
  skuFilter,
  onFrameChange,
  onSkuFilter,
}: {
  runId: string;
  catalog: CatalogEntry[] | undefined;
  initialFrame: number | null;
  skuFilter: string | null;
  onFrameChange: (frame: number) => void;
  onSkuFilter: (sku: string | null) => void;
}) {
  const inspector = useInspector(runId, true);
  const doc = inspector.data;
  const videoRef = useRef<HTMLVideoElement>(null);
  const [cur, setCur] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [overlay, setOverlay] = useState(true);
  // Arriving from a review (a SKU and a frame), the flagged sighting is often
  // one that was never counted; hiding uncounted boxes would hide the evidence.
  const [uncounted, setUncounted] = useState(initialFrame != null && skuFilter != null);
  const [selected, setSelected] = useState<number | null>(null); // index into the frame's boxes
  const [videoFailed, setVideoFailed] = useState(false);

  const swatch = useMemo(() => new Map(catalog?.map((c) => [c.sku, c.swatch])), [catalog]);

  const boxesByFrame = useMemo(() => {
    const m = new Map<number, InspectorBox[]>();
    doc?.boxes.forEach((b) => {
      const list = m.get(b.frame) ?? [];
      list.push(b);
      m.set(b.frame, list);
    });
    return m;
  }, [doc]);

  const trackSpan = useMemo(() => {
    const m = new Map<number, { first: number; last: number; hits: number }>();
    doc?.boxes.forEach((b) => {
      if (b.track_id == null) return;
      const s = m.get(b.track_id) ?? { first: b.frame, last: b.frame, hits: 0 };
      s.first = Math.min(s.first, b.frame);
      s.last = Math.max(s.last, b.frame);
      s.hits++;
      m.set(b.track_id, s);
    });
    return m;
  }, [doc]);

  const frames = doc?.frames ?? [];
  const fps = frames.length > 1 ? 1 / Math.max(1e-3, (frames[frames.length - 1]!.t - frames[0]!.t) / (frames.length - 1)) : 30;
  const halfStep = 0.5 / fps;
  const [W, H] = doc?.frame_size ?? [16, 9];
  const frame = cur != null ? frames[cur] : undefined;
  const allBoxes = frame ? (boxesByFrame.get(frame.index) ?? []) : [];
  const boxes = allBoxes.filter((b) => uncounted || b.counted);
  const sel = selected != null ? boxes[selected] : undefined;

  const seekTo = useCallback(
    (i: number) => {
      const f = frames[i];
      if (!f) return;
      setCur(i);
      setSelected(null);
      const v = videoRef.current;
      // Nudge past the frame boundary so the decoder lands on this frame, not the one before.
      if (v && !videoFailed) v.currentTime = f.t + Math.min(0.01, halfStep / 2);
    },
    [frames, halfStep, videoFailed],
  );

  // Follow the player. requestVideoFrameCallback tracks presented frames exactly;
  // timeupdate (~4 Hz) is the fallback.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !frames.length) return;
    const sync = () => setCur(frameAt(frames, v.currentTime, halfStep));
    if ("requestVideoFrameCallback" in v) {
      let id = 0;
      const loop = () => {
        sync();
        id = v.requestVideoFrameCallback(loop);
      };
      id = v.requestVideoFrameCallback(loop);
      v.addEventListener("seeked", sync);
      return () => {
        v.cancelVideoFrameCallback(id);
        v.removeEventListener("seeked", sync);
      };
    }
    const vv = v as HTMLVideoElement;
    vv.addEventListener("timeupdate", sync);
    vv.addEventListener("seeked", sync);
    return () => {
      vv.removeEventListener("timeupdate", sync);
      vv.removeEventListener("seeked", sync);
    };
  }, [frames, halfStep]);

  // Deep link: land on the requested frame once the video can seek.
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current || !frames.length) return;
    const i = initialFrame != null ? frames.findIndex((f) => f.index === initialFrame) : 0;
    const go = () => {
      landed.current = true;
      seekTo(Math.max(0, i));
    };
    const v = videoRef.current;
    if (videoFailed || (v && v.readyState >= 1)) go();
    else v?.addEventListener("loadedmetadata", go, { once: true });
  }, [frames, initialFrame, seekTo, videoFailed]);

  // Already open and asked for a different frame (e.g. "Show in frame
  // inspector" from the drawer): go there. The URL tracks the paused frame,
  // so this is a no-op for the inspector's own steps.
  useEffect(() => {
    if (!landed.current || initialFrame == null || playing) return;
    if (frames[cur ?? -1]?.index === initialFrame) return;
    const i = frames.findIndex((f) => f.index === initialFrame);
    if (i >= 0) {
      seekTo(i);
      if (skuFilter) setUncounted(true);
    }
    // Only when the requested frame changes.
  }, [initialFrame]);

  // Keep the URL on the paused frame so it can be shared.
  useEffect(() => {
    if (!playing && frame) onFrameChange(frame.index);
    // Only on a new frame or a pause; onFrameChange is a fresh closure each render.
  }, [playing, frame?.index]);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v || videoFailed) return;
    if (v.paused) v.play();
    else v.pause();
  };
  const step = (d: number) => {
    videoRef.current?.pause();
    seekTo(Math.max(0, Math.min(frames.length - 1, (cur ?? 0) + d)));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || document.querySelector('[role="dialog"]')) return;
      if (e.key === " ") {
        if (activatesOnSpace(e.target)) return;
        e.preventDefault();
        togglePlay();
      }
      else if (e.key === "ArrowLeft") (e.preventDefault(), step(e.shiftKey ? -10 : -1));
      else if (e.key === "ArrowRight") (e.preventDefault(), step(e.shiftKey ? 10 : 1));
      else if (e.key.toLowerCase() === "b") setOverlay((o) => !o);
      else if (e.key.toLowerCase() === "u") setUncounted((o) => !o);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (inspector.isLoading) {
    return (
      <Card>
        <Skeleton className="m-4 aspect-video" />
      </Card>
    );
  }
  if (inspector.isError || !doc) {
    return (
      <Card>
        <Empty icon={ScanEye} title="No inspector data for this run">
          Runs counted before the dashboard's telemetry was added, or from the CLI, don't have{" "}
          <code className="font-mono text-xs">inspector.json</code>. Re-run the video from the dashboard to inspect it.
        </Empty>
      </Card>
    );
  }

  const skus = [...new Set(doc.boxes.map(idOf))].sort();

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_300px]">
      <Card className="min-w-0 overflow-hidden">
        <CardHeader title="Frame inspector" icon={Film}>
          <label className="flex items-center gap-2 text-xs text-muted">
            <span className="sr-only">Filter by SKU</span>
            <select
              value={skuFilter ?? ""}
              onChange={(e) => onSkuFilter(e.target.value || null)}
              className="h-7 cursor-pointer rounded-md border border-line bg-bg px-2 font-mono text-xs text-fg pointer-coarse:h-11"
            >
              <option value="">All SKUs</option>
              {skus.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <IconButton icon={overlay ? Eye : EyeOff} label="Toggle boxes (B)" active={overlay} onClick={() => setOverlay((o) => !o)} />
          <IconButton icon={BoxSelect} label="Show uncounted detections (U)" active={uncounted} onClick={() => setUncounted((o) => !o)} />
        </CardHeader>

        {/* Stage: the SVG shares the video's box and the frame's pixel space. */}
        <div className="bg-black">
          <div className="relative mx-auto max-h-[62vh]" style={{ aspectRatio: `${W} / ${H}`, maxWidth: `calc(62vh * ${W / H})` }}>
            {!videoFailed ? (
              <video
                ref={videoRef}
                src={videoUrl(runId)}
                muted
                playsInline
                preload="auto"
                className="absolute inset-0 size-full object-fill"
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onError={() => setVideoFailed(true)}
                onClick={togglePlay}
              />
            ) : (
              <div className="absolute inset-0 grid place-items-center bg-[radial-gradient(#1d2126_1px,transparent_1px)] [background-size:16px_16px]">
                <p className="max-w-xs rounded-md bg-bg/80 px-3 py-2 text-center text-xs text-muted">
                  The source video isn't playable here (moved, deleted, or a codec this browser lacks). Boxes are
                  still shown in frame coordinates.
                </p>
              </div>
            )}

            {overlay && frame && (
              <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="pointer-events-none absolute inset-0 size-full">
                {boxes.map((b, i) => {
                  const [x1, y1, x2, y2] = b.bbox;
                  const c = b.counted ? (swatch.get(idOf(b)) ?? "#9ba1ab") : "#9ba1ab";
                  const dim = skuFilter && !matches(b, skuFilter);
                  const isSel = i === selected;
                  return (
                    <g
                      key={i}
                      className="pointer-events-auto cursor-pointer"
                      opacity={dim ? 0.18 : 1}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelected(isSel ? null : i);
                      }}
                    >
                      <rect
                        x={x1}
                        y={y1}
                        width={x2 - x1}
                        height={y2 - y1}
                        fill={isSel ? `${c}33` : "transparent"}
                        stroke={c}
                        strokeWidth={isSel ? 3 : 1.75}
                        strokeDasharray={b.counted ? undefined : "5 4"}
                        vectorEffect="non-scaling-stroke"
                        rx={2}
                      />
                      {!dim && (
                        <foreignObject x={x1} y={Math.max(0, y1 - 18)} width={160} height={18} className="overflow-visible">
                          <span
                            className="inline-block rounded-sm px-1 font-mono text-[10px] leading-[16px] whitespace-nowrap text-black"
                            style={{ background: c }}
                          >
                            {idOf(b)}{flickered(b) ? "*" : ""} {Math.round(b.confidence * 100)}%{b.track_id != null ? ` #${b.track_id}` : ""}
                          </span>
                        </foreignObject>
                      )}
                    </g>
                  );
                })}
              </svg>
            )}

            {frame && !frame.kept && (
              <div className="absolute top-3 left-3 flex items-center gap-1.5 rounded-md bg-bad/90 px-2 py-1 text-xs font-medium text-black">
                <CircleSlash size={13} aria-hidden /> Dropped by quality gate
              </div>
            )}
          </div>
        </div>

        {/* transport */}
        <div className="flex flex-wrap items-center gap-1 border-t border-line px-3 py-2">
          <IconButton icon={SkipBack} label="Back 10 frames (Shift+←)" onClick={() => step(-10)} />
          <IconButton icon={ChevronLeft} label="Previous frame (←)" onClick={() => step(-1)} />
          <IconButton icon={playing ? Pause : Play} label={playing ? "Pause (Space)" : "Play (Space)"} onClick={togglePlay} disabled={videoFailed} className="text-fg" />
          <IconButton icon={ChevronRight} label="Next frame (→)" onClick={() => step(1)} />
          <IconButton icon={SkipForward} label="Forward 10 frames (Shift+→)" onClick={() => step(10)} />
          <span className="ml-2 font-mono text-xs text-muted tabular">
            {frame ? (
              <>
                {timecode(frame.t)} · frame {frame.index + 1}/{frames.length}
              </>
            ) : (
              "between samples"
            )}
          </span>
          <span className="ml-auto hidden items-center gap-2 text-[11px] text-subtle md:flex">
            <Kbd>←</Kbd><Kbd>→</Kbd> step <Kbd>B</Kbd> boxes <Kbd>U</Kbd> uncounted
          </span>
        </div>
        <Timeline doc={doc} boxesByFrame={boxesByFrame} current={cur} onSeek={(i) => (videoRef.current?.pause(), seekTo(i))} skuFilter={skuFilter} />
      </Card>

      {/* side panel */}
      <aside className="flex min-w-0 flex-col gap-4">
        <Card>
          <CardHeader title="Frame" />
          {frame ? (
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 px-4 py-3 text-xs">
              <dt className="text-subtle">Source frame</dt>
              <dd className="text-right font-mono">{frame.source_index}</dd>
              <dt className="text-subtle">Status</dt>
              <dd className="text-right">{frame.kept ? <Badge tone="ok">kept</Badge> : <Badge tone="bad">dropped</Badge>}</dd>
              <dt className="text-subtle">Blur score</dt>
              <dd className="text-right font-mono">{num(frame.quality.blur)}</dd>
              <dt className="text-subtle">Brightness</dt>
              <dd className="text-right font-mono">{frame.quality.brightness != null ? `${Math.round(frame.quality.brightness)}/255` : "—"}</dd>
              <dt className="text-subtle">Clipped</dt>
              <dd className="text-right font-mono">{pct(frame.quality.clipped_frac, 1)}</dd>
              <dt className="text-subtle">Objects</dt>
              <dd className="text-right font-mono">
                {allBoxes.filter((b) => b.counted).length} counted
                {allBoxes.some((b) => !b.counted) && ` · ${allBoxes.filter((b) => !b.counted).length} not`}
              </dd>
            </dl>
          ) : (
            <p className="px-4 py-3 text-xs text-subtle">The player is between sampled frames.</p>
          )}
        </Card>

        <Card className="min-h-0 flex-1">
          <CardHeader title={sel ? `Object #${sel.track_id ?? "—"}` : "Objects in frame"} />
          {sel ? (
            <div className="px-4 py-3 text-xs">
              <div className="mb-3 flex items-center gap-3">
                <Swatch color={swatch.get(idOf(sel)) ?? null} size={28} />
                <div>
                  <p className="font-mono text-fg">{idOf(sel)}</p>
                  <p className="text-subtle">{sel.label}</p>
                </div>
                <span className="ml-auto">{sel.counted ? <Badge tone="ok">counted</Badge> : <Badge>not counted</Badge>}</span>
              </div>
              <dl className="grid grid-cols-2 gap-y-1.5">
                <dt className="text-subtle">Confidence</dt>
                <dd className="text-right font-mono">{pct(sel.confidence)}</dd>
                {flickered(sel) && (
                  <>
                    <dt className="text-subtle">This frame read</dt>
                    <dd className="text-right font-mono text-warn">{sel.sku}</dd>
                  </>
                )}
                {sel.track_id != null && trackSpan.get(sel.track_id) && (
                  <>
                    <dt className="text-subtle">Seen in</dt>
                    <dd className="text-right font-mono">{trackSpan.get(sel.track_id)!.hits} frames</dd>
                    <dt className="text-subtle">Span</dt>
                    <dd className="text-right font-mono">
                      {trackSpan.get(sel.track_id)!.first + 1}–{trackSpan.get(sel.track_id)!.last + 1}
                    </dd>
                  </>
                )}
              </dl>
              {flickered(sel) && (
                <p className="mt-3 text-subtle">
                  Colour read differently in this frame. The object is counted as {idOf(sel)}, the majority of its{" "}
                  {sel.track_id != null ? trackSpan.get(sel.track_id)?.hits : ""} sightings. Boxes marked * are such frames.
                </p>
              )}
              {!sel.counted && (
                <p className="mt-3 text-subtle">
                  Seen too briefly to count: the multi-frame rule needs an object in several frames before it counts.
                </p>
              )}
              {sel.track_id != null && trackSpan.get(sel.track_id) && (
                <div className="mt-3 flex gap-2">
                  {(["first", "last"] as const).map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => {
                        const idx = frames.findIndex((f) => f.index === trackSpan.get(sel.track_id!)![k]);
                        videoRef.current?.pause();
                        seekTo(idx);
                      }}
                      className="flex-1 cursor-pointer rounded-md border border-line py-1.5 text-muted transition-colors hover:bg-hover hover:text-fg pointer-coarse:py-3"
                    >
                      {k === "first" ? "First sighting" : "Last sighting"}
                    </button>
                  ))}
                </div>
              )}
              <button type="button" onClick={() => setSelected(null)} className="mt-3 cursor-pointer text-accent hover:underline">
                ← All objects
              </button>
            </div>
          ) : boxes.length ? (
            <ul className="max-h-72 overflow-y-auto py-1">
              {boxes.map((b, i) => (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => setSelected(i)}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-2.5 px-4 py-1.5 text-left text-xs transition-colors hover:bg-hover pointer-coarse:py-3",
                      skuFilter && !matches(b, skuFilter) && "opacity-40",
                    )}
                  >
                    <Swatch color={b.counted ? (swatch.get(idOf(b)) ?? null) : null} size={12} />
                    <span className="font-mono text-fg">{idOf(b)}{flickered(b) ? "*" : ""}</span>
                    <span className="text-subtle">#{b.track_id ?? "—"}</span>
                    <span className="ml-auto font-mono text-muted tabular">{pct(b.confidence)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-3 text-xs text-subtle">{frame ? "No objects in this frame." : "—"}</p>
          )}
        </Card>
      </aside>
    </div>
  );
}
