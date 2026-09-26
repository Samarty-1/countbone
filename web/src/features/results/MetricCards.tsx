import { AlertTriangle, Boxes, Gauge, type LucideIcon, Package } from "lucide-react";
import { motion } from "motion/react";
import type { RunDetail } from "@/lib/api";
import { cn } from "@/lib/cn";
import { pct } from "@/lib/format";
import { tierOf, type SkuRow } from "@/lib/status";

interface Metric {
  label: string;
  value: string;
  sub: string;
  icon: LucideIcon;
  tone?: "warn" | "ok" | "info";
  action?: { label: string; onClick: () => void };
}

export function MetricCards({
  run,
  rows,
  unknownSku,
  onOpenReview,
}: {
  run: RunDetail;
  rows: SkuRow[];
  unknownSku: string;
  onOpenReview: () => void;
}) {
  const recounted = rows.some((r) => r.reviewedCount != null);
  const reviewedTotal = rows.reduce((n, r) => n + (r.reviewedCount ?? r.count), 0);
  const skus = run.counts.filter((c) => c.count > 0 && c.sku !== unknownSku).length;
  const unknown = run.counts.find((c) => c.sku === unknownSku)?.count ?? 0;
  const pending = run.reviews.filter((r) => r.status === "pending").length;
  const conf = tierOf(run.overall_confidence);

  const metrics: Metric[] = [
    {
      label: "SKUs detected",
      value: String(skus),
      sub: unknown ? `+ ${unknown} unidentified` : `of ${run.counts.length} in result`,
      icon: Boxes,
    },
    {
      label: "Units counted",
      value: run.total.toLocaleString(),
      sub:
        recounted && reviewedTotal !== run.total
          ? `${reviewedTotal.toLocaleString()} after recounts`
          : `${run.tracks} tracks · ${run.detections.toLocaleString()} sightings`,
      icon: Package,
    },
    {
      label: "Overall confidence",
      value: pct(run.overall_confidence),
      sub: `${run.frames_used}/${run.frames_read} frames usable`,
      icon: Gauge,
      tone: conf === "high" ? "ok" : conf === "medium" ? "info" : "warn",
    },
    {
      label: "Items to check",
      value: String(pending),
      sub: pending ? "low-confidence detections" : "queue is clear",
      icon: AlertTriangle,
      tone: pending ? "warn" : "ok",
      action: pending ? { label: "Review", onClick: onOpenReview } : undefined,
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      {metrics.map((m, i) => (
        <motion.div
          key={m.label}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, delay: i * 0.04 }}
          className="group relative rounded-(--radius-card) border border-line bg-surface p-4"
        >
          <div className="flex items-center gap-2 text-subtle">
            <m.icon
              size={14}
              aria-hidden
              className={cn(m.tone === "warn" && "text-warn", m.tone === "ok" && "text-ok", m.tone === "info" && "text-info")}
            />
            <span className="truncate text-xs">{m.label}</span>
            {m.action && (
              <button
                type="button"
                onClick={m.action.onClick}
                className="-my-1 ml-auto shrink-0 cursor-pointer rounded-md px-2 py-1 text-xs font-medium text-warn transition-colors hover:bg-warn/10 pointer-coarse:-my-3 pointer-coarse:py-3"
              >
                {m.action.label} →
              </button>
            )}
          </div>
          <p
            className={cn(
              "mt-2 font-mono text-[26px] leading-none font-semibold tracking-tight tabular",
              m.tone === "warn" && Number(m.value) !== 0 ? "text-warn" : "text-fg",
            )}
          >
            {m.value}
          </p>
          <p className="mt-2 truncate text-xs text-subtle">{m.sub}</p>
        </motion.div>
      ))}
    </div>
  );
}
