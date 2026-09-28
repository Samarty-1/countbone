import type { SkuRow } from "./status";

function download(name: string, body: string, type: string) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

const COLUMNS = [
  "sku",
  "label",
  "count",
  "reviewed_count",
  "expected",
  "variance",
  "reviewed_variance",
  "confidence",
  "status",
  "pending_reviews",
] as const;

const record = (runId: string, r: SkuRow) => ({
  run_id: runId,
  sku: r.sku,
  label: r.label ?? "",
  count: r.count,
  reviewed_count: r.reviewedCount,
  expected: r.expected,
  variance: r.variance,
  reviewed_variance: r.reviewedVariance,
  confidence: r.confidence == null ? null : Number(r.confidence.toFixed(4)),
  status: r.tier,
  pending_reviews: r.pending,
});

/**
 * The rows as currently filtered, with reviewer recounts alongside the
 * machine count. The pipeline's own counts.csv / result.json stay the
 * untouched record; these exports are the working view.
 */
export function exportCsv(runId: string, rows: SkuRow[]) {
  const lines = [
    ["run_id", ...COLUMNS].join(","),
    ...rows.map((r) => {
      const rec = record(runId, r);
      return [rec.run_id, ...COLUMNS.map((c) => rec[c])].map(csvCell).join(",");
    }),
  ];
  download(`${runId}-counts.csv`, lines.join("\r\n"), "text/csv;charset=utf-8");
}

export function exportJson(runId: string, rows: SkuRow[]) {
  const body = JSON.stringify(
    { run_id: runId, exported_at: new Date().toISOString(), counts: rows.map((r) => record(runId, r)) },
    null,
    2,
  );
  download(`${runId}-counts.json`, body, "application/json");
}
