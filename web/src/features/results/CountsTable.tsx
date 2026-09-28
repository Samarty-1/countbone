import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  Download,
  FileJson,
  FileSpreadsheet,
  ScanEye,
  Search,
  Table2,
} from "lucide-react";
import type { RunDetail } from "@/lib/api";
import { artifactUrl } from "@/lib/api";
import { cn } from "@/lib/cn";
import { exportCsv, exportJson } from "@/lib/export";
import { signed } from "@/lib/format";
import { TIER_LABEL, type SkuRow, type Tier } from "@/lib/status";
import { Badge, Button, Card, CardHeader, ConfidenceBar, Empty, Swatch, TierBadge } from "@/components/ui";

type SortKey = "sku" | "count" | "confidence" | "variance" | "pending";
type Filter = "all" | Tier;

const FILTERS: Filter[] = ["all", "high", "medium", "review"];

function ExportMenu({ run, rows }: { run: RunDetail; rows: SkuRow[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const outputs = run.meta.outputs ?? {};
  const artifact = (p: string | undefined) =>
    p ? artifactUrl(run.run_id, p.split(/[\\/]/).pop()!) : null;
  const machineCsv = artifact(outputs.csv);
  const machineJson = artifact(outputs.json);

  const item =
    "flex w-full cursor-pointer items-center gap-2.5 rounded px-2.5 py-2 text-left text-[13px] text-fg hover:bg-hover pointer-coarse:py-3";

  // Close on any press outside. Not onBlur: Safari doesn't focus buttons on
  // click, so a blur-based popover never closes there.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <Button size="sm" icon={Download} aria-expanded={open} aria-controls="export-options" onClick={() => setOpen((v) => !v)}>
        Export
      </Button>
      {open && (
        <div
          id="export-options"
          className="absolute top-full right-0 z-20 mt-1 w-64 rounded-lg border border-line-strong bg-raised p-1 shadow-xl shadow-black/40"
        >
          <p className="px-2.5 pt-1.5 pb-1 text-[11px] text-subtle">Current view · {rows.length} rows, with recounts</p>
          <button className={item} onClick={() => (exportCsv(run.run_id, rows), setOpen(false))}>
            <FileSpreadsheet size={15} className="text-ok" aria-hidden /> CSV
          </button>
          <button className={item} onClick={() => (exportJson(run.run_id, rows), setOpen(false))}>
            <FileJson size={15} className="text-warn" aria-hidden /> JSON
          </button>
          {(machineCsv || machineJson) && (
            <>
              <div className="my-1 h-px bg-line" />
              <p className="px-2.5 pt-1 pb-1 text-[11px] text-subtle">Pipeline output · audited, unedited</p>
              {machineCsv && (
                <a className={item} href={machineCsv} download>
                  <FileSpreadsheet size={15} className="text-subtle" aria-hidden /> counts.csv
                </a>
              )}
              {machineJson && (
                <a className={item} href={machineJson} download>
                  <FileJson size={15} className="text-subtle" aria-hidden /> result.json
                </a>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SortHeader({
  label,
  k,
  sort,
  onSort,
  align = "left",
}: {
  label: string;
  k: SortKey;
  sort: { key: SortKey; dir: 1 | -1 };
  onSort: (k: SortKey) => void;
  align?: "left" | "right";
}) {
  const active = sort.key === k;
  const Icon = !active ? ChevronsUpDown : sort.dir === 1 ? ArrowUp : ArrowDown;
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
      className={cn("px-3 py-2 font-medium", align === "right" && "text-right")}
    >
      <button
        type="button"
        onClick={() => onSort(k)}
        className={cn(
          "inline-flex cursor-pointer items-center gap-1 rounded transition-colors hover:text-fg",
          active && "text-fg",
          align === "right" && "flex-row-reverse",
        )}
      >
        {label}
        <Icon size={12} aria-hidden className={active ? "" : "opacity-50"} />
      </button>
    </th>
  );
}

export function CountsTable({
  run,
  rows,
  onInspectSku,
  onReviewSku,
}: {
  run: RunDetail;
  rows: SkuRow[];
  onInspectSku: (sku: string) => void;
  onReviewSku: (sku: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "count", dir: -1 });

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: rows.length, high: 0, medium: 0, review: 0 };
    rows.forEach((r) => c[r.tier]++);
    return c;
  }, [rows]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows
      .filter((r) => filter === "all" || r.tier === filter)
      .filter((r) => !q || r.sku.toLowerCase().includes(q) || (r.label ?? "").toLowerCase().includes(q))
      .sort((a, b) => {
        const av = a[sort.key] ?? -Infinity;
        const bv = b[sort.key] ?? -Infinity;
        return (av < bv ? -1 : av > bv ? 1 : 0) * sort.dir;
      });
  }, [rows, query, filter, sort]);

  const hasExpected = rows.some((r) => r.expected != null);
  const hasRecount = rows.some((r) => r.reviewedCount != null);
  const onSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: key === "sku" ? 1 : -1 }));

  return (
    <Card>
      <CardHeader title="Stock counts" icon={Table2}>
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-subtle" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search SKU or name"
            aria-label="Search SKUs"
            className="h-7 w-44 rounded-md border border-line bg-bg pr-2 pl-8 text-xs text-fg placeholder:text-subtle focus:border-accent/60 pointer-coarse:h-11 sm:w-56"
          />
        </div>
        <ExportMenu run={run} rows={visible} />
      </CardHeader>

      <div role="group" aria-label="Filter by status" className="flex gap-1 overflow-x-auto border-b border-line px-3 py-2">
        {FILTERS.map((f) => (
          <button
            key={f}
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            className={cn(
              "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs whitespace-nowrap transition-colors pointer-coarse:h-11",
              filter === f ? "bg-hover text-fg ring-1 ring-inset ring-line-strong" : "text-muted hover:text-fg",
            )}
          >
            {f === "all" ? "All" : TIER_LABEL[f]}
            <span className="font-mono text-[11px] text-subtle tabular">{counts[f]}</span>
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <Empty icon={Search} title={rows.length ? "No SKUs match" : "Nothing counted"}>
          {rows.length ? "Try a different search or filter." : "The pipeline finished without counting any objects."}
        </Empty>
      ) : (
        <div className="relative overflow-x-auto">
          {/* relative: makes this the containing block for the sr-only header,
              which otherwise escapes the scroller and widens the whole page. */}
          <table className="w-full min-w-[720px] border-collapse text-left">
            <thead className="text-xs text-subtle">
              <tr className="border-b border-line">
                <SortHeader label="SKU" k="sku" sort={sort} onSort={onSort} />
                <SortHeader label="Counted" k="count" sort={sort} onSort={onSort} align="right" />
                {hasExpected && <th scope="col" className="px-3 py-2 text-right font-medium">Expected</th>}
                {hasExpected && <SortHeader label="Variance" k="variance" sort={sort} onSort={onSort} align="right" />}
                <SortHeader label="Confidence" k="confidence" sort={sort} onSort={onSort} />
                <th scope="col" className="px-3 py-2 font-medium">Status</th>
                <SortHeader label="To check" k="pending" sort={sort} onSort={onSort} align="right" />
                <th scope="col" className="w-px px-3 py-2"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.sku} className="group border-b border-line/70 transition-colors last:border-0 hover:bg-raised">
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-3">
                      <Swatch color={r.swatch} label={`${r.sku} reference colour`} size={22} />
                      <div className="min-w-0">
                        <p className="font-mono text-xs font-medium text-fg">{r.sku}</p>
                        <p className="truncate text-xs text-subtle">{r.label}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-[15px] font-semibold tabular">
                    {r.reviewedCount != null && r.reviewedCount !== r.count ? (
                      <span className="inline-flex items-baseline gap-2">
                        <s className="text-xs font-normal text-subtle" title="Machine count">{r.count}</s>
                        <span className="text-accent" title="Reviewer recount">{r.reviewedCount}</span>
                      </span>
                    ) : (
                      r.count
                    )}
                  </td>
                  {hasExpected && <td className="px-3 py-2.5 text-right font-mono text-xs text-muted tabular">{r.expected ?? "—"}</td>}
                  {hasExpected && (
                    <td className="px-3 py-2.5 text-right font-mono text-xs tabular">
                      {(() => {
                        // After a recount, the variance that matters is the recount's.
                        const v = r.reviewedVariance ?? r.variance;
                        const tone = v == null ? "text-subtle" : v === 0 ? "text-ok" : "text-warn";
                        return r.reviewedVariance != null && r.reviewedVariance !== r.variance ? (
                          <span className="inline-flex items-baseline gap-2">
                            <s className="text-subtle" title="Machine variance">{signed(r.variance)}</s>
                            <span className={tone} title="Variance after recount">{signed(v)}</span>
                          </span>
                        ) : (
                          <span className={tone}>{signed(v)}</span>
                        );
                      })()}
                    </td>
                  )}
                  <td className="px-3 py-2.5"><ConfidenceBar value={r.confidence} /></td>
                  <td className="px-3 py-2.5"><TierBadge tier={r.tier} /></td>
                  <td className="px-3 py-2.5 text-right">
                    {r.pending ? (
                      <button
                        type="button"
                        onClick={() => onReviewSku(r.sku)}
                        className="cursor-pointer rounded font-mono text-xs text-warn tabular underline-offset-2 hover:underline pointer-coarse:py-3"
                        aria-label={`Review ${r.pending} items for ${r.sku}`}
                      >
                        {r.pending}
                      </button>
                    ) : (
                      <span className="font-mono text-xs text-subtle">0</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <button
                      type="button"
                      onClick={() => onInspectSku(r.sku)}
                      aria-label={`Inspect ${r.sku} in video`}
                      title="Inspect in video"
                      className="grid size-7 cursor-pointer place-items-center rounded-md text-subtle opacity-60 transition hover:bg-hover hover:text-fg group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:size-11 pointer-coarse:opacity-100"
                    >
                      <ScanEye size={15} aria-hidden />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {hasRecount && (
        <p className="border-t border-line px-4 py-2 text-[11px] text-subtle">
          <Badge tone="accent" className="mr-2">Recount</Badge>
          Blue figures are reviewer recounts. The struck-through machine count stays in the audit trail.
        </p>
      )}
    </Card>
  );
}
