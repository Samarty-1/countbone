import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, ChevronDown, ClipboardCheck, FileQuestion, Fingerprint, ScanEye, Table2 } from "lucide-react";
import { ApiError, isPending, type RunDetail } from "@/lib/api";
import { cn } from "@/lib/cn";
import { duration, runTitle, shortId } from "@/lib/format";
import { useCatalog, useHealth, useRun, useRuns } from "@/lib/queries";
import { navigate, patchRun, type Route } from "@/lib/route";
import { buildRows } from "@/lib/status";
import { Button, Empty, Skeleton } from "@/components/ui";
import { PipelineTracker } from "@/features/pipeline/PipelineTracker";
import { MetricCards } from "@/features/results/MetricCards";
import { CountsTable } from "@/features/results/CountsTable";
import { ReviewDrawer } from "@/features/review/ReviewDrawer";
import { FrameInspector } from "@/features/inspector/FrameInspector";

type RunRoute = Extract<Route, { view: "run" }>;

function Warnings({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  return (
    <div role="status" className="rounded-(--radius-card) border border-warn/30 bg-warn/[0.06] px-4 py-3">
      <p className="mb-1 flex items-center gap-2 text-[13px] font-medium text-warn">
        <AlertTriangle size={15} aria-hidden /> {warnings.length === 1 ? "1 warning" : `${warnings.length} warnings`} from the pipeline
      </p>
      <ul className="ml-6 list-disc space-y-0.5 text-xs text-muted marker:text-warn/60">
        {warnings.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
    </div>
  );
}

function Provenance({ run }: { run: RunDetail }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-(--radius-card) border border-line bg-surface">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-2 px-4 py-2.5 text-left text-[13px] font-semibold pointer-coarse:py-3"
      >
        <Fingerprint size={15} className="text-subtle" aria-hidden /> Pipeline &amp; provenance
        <ChevronDown size={15} aria-hidden className={cn("ml-auto text-subtle transition-transform duration-200", open && "rotate-180")} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="space-y-4 border-t border-line p-4">
              <PipelineTracker live={run.live} run={run} />
              <dl className="grid gap-x-6 gap-y-1.5 font-mono text-xs sm:grid-cols-[auto_1fr]">
                <dt className="text-subtle">source</dt>
                <dd className="break-all text-muted">{run.source}</dd>
                <dt className="text-subtle">config</dt>
                <dd className="text-muted">{run.config_fingerprint ?? "—"}</dd>
                {run.meta.audit && (
                  <>
                    <dt className="text-subtle">manifest sha256</dt>
                    <dd className="break-all text-muted">{run.meta.audit.manifest_sha256}</dd>
                    <dt className="text-subtle">source sha256</dt>
                    <dd className="break-all text-muted">{run.meta.audit.source_sha256 ?? "—"}</dd>
                  </>
                )}
              </dl>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

function Tabs({ route, pending }: { route: RunRoute; pending: number }) {
  const tabs = [
    { key: "results" as const, label: "Results", icon: Table2 },
    { key: "inspect" as const, label: "Frame inspector", icon: ScanEye },
  ];
  return (
    <nav aria-label="Run views" className="flex gap-1">
      {tabs.map((t) => (
        <button
          key={t.key}
          aria-current={route.tab === t.key ? "page" : undefined}
          onClick={() => patchRun(route, { tab: t.key, frame: null })}
          className={cn(
            "relative inline-flex h-10 cursor-pointer items-center gap-2 px-3 text-[13px] transition-colors pointer-coarse:h-11",
            route.tab === t.key ? "text-fg" : "text-muted hover:text-fg",
          )}
        >
          <t.icon size={15} aria-hidden />
          {t.label}
          {route.tab === t.key && (
            <motion.span layoutId="tab-underline" className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />
          )}
        </button>
      ))}
      <span className="sr-only">{pending} items to check</span>
    </nav>
  );
}

export function RunView({ route }: { route: RunRoute }) {
  const q = useRun(route.runId);
  const catalog = useCatalog();
  const health = useHealth();
  const runs = useRuns();
  const unknownSku = health.data?.unknown_sku ?? "UNKNOWN";

  const detail = q.data && !isPending(q.data) ? q.data : null;
  const rows = useMemo(
    () => (detail ? buildRows(detail.counts, detail.reviews, catalog.data, unknownSku) : []),
    [detail, catalog.data, unknownSku],
  );

  if (q.isLoading) {
    return (
      <div className="space-y-4 p-4 sm:p-6">
        <Skeleton className="h-7 w-64" />
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-80" />
      </div>
    );
  }

  if (q.isError || !q.data) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return (
      <Empty icon={FileQuestion} title={notFound ? "Run not found" : "Couldn't load this run"} className="h-full">
        {notFound ? "It may have been counted against a different database." : String(q.error)}
        <div className="mt-4">
          <Button onClick={() => navigate({ view: "new" })}>New count</Button>
        </div>
      </Empty>
    );
  }

  const filename = runs.data?.inFlight.find((r) => r.run_id === route.runId)?.filename;

  if (isPending(q.data)) {
    const live = q.data.pending;
    return (
      <div className="space-y-4 p-4 sm:p-6">
        <header>
          <h1 className="font-mono text-lg font-semibold">{runTitle(route.runId, live.source, live.filename)}</h1>
          <p className="mt-0.5 font-mono text-xs text-subtle">{route.runId}</p>
        </header>
        <PipelineTracker live={live} />
        {live.status !== "failed" && (
          <p className="text-xs text-subtle">
            Results appear here when the run is committed: counts, the review queue and the audit pack are written
            together, so you never see a half-finished run.
          </p>
        )}
      </div>
    );
  }

  const run = q.data;
  const pending = run.reviews.filter((r) => r.status === "pending").length;

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-line bg-surface/60 px-4 pt-4 sm:px-6">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0">
            <h1 className="truncate font-mono text-lg font-semibold">{runTitle(run.run_id, run.source, filename)}</h1>
            <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-subtle">
              <span className="font-mono">{shortId(run.run_id)}</span>
              <span>{new Date(run.started_at * 1000).toLocaleString()}</span>
              <span>{duration(run.duration_s)} to count</span>
            </p>
          </div>
          <div className="ml-auto">
            <Button
              variant={pending ? "primary" : "secondary"}
              icon={ClipboardCheck}
              onClick={() => patchRun(route, { review: true })}
            >
              Items to check
              <span
                className={cn(
                  "ml-0.5 rounded px-1.5 font-mono text-[11px] tabular",
                  pending ? "bg-accent-fg/15" : "bg-hover text-subtle",
                )}
              >
                {pending}
              </span>
            </Button>
          </div>
        </div>
        <div className="mt-2">
          <Tabs route={route} pending={pending} />
        </div>
      </header>

      <div className="flex-1 space-y-4 p-4 sm:p-6">
        {route.tab === "results" ? (
          <>
            <Warnings warnings={run.meta.warnings ?? []} />
            <MetricCards run={run} rows={rows} unknownSku={unknownSku} onOpenReview={() => patchRun(route, { review: true })} />
            <CountsTable
              run={run}
              rows={rows}
              onInspectSku={(sku) => patchRun(route, { tab: "inspect", sku, frame: null })}
              onReviewSku={(sku) => patchRun(route, { review: true, sku })}
            />
            <Provenance run={run} />
          </>
        ) : (
          <FrameInspector
            key={run.run_id}
            runId={run.run_id}
            catalog={catalog.data}
            initialFrame={route.frame}
            skuFilter={route.sku}
            onFrameChange={(frame) => patchRun(route, { frame }, { replace: true })}
            onSkuFilter={(sku) => patchRun(route, { sku }, { replace: true })}
          />
        )}
      </div>

      <ReviewDrawer
        open={route.review}
        run={run}
        catalog={catalog.data ?? []}
        unknownSku={unknownSku}
        skuFilter={route.review ? route.sku : null}
        onClearFilter={() => patchRun(route, { sku: null }, { replace: true })}
        onClose={() => patchRun(route, { review: false, sku: route.tab === "inspect" ? route.sku : null })}
        // Whole-SKU reviews have no frame (-1): open at the start, filtered to the SKU.
        onInspect={(r) =>
          patchRun(route, { review: false, tab: "inspect", frame: r.frame_index >= 0 ? r.frame_index : null, sku: r.sku })
        }
      />
    </div>
  );
}
