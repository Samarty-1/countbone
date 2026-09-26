/** Display helpers. Kept in step with the dashboard's web/src/lib/format.ts. */

export const pct = (v: number | null | undefined, digits = 0): string =>
  v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(digits)}%`;

export const signed = (v: number | null | undefined): string => (v == null ? '—' : v > 0 ? `+${v}` : `${v}`);

export const bytes = (n: number): string => {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
};

export const duration = (s: number | null | undefined): string => {
  if (s == null || !Number.isFinite(s)) return '—';
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
};

/** m:ss for the recording timer. */
export const clock = (s: number): string => {
  const t = Math.max(0, Math.floor(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

export const ago = (epochS: number): string => {
  const diff = Date.now() / 1000 - epochS;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)} h ago`;
  const days = Math.round(diff / 86400);
  return days === 1 ? 'yesterday' : `${days} days ago`;
};

export const shortId = (runId: string): string => runId.replace(/^run_/, '').slice(0, 8);

export const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

/** Human text for the review queue's machine reasons. */
export const REASONS: Record<string, string> = {
  low_sku_confidence: 'Whole SKU uncertain',
  low_item_confidence: 'Low-confidence sighting',
  unidentified: 'Not matched to any SKU',
};

/** Human text for the quality gate's drop reasons. */
export const DROP_REASONS: Record<string, string> = {
  blur: 'blurred',
  dark: 'too dark',
  bright: 'too bright',
  clipped: 'glare',
};

/**
 * Uploads are stored as <run_id>__<original name>.<ext>, so the original
 * name survives a server restart; the live tracker's copy is memory-only.
 */
export function runTitle(runId: string, source: string, filename?: string): string {
  if (filename) return filename;
  const f = fileName(source);
  const upload = /^run_[0-9a-f]+__(.+)$/.exec(f);
  if (upload?.[1]) return upload[1];
  return f.startsWith('run_') ? `Count ${shortId(runId)}` : f;
}
