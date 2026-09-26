export const pct = (v: number | null | undefined, digits = 0) =>
  v == null ? "—" : `${(v * 100).toFixed(digits)}%`;

export const num = (v: number | null | undefined) =>
  v == null ? "—" : v.toLocaleString(undefined, { maximumFractionDigits: 1 });

export const signed = (v: number | null | undefined) =>
  v == null ? "—" : v > 0 ? `+${v}` : `${v}`;

export const bytes = (n: number) => {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
};

export const duration = (s: number | null | undefined) => {
  if (s == null || !Number.isFinite(s)) return "—";
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
};

export const timecode = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toFixed(2).padStart(5, "0")}`;
};

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
export const ago = (epochS: number) => {
  const diff = epochS - Date.now() / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return "just now";
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  return rtf.format(Math.round(diff / 86400), "day");
};

export const shortId = (runId: string) => runId.replace(/^run_/, "").slice(0, 8);

export const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** Human text for the review queue's machine reasons. */
export const REASONS: Record<string, string> = {
  low_sku_confidence: "Whole SKU uncertain",
  low_item_confidence: "Low-confidence sighting",
  unidentified: "Not matched to any SKU",
};

/**
 * Uploads are stored as <run_id>__<original name>.<ext>, so the original name
 * survives a server restart; the live tracker's copy is exact but memory-only.
 */
export function runTitle(runId: string, source: string, filename?: string) {
  if (filename) return filename;
  const f = fileName(source);
  const upload = /^run_[0-9a-f]+__(.+)$/.exec(f);
  if (upload) return upload[1]!;
  return f.startsWith("run_") ? `Upload ${shortId(runId)}` : f;
}
