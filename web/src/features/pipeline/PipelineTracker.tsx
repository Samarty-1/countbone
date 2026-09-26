import { motion, useReducedMotion } from "motion/react";
import {
  Check,
  Database,
  Film,
  Hash,
  type LucideIcon,
  ScanSearch,
  SlidersHorizontal,
  Tags,
  X,
} from "lucide-react";
import type { LiveRun, RunDetail, Telemetry } from "@/lib/api";
import { cn } from "@/lib/cn";
import { duration, num, pct } from "@/lib/format";

type StepState = "pending" | "active" | "done" | "failed";

interface Step {
  key: string;
  label: string;
  icon: LucideIcon;
  metric: (t: Telemetry, done: boolean) => string;
}

/** The backbone, in order. It never changes, so neither does this list. */
const STEPS: Step[] = [
  {
    key: "capture",
    label: "Capture",
    icon: Film,
    metric: (t) =>
      t.frames_expected ? `${t.frames_read} / ~${t.frames_expected} frames` : `${t.frames_read} frames`,
  },
  {
    key: "preprocess",
    label: "Pre-process",
    icon: SlidersHorizontal,
    metric: (t) => (t.frames_dropped ? `${t.frames_dropped} dropped` : `${t.frames_kept} kept`),
  },
  { key: "detect", label: "Detect", icon: ScanSearch, metric: (t) => `${num(t.detections)} boxes` },
  { key: "identify", label: "Identify", icon: Tags, metric: (t) => `${num(t.items)} matched` },
  {
    key: "count",
    label: "Count",
    icon: Hash,
    metric: (t, done) => (done || t.tracks ? `${t.tracks} objects` : "waiting"),
  },
  { key: "output", label: "Output", icon: Database, metric: (_, done) => (done ? "JSON · CSV · SQLite" : "waiting") },
];

/**
 * Stages 1-4 run per frame, interleaved, so while frames are flowing all four
 * are genuinely active at once. Count and Output run once, after the last
 * frame. The tracker says exactly that rather than faking a sequence.
 */
function stepStates(live: LiveRun | null, t: Telemetry | null): StepState[] {
  if (!live) return STEPS.map(() => "done");
  if (live.status === "queued") return STEPS.map(() => "pending");
  if (live.status === "done" || live.phase === "done") return STEPS.map(() => "done");

  if (live.status === "failed") {
    // Mark done whatever produced evidence; the first stage without any failed.
    const reached = [
      (t?.frames_read ?? 0) > 0,
      (t?.frames_read ?? 0) > 0,
      (t?.frames_kept ?? 0) > 0,
      (t?.items ?? 0) > 0,
      live.phase === "output",
      false,
    ];
    const firstMissing = reached.indexOf(false);
    return STEPS.map((_, i) => (i < firstMissing ? "done" : i === firstMissing ? "failed" : "pending"));
  }

  switch (live.phase) {
    case "count":
      return ["done", "done", "done", "done", "active", "pending"];
    case "output":
      return ["done", "done", "done", "done", "done", "active"];
    default:
      return ["active", "active", "active", "active", "pending", "pending"];
  }
}

/** For a finished run the server no longer remembers live telemetry for. */
function telemetryFromRun(run: RunDetail): Telemetry {
  return {
    frames_expected: null,
    frames_read: run.frames_read,
    frames_kept: run.frames_used,
    frames_dropped: run.frames_dropped,
    detections: run.detections,
    items: run.detections,
    tracks: run.tracks,
    fps: run.duration_s ? run.frames_read / run.duration_s : 0,
    elapsed_s: run.duration_s ?? 0,
    blur: null,
    blur_avg: null,
    brightness: null,
    brightness_avg: null,
  };
}

function StepNode({ step, state, metric, index }: { step: Step; state: StepState; metric: string; index: number }) {
  const reduce = useReducedMotion();
  const Icon = state === "done" ? Check : state === "failed" ? X : step.icon;
  return (
    <div className="relative flex min-w-0 items-center gap-3 lg:flex-col lg:items-start lg:gap-2">
      <div className="relative">
        {state === "active" && !reduce && (
          <motion.span
            aria-hidden
            className="absolute inset-0 rounded-lg ring-2 ring-accent"
            animate={{ opacity: [0.7, 0], scale: [1, 1.45] }}
            transition={{ duration: 1.4, repeat: Infinity, ease: "easeOut", delay: index * 0.12 }}
          />
        )}
        <motion.span
          key={state}
          initial={state === "done" && !reduce ? { scale: 0.6 } : false}
          animate={{ scale: 1 }}
          transition={{ type: "spring", stiffness: 500, damping: 28 }}
          className={cn(
            "relative grid size-8 place-items-center rounded-lg border transition-colors duration-200",
            state === "pending" && "border-line bg-raised text-subtle",
            state === "active" && "border-accent/60 bg-accent/15 text-accent",
            state === "done" && "border-ok/40 bg-ok/12 text-ok",
            state === "failed" && "border-bad/50 bg-bad/12 text-bad",
          )}
        >
          <Icon size={15} strokeWidth={state === "done" ? 2.5 : 2} aria-hidden />
        </motion.span>
      </div>
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-[13px] font-medium">
          <span className="font-mono text-[10px] text-subtle">{index + 1}</span>
          <span className={state === "pending" ? "text-muted" : "text-fg"}>{step.label}</span>
          <span className="sr-only">
            {state === "active" ? "(in progress)" : state === "done" ? "(complete)" : state === "failed" ? "(failed)" : "(waiting)"}
          </span>
        </p>
        <p className="truncate font-mono text-[11px] text-subtle tabular">{metric}</p>
      </div>
    </div>
  );
}

function Connector({ state }: { state: "idle" | "flow" | "done" }) {
  const reduce = useReducedMotion();
  return (
    <div aria-hidden className="relative mt-4 hidden h-px flex-1 overflow-hidden bg-line lg:block">
      {state === "done" && <div className="absolute inset-0 bg-ok/50" />}
      {state === "flow" && !reduce && (
        <motion.div
          className="absolute inset-y-0 w-1/2 bg-linear-to-r from-transparent via-accent to-transparent"
          animate={{ x: ["-100%", "200%"] }}
          transition={{ duration: 1.1, repeat: Infinity, ease: "linear" }}
        />
      )}
      {state === "flow" && reduce && <div className="absolute inset-0 bg-accent/50" />}
    </div>
  );
}

function Readout({ label, value, sub, bar }: { label: string; value: string; sub?: string; bar?: number | null }) {
  return (
    <div className="min-w-0 px-4 py-3">
      <dt className="text-[11px] tracking-wide text-subtle uppercase">{label}</dt>
      <dd className="mt-0.5 font-mono text-[15px] font-medium text-fg tabular">{value}</dd>
      {bar != null && (
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-line" aria-hidden>
          <div className="h-full rounded-full bg-muted/70" style={{ width: `${Math.max(2, Math.min(100, bar * 100))}%` }} />
        </div>
      )}
      {sub && <dd className="mt-0.5 truncate text-[11px] text-subtle">{sub}</dd>}
    </div>
  );
}

export function PipelineTracker({ live, run }: { live: LiveRun | null; run?: RunDetail }) {
  const t = live?.telemetry ?? (run ? telemetryFromRun(run) : null);
  const states = stepStates(run && !live ? null : live, t);
  const finished = states.every((s) => s === "done");
  const running = live?.status === "running";
  const progress =
    t?.frames_expected && live?.phase === "frames" ? Math.min(1, t.frames_read / t.frames_expected) : null;

  const headline =
    live?.status === "queued"
      ? "Queued — waiting for the worker"
      : live?.status === "failed"
        ? "Run failed"
        : finished
          ? "Pipeline complete"
          : !live?.phase
            ? "Starting — probing and hashing the source"
            : live.phase === "frames"
              ? "Reading frames"
              : live.phase === "count"
                ? "Deduplicating across frames"
                : "Writing outputs";

  return (
    <section aria-label="Pipeline progress" className="rounded-(--radius-card) border border-line bg-surface">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-2.5">
        <h2 className="text-[13px] font-semibold" aria-live="polite">
          {headline}
        </h2>
        {progress != null && (
          <span className="font-mono text-xs text-muted tabular">{pct(progress)}</span>
        )}
        <span className="ml-auto font-mono text-xs text-subtle tabular">
          {t ? `${duration(t.elapsed_s)} elapsed` : ""}
        </span>
      </header>

      {progress != null && (
        <div className="h-0.5 bg-line" aria-hidden>
          <motion.div className="h-full bg-accent" animate={{ width: `${progress * 100}%` }} transition={{ duration: 0.4 }} />
        </div>
      )}

      <ol className="grid grid-cols-2 gap-4 px-4 py-4 sm:grid-cols-3 lg:flex lg:items-start lg:gap-3">
        {STEPS.map((step, i) => (
          <li key={step.key} className="flex min-w-0 items-start gap-3 lg:flex-1">
            <StepNode
              step={step}
              state={states[i]!}
              index={i}
              metric={t ? step.metric(t, states[i] === "done") : "—"}
            />
            {i < STEPS.length - 1 && (
              <Connector
                state={
                  states[i] === "done" && states[i + 1] !== "pending"
                    ? "done"
                    : states[i] === "active" && running
                      ? "flow"
                      : "idle"
                }
              />
            )}
          </li>
        ))}
      </ol>

      {live?.status === "failed" && live.error && (
        <p role="alert" className="mx-4 mb-4 rounded-md border border-bad/30 bg-bad/10 px-3 py-2 font-mono text-xs text-bad">
          {live.error}
        </p>
      )}

      {t && (
        <dl className="grid grid-cols-2 divide-line border-t border-line sm:grid-cols-3 lg:grid-cols-6 lg:divide-x">
          <Readout label="Throughput" value={`${t.fps.toFixed(1)} fps`} sub="sampled frames / s" />
          <Readout
            label="Frames"
            value={num(t.frames_read)}
            sub={t.frames_expected ? `of ~${num(t.frames_expected)} sampled` : "sampled"}
          />
          <Readout
            label="Dropped"
            value={num(t.frames_dropped)}
            sub={t.frames_read ? `${pct(t.frames_dropped / t.frames_read)} by quality gate` : "by quality gate"}
          />
          <Readout
            label="Blur score"
            value={t.blur != null ? num(t.blur) : "—"}
            sub={t.blur_avg != null ? `avg ${num(t.blur_avg)} · higher is sharper` : "Laplacian variance"}
          />
          <Readout
            label="Lighting"
            value={t.brightness != null ? `${Math.round((t.brightness / 255) * 100)}%` : "—"}
            bar={t.brightness != null ? t.brightness / 255 : null}
            sub={t.brightness_avg != null ? `avg luminance ${Math.round(t.brightness_avg)}/255` : "mean luminance"}
          />
          <Readout label="Objects" value={num(t.tracks || null)} sub={t.tracks ? "after dedup" : "counted at the end"} />
        </dl>
      )}
    </section>
  );
}
