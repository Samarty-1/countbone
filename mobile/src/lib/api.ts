/**
 * The countbone HTTP surface, typed. Shapes mirror countbone/api/app.py and
 * store/db.py, and the dashboard's web/src/lib/api.ts: the two clients talk
 * to one server and must agree about it.
 *
 * Unlike the dashboard, the app is never served by the API it talks to, so
 * every call takes the server's base URL explicitly (from settings).
 */

export type Phase = 'frames' | 'count' | 'output' | 'done' | 'failed';
export type LiveStatus = 'queued' | 'running' | 'done' | 'failed';

export interface Telemetry {
  frames_expected: number | null;
  frames_read: number;
  frames_kept: number;
  frames_dropped: number;
  detections: number;
  items: number;
  tracks: number;
  fps: number;
  elapsed_s: number;
  blur: number | null;
  blur_avg: number | null;
  brightness: number | null;
  brightness_avg: number | null;
}

export interface LiveRun {
  run_id: string;
  status: LiveStatus;
  source: string;
  filename?: string;
  error: string | null;
  phase?: Phase;
  telemetry?: Telemetry;
  total?: number;
  needs_review?: boolean;
  confidence?: number;
}

export interface RunSummary {
  run_id: string;
  source: string;
  started_at: number;
  finished_at: number | null;
  duration_s: number | null;
  frames_read: number;
  frames_used: number;
  frames_dropped: number;
  detections: number;
  tracks: number;
  total: number;
  overall_confidence: number;
  needs_review: boolean;
}

export interface SkuCountRow {
  sku: string;
  label: string | null;
  count: number;
  expected: number | null;
  variance: number | null;
  confidence: number | null;
}

export type ReviewStatus = 'pending' | 'accepted' | 'rejected' | 'corrected';

export interface ReviewMeta {
  scope?: 'sku' | 'item';
  count?: number;
  expected?: number | null;
  resolved_count?: number;
  hue?: number;
  sat?: number;
  val?: number;
  id_source?: string;
}

export interface Review {
  review_id: string;
  run_id: string;
  sku: string;
  reason: string;
  confidence: number;
  frame_index: number;
  bbox: [number, number, number, number] | null;
  crop_path: string | null;
  status: ReviewStatus;
  resolved_sku: string | null;
  resolved_by: string | null;
  meta: ReviewMeta;
}

export interface RunMeta {
  warnings?: string[];
  capture_quality?: {
    frames_seen: number;
    frames_dropped: number;
    drop_rate: number;
    reasons: Record<string, number>;
  };
  source_info?: { fps: number; width: number; height: number; duration_s: number | null };
}

export interface RunDetail extends RunSummary {
  meta: RunMeta;
  counts: SkuCountRow[];
  reviews: Review[];
  live: LiveRun | null;
}

export type RunResponse = RunDetail | { run_id: string; pending: LiveRun };

export interface CatalogEntry {
  sku: string;
  label: string;
  hue: [number, number] | null;
  achromatic: boolean;
  min_saturation: number;
  unit_value: number;
  expected: number | null;
  swatch: string | null;
}

export interface Health {
  status: string;
  detect: string;
  identify: string;
  count: string;
  unknown_sku: string;
  plugins: string[];
}

/** What to upload: a file on the device (native) or a blob in memory (web). */
export type UploadMedia =
  | { kind: 'file'; uri: string; name: string; mimeType: string }
  | { kind: 'blob'; blob: Blob; name: string };

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const TIMEOUT_MS = 10_000;

function join(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

async function detailOf(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object' && 'detail' in body) {
      const d = (body as { detail: unknown }).detail;
      return typeof d === 'string' ? d : JSON.stringify(d);
    }
  } catch {
    /* not JSON: fall through to the status text */
  }
  return res.statusText || `HTTP ${res.status}`;
}

async function request<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(join(base, path), { ...init, signal: controller.signal });
  } catch (err) {
    // A phone on the wrong Wi-Fi is the common case; say that, not "TypeError".
    const why = controller.signal.aborted ? 'timed out' : 'unreachable';
    throw new ApiError(
      0,
      `Server ${why} at ${base}${err instanceof Error && !controller.signal.aborted ? ` (${err.message})` : ''}`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new ApiError(res.status, await detailOf(res));
  return (await res.json()) as T;
}

/** The store returns some columns as JSON text; parse them once, here. */
function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normaliseReview(raw: Record<string, unknown>): Review {
  return {
    ...(raw as unknown as Review),
    bbox: parseJson<Review['bbox']>(raw.bbox, null),
    meta: parseJson<ReviewMeta>(raw.meta, {}),
  };
}

function normaliseSummary(raw: Record<string, unknown>): RunSummary {
  return { ...(raw as unknown as RunSummary), needs_review: Boolean(raw.needs_review) };
}

export const isPending = (r: RunResponse): r is { run_id: string; pending: LiveRun } => 'pending' in r;

/** Artifacts are stored with OS separators; URLs want forward slashes. */
export const artifactUrl = (base: string, runId: string, path: string): string =>
  join(base, `/api/runs/${encodeURIComponent(runId)}/artifacts/${path.replaceAll('\\', '/')}`);

export interface UploadHandle {
  promise: Promise<{ run_id: string }>;
  cancel: () => void;
}

export function createApi(base: string) {
  return {
    base,
    health: () => request<Health>(base, '/api/health'),
    catalog: () => request<CatalogEntry[]>(base, '/api/catalog'),

    runs: async (limit = 50) => {
      const body = await request<{ in_flight: LiveRun[]; runs: Record<string, unknown>[] }>(
        base,
        `/api/runs?limit=${limit}`,
      );
      return { inFlight: body.in_flight, runs: body.runs.map(normaliseSummary) };
    },

    run: async (runId: string): Promise<RunResponse> => {
      const body = await request<Record<string, unknown>>(base, `/api/runs/${encodeURIComponent(runId)}`);
      if ('pending' in body) return body as unknown as RunResponse;
      return {
        ...normaliseSummary(body),
        meta: parseJson<RunMeta>(body.meta, {}),
        counts: (body.counts as SkuCountRow[] | undefined) ?? [],
        reviews: ((body.reviews as Record<string, unknown>[] | undefined) ?? []).map(normaliseReview),
        live: (body.live as LiveRun | null | undefined) ?? null,
      };
    },

    resolveReview: (
      reviewId: string,
      decision: { status: ReviewStatus; resolved_sku?: string | null; resolved_count?: number | null },
      reviewer: string,
    ) =>
      request<{ review_id: string }>(base, `/api/reviews/${encodeURIComponent(reviewId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewer, ...decision }),
      }),

    /**
     * XHR rather than fetch: fetch cannot report upload progress on either
     * platform, and a two-minute aisle walk with no progress looks like a hang.
     * No timeout: a large file on a slow link legitimately takes minutes.
     */
    upload: (media: UploadMedia, onProgress: (fraction: number) => void): UploadHandle => {
      const xhr = new XMLHttpRequest();
      const promise = new Promise<{ run_id: string }>((resolve, reject) => {
        const form = new FormData();
        if (media.kind === 'blob') {
          form.append('file', media.blob, media.name);
        } else {
          // React Native's FormData streams a file from its URI; the DOM type
          // does not know this shape, hence the cast.
          form.append('file', { uri: media.uri, name: media.name, type: media.mimeType } as unknown as Blob);
        }
        xhr.open('POST', join(base, '/api/runs/upload'));
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
        };
        xhr.onload = () => {
          let body: unknown = null;
          try {
            body = JSON.parse(xhr.responseText);
          } catch {
            /* keep null */
          }
          if (xhr.status >= 200 && xhr.status < 300 && body && typeof body === 'object' && 'run_id' in body) {
            resolve(body as { run_id: string });
          } else {
            const detail =
              body && typeof body === 'object' && 'detail' in body
                ? String((body as { detail: unknown }).detail)
                : null;
            reject(new ApiError(xhr.status, detail ?? `Upload failed (HTTP ${xhr.status})`));
          }
        };
        xhr.onerror = () => reject(new ApiError(0, `Network error uploading to ${base}`));
        xhr.onabort = () => reject(new ApiError(0, 'Upload cancelled'));
        xhr.send(form);
      });
      return { promise, cancel: () => xhr.abort() };
    },
  };
}

export type Api = ReturnType<typeof createApi>;
