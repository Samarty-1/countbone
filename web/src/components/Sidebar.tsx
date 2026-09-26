import { AlertTriangle, CheckCircle2, CircleDashed, Loader2, Plus, ScanLine, XCircle } from "lucide-react";
import type { LiveRun, RunSummary } from "@/lib/api";
import { cn } from "@/lib/cn";
import { ago, pct, runTitle } from "@/lib/format";
import { useHealth, useRuns } from "@/lib/queries";
import { href, type Route } from "@/lib/route";
import { Kbd, Skeleton } from "./ui";

function Logo() {
  return (
    <a href="#/new" className="flex items-center gap-2.5 px-1" aria-label="countbone home">
      <span className="grid size-7 place-items-center rounded-md bg-accent/15 text-accent ring-1 ring-inset ring-accent/30">
        <ScanLine size={16} aria-hidden />
      </span>
      <span className="text-[14px] font-semibold tracking-tight">countbone</span>
    </a>
  );
}

interface Entry {
  runId: string;
  title: string;
  sub: string;
  state: "live" | "failed" | "review" | "clean";
}

function toEntries(inFlight: LiveRun[], runs: RunSummary[]): Entry[] {
  const done = new Set(runs.map((r) => r.run_id));
  const live: Entry[] = inFlight
    .filter((r) => !done.has(r.run_id) && r.status !== "done")
    .map((r) => ({
      runId: r.run_id,
      title: runTitle(r.run_id, r.source, r.filename),
      sub: r.status === "failed" ? "Failed" : r.status === "queued" ? "Queued" : "Counting…",
      state: r.status === "failed" ? "failed" : "live",
    }));
  const names = new Map(inFlight.map((r) => [r.run_id, r.filename]));
  const finished: Entry[] = runs.map((r) => ({
    runId: r.run_id,
    title: runTitle(r.run_id, r.source, names.get(r.run_id)),
    sub: `${r.total} units · ${pct(r.overall_confidence)} · ${ago(r.started_at)}`,
    state: r.needs_review ? "review" : "clean",
  }));
  return [...live.reverse(), ...finished];
}

const STATE_ICON = {
  live: <Loader2 size={14} className="animate-spin text-accent" aria-label="Counting" />,
  failed: <XCircle size={14} className="text-bad" aria-label="Failed" />,
  review: <AlertTriangle size={14} className="text-warn" aria-label="Needs review" />,
  clean: <CheckCircle2 size={14} className="text-ok" aria-label="Clean" />,
};

export function Sidebar({ route }: { route: Route }) {
  const runs = useRuns();
  const health = useHealth();
  const entries = runs.data ? toEntries(runs.data.inFlight, runs.data.runs) : [];
  const activeId = route.view === "run" ? route.runId : null;

  return (
    <nav
      aria-label="Runs"
      className="flex h-full w-full flex-col border-r border-line bg-surface lg:w-64"
    >
      <div className="flex h-12 items-center justify-between border-b border-line px-3">
        <Logo />
        <span className="hidden items-center gap-1 text-subtle lg:flex">
          <Kbd>N</Kbd>
        </span>
      </div>

      <div className="p-2">
        <a
          href="#/new"
          className={cn(
            "flex h-8 items-center gap-2 rounded-md border border-dashed border-line-strong px-2.5 text-[13px]",
            "text-muted transition-colors hover:border-accent/60 hover:bg-accent/5 hover:text-fg pointer-coarse:h-11",
            route.view === "new" && "border-accent/60 bg-accent/5 text-fg",
          )}
        >
          <Plus size={15} aria-hidden /> New count
        </a>
      </div>

      <p className="px-4 pt-2 pb-1 text-[11px] font-medium tracking-wider text-subtle uppercase">Runs</p>
      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {runs.isLoading &&
          Array.from({ length: 5 }, (_, i) => (
            <li key={i} className="px-2 py-2">
              <Skeleton className="mb-1.5 h-3.5 w-32" />
              <Skeleton className="h-3 w-44" />
            </li>
          ))}
        {runs.isError && (
          <li className="px-2 py-3 text-xs text-bad">Can't reach the API. Is `countbone serve` running?</li>
        )}
        {runs.data && entries.length === 0 && (
          <li className="flex items-center gap-2 px-2 py-3 text-xs text-subtle">
            <CircleDashed size={14} aria-hidden /> No runs yet
          </li>
        )}
        {entries.map((e) => (
          <li key={e.runId}>
            <a
              href={href({ view: "run", runId: e.runId, tab: "results", frame: null, review: false, sku: null })}
              aria-current={e.runId === activeId ? "page" : undefined}
              className={cn(
                "group flex items-start gap-2.5 rounded-md px-2 py-2 transition-colors",
                "hover:bg-hover pointer-coarse:py-3",
                e.runId === activeId && "bg-hover ring-1 ring-inset ring-line-strong",
              )}
            >
              <span className="mt-0.5">{STATE_ICON[e.state]}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-xs text-fg">{e.title}</span>
                <span className="block truncate text-xs text-subtle">{e.sub}</span>
              </span>
            </a>
          </li>
        ))}
      </ul>

      <footer className="border-t border-line px-4 py-3 text-[11px] text-subtle">
        {health.data ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono">
            <dt>detect</dt>
            <dd className="text-muted">{health.data.detect}</dd>
            <dt>identify</dt>
            <dd className="text-muted">{health.data.identify}</dd>
            <dt>count</dt>
            <dd className="text-muted">{health.data.count}</dd>
            <dt>plugins</dt>
            <dd className="text-muted">{health.data.plugins.length} active</dd>
          </dl>
        ) : (
          <span className="flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-bad" aria-hidden />
            {health.isLoading ? "Connecting…" : "API offline"}
          </span>
        )}
      </footer>
    </nav>
  );
}
