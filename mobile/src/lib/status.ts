import type { CatalogEntry, Review, SkuCountRow } from './api.ts';

export type Tier = 'high' | 'medium' | 'review';

/**
 * Confidence bands, identical to the dashboard's (web/src/lib/status.ts).
 * 0.60 is review_queue's default sku_threshold; an open whole-SKU review from
 * the pipeline overrides it, because that threshold is configurable.
 */
export const REVIEW_BELOW = 0.6;
export const HIGH_FROM = 0.85;

export function tierOf(confidence: number | null | undefined): Tier {
  const c = confidence ?? 0;
  if (c < REVIEW_BELOW) return 'review';
  if (c < HIGH_FROM) return 'medium';
  return 'high';
}

export const TIER_LABEL: Record<Tier, string> = { high: 'High', medium: 'Medium', review: 'Review' };

export interface SkuRow extends SkuCountRow {
  tier: Tier;
  pending: number;
  /** A reviewer's recount, when one was recorded. */
  reviewedCount: number | null;
  swatch: string | null;
}

export function buildRows(
  counts: SkuCountRow[],
  reviews: Review[],
  catalog: CatalogEntry[] | undefined,
  unknownSku: string,
): SkuRow[] {
  const bySku = new Map(catalog?.map((c) => [c.sku, c]));
  return counts.map((c) => {
    const mine = reviews.filter((r) => r.sku === c.sku);
    const recount = mine.find((r) => r.meta.scope === 'sku' && r.status !== 'pending' && r.meta.resolved_count != null);
    return {
      ...c,
      reviewedCount: recount?.meta.resolved_count ?? null,
      tier:
        c.sku === unknownSku || mine.some((r) => r.meta.scope === 'sku' && r.status === 'pending')
          ? 'review'
          : tierOf(c.confidence),
      pending: mine.filter((r) => r.status === 'pending').length,
      swatch: bySku.get(c.sku)?.swatch ?? null,
    };
  });
}

/** The colour the identifier measured, from OpenCV HSV (H 0-179, S/V 0-255). */
export function hsvToHex(h: number, s: number, v: number): string {
  const hh = (h * 2) / 60;
  const ss = s / 255;
  const vv = v / 255;
  const c = vv * ss;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const [r, g, b] =
    hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
  const m = vv - c;
  return `#${[r, g, b]
    .map((n) =>
      Math.round((n + m) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

function hueCentre(entry: CatalogEntry): number | null {
  if (!entry.hue) return null;
  const [lo, hi] = entry.hue;
  const span = lo <= hi ? hi - lo : 180 - lo + hi;
  return (lo + span / 2) % 180;
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 180;
  return Math.min(d, 180 - d);
}

export interface Candidate {
  entry: CatalogEntry;
  /** Degrees on a 360° wheel. */
  distanceDeg: number | null;
  inBand: boolean;
}

/**
 * Catalog SKUs ranked by how close their hue band is to the colour measured
 * on this crop: the model's own evidence, so the reviewer sees why it chose
 * what it chose and what came next.
 */
export function rankCandidates(catalog: CatalogEntry[], hue: number | undefined, sat: number | undefined): Candidate[] {
  const out = catalog.map((entry): Candidate => {
    const centre = hueCentre(entry);
    // Below the saturation floor the identifier ignores hue, and so must we.
    const washedOut = sat != null && sat < entry.min_saturation;
    if (hue == null || centre == null || washedOut || !entry.hue) return { entry, distanceDeg: null, inBand: false };
    const [lo, hi] = entry.hue;
    const inBand = lo <= hi ? hue >= lo && hue <= hi : hue >= lo || hue <= hi;
    return { entry, distanceDeg: hueDistance(hue, centre) * 2, inBand };
  });
  return out.sort((a, b) => (a.distanceDeg ?? 999) - (b.distanceDeg ?? 999));
}
