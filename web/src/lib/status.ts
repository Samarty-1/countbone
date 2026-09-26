import type { CatalogEntry, Review, SkuCountRow } from "./api";

export type Tier = "high" | "medium" | "review";

/**
 * Display bands for confidence. 0.60 matches review_queue's *default*
 * sku_threshold; the actual threshold is configurable, so buildRows lets an
 * open whole-SKU review from the pipeline override these.
 */
export const REVIEW_BELOW = 0.6;
export const HIGH_FROM = 0.85;

export function tierOf(confidence: number | null | undefined): Tier {
  const c = confidence ?? 0;
  if (c < REVIEW_BELOW) return "review";
  if (c < HIGH_FROM) return "medium";
  return "high";
}

export const TIER_LABEL: Record<Tier, string> = {
  high: "High",
  medium: "Medium",
  review: "Needs review",
};

export interface SkuRow extends SkuCountRow {
  tier: Tier;
  pending: number;
  reviewedCount: number | null;
  /** Variance against the recount, when there is one and an expected count. */
  reviewedVariance: number | null;
  swatch: string | null;
}

/** Join counts with the catalog and the review queue into one table row. */
export function buildRows(
  counts: SkuCountRow[],
  reviews: Review[],
  catalog: CatalogEntry[] | undefined,
  unknownSku: string,
): SkuRow[] {
  const bySku = new Map(catalog?.map((c) => [c.sku, c]));
  return counts.map((c) => {
    const mine = reviews.filter((r) => r.sku === c.sku);
    // A recount lives on the whole-SKU review, resolved by a person.
    const recount = mine.find(
      (r) => r.meta.scope === "sku" && r.status !== "pending" && r.meta.resolved_count != null,
    );
    const reviewedCount = recount?.meta.resolved_count ?? null;
    return {
      ...c,
      reviewedCount,
      reviewedVariance: reviewedCount != null && c.expected != null ? reviewedCount - c.expected : null,
      // The pipeline's own verdict wins over the UI's default thresholds:
      // review_queue's sku_threshold is configurable, and when it raised a
      // whole-SKU review that is still open, this SKU needs review, full stop.
      // An object nobody could name always does too, however sure the box is.
      tier:
        c.sku === unknownSku || mine.some((r) => r.meta.scope === "sku" && r.status === "pending")
          ? "review"
          : tierOf(c.confidence),
      pending: mine.filter((r) => r.status === "pending").length,
      swatch: bySku.get(c.sku)?.swatch ?? null,
    };
  });
}

/** The colour the colour-identifier measured, from OpenCV HSV (H 0-179, S/V 0-255). */
export function hsvToHex(h: number, s: number, v: number): string {
  const hh = (h * 2) / 60;
  const ss = s / 255;
  const vv = v / 255;
  const c = vv * ss;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const [r, g, b] =
    hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
  const m = vv - c;
  return `#${[r, g, b].map((n) => Math.round((n + m) * 255).toString(16).padStart(2, "0")).join("")}`;
}

export function hueCentre(entry: CatalogEntry): number | null {
  if (!entry.hue) return null;
  const [lo, hi] = entry.hue;
  const span = lo <= hi ? hi - lo : 180 - lo + hi;
  return (lo + span / 2) % 180;
}

/** Shortest distance round the OpenCV hue wheel, in its native 0-179 units. */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 180;
  return Math.min(d, 180 - d);
}

export interface Candidate {
  entry: CatalogEntry;
  /** Degrees on a 360° wheel, which is what people expect to read. */
  distanceDeg: number | null;
  inBand: boolean;
}

/**
 * Rank catalog SKUs by how close their hue band is to the colour the
 * identifier measured on this crop. That is the model's own evidence, so the
 * ranking shows the reviewer why it chose what it chose, and what came next.
 */
export function rankCandidates(
  catalog: CatalogEntry[],
  hue: number | undefined,
  sat: number | undefined,
): Candidate[] {
  const out = catalog.map((entry) => {
    const centre = hueCentre(entry);
    // Below the catalog's saturation floor the identifier ignores hue, and
    // so must we: hue of a near-grey patch is noise, not evidence.
    const washedOut = sat != null && sat < entry.min_saturation;
    if (hue == null || centre == null || washedOut) return { entry, distanceDeg: null, inBand: false };
    const [lo, hi] = entry.hue!;
    const inBand = lo <= hi ? hue >= lo && hue <= hi : hue >= lo || hue <= hi;
    return { entry, distanceDeg: hueDistance(hue, centre) * 2, inBand };
  });
  return out.sort((a, b) => (a.distanceDeg ?? 999) - (b.distanceDeg ?? 999));
}
