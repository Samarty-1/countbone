/**
 * The HTTP surface, typed. Shapes mirror countbone/api/app.py and store/db.py.
 *
 * The store returns some columns as JSON text (review bbox/meta, run meta in
 * listings); they are parsed here, once, so no component ever sees a string
 * where it expects an object.
 */

export type Phase = "frames" | "count" | "output" | "done" | "failed";
export type LiveStatus = "queued" | "running" | "done" | "failed";

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

export type ReviewStatus = "pending" | "accepted" | "rejected" | "corrected";

export interface ReviewMeta {
  scope?: "sku" | "item";
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
  outputs?: Record<string, string>;
  audit?: { manifest_sha256: string; source_sha256: string | null };
  capture_quality?: {
    frames_seen: number;
    frames_dropped: number;
    drop_rate: number;
    reasons: Record<string, number>;
  };
  source_info?: { fps: number; width: number; height: number; duration_s: number | null };
}

export interface RunDetail extends RunSummary {
  config_fingerprint: string | null;
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

export interface InspectorFrame {
  index: number;
  source_index: number;
  t: number;
  kept: boolean;
  quality: { blur?: number; brightness?: number; contrast?: number; clipped_frac?: number };
}

export interface InspectorBox {
  frame: number;
  bbox: [number, number, number, number];
  /** This frame's colour guess. */
  sku: string;
  /** What the object was counted as: the majority of its sightings. Absent in older runs. */
  track_sku?: string | null;
  label: string;
  confidence: number;
  track_id: number | null;
  counted: boolean;
}

export interface InspectorDoc {
  run_id: string;
  frame_size: [number, number] | null;
  frames: InspectorFrame[];
  boxes: InspectorBox[];
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      message = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* not JSON: keep the status text */
    }
    throw new ApiError(res.status, message);
  }
  return res.json() as Promise<T>;
}

const parse = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string") return (value as T) ?? fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

function normaliseReview(raw: Record<string, unknown>): Review {
  return {
    ...(raw as unknown as Review),
    bbox: parse(raw.bbox, null),
    meta: parse(raw.meta, {}),
  };
}

function normaliseSummary(raw: Record<string, unknown>): RunSummary {
  return { ...(raw as unknown as RunSummary), needs_review: Boolean(raw.needs_review) };
}

export const isPending = (r: RunResponse): r is { run_id: string; pending: LiveRun } =>
  "pending" in r;

/** Artifacts are stored with OS separators; URLs want forward slashes. */
export const artifactUrl = (runId: string, path: string) =>
  `/api/runs/${encodeURIComponent(runId)}/artifacts/${path.replaceAll("\\", "/")}`;

export const videoUrl = (runId: string) => `/api/runs/${encodeURIComponent(runId)}/video`;

export const api = {
  health: () => request<Health>("/api/health"),
  catalog: () => request<CatalogEntry[]>("/api/catalog"),

  runs: async () => {
    const body = await request<{ in_flight: LiveRun[]; runs: Record<string, unknown>[] }>(
      "/api/runs",
    );
    return { inFlight: body.in_flight, runs: body.runs.map(normaliseSummary) };
  },

  run: async (runId: string): Promise<RunResponse> => {
    const body = await request<Record<string, unknown>>(`/api/runs/${encodeURIComponent(runId)}`);
    if ("pending" in body) return body as unknown as RunResponse;
    return {
      ...(normaliseSummary(body) as RunDetail),
      meta: parse(body.meta, {}),
      config_fingerprint: (body.config_fingerprint as string) ?? null,
      counts: body.counts as SkuCountRow[],
      reviews: (body.reviews as Record<string, unknown>[]).map(normaliseReview),
      live: (body.live as LiveRun) ?? null,
    };
  },

  inspector: (runId: string) => request<InspectorDoc>(artifactUrl(runId, "inspector.json")),

  startFromPath: (path: string) =>
    request<{ run_id: string }>("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    }),

  /**
   * XHR rather than fetch: fetch still cannot report upload progress, and a
   * multi-hundred-megabyte aisle walk with no progress bar looks like a hang.
   */
  upload: (file: File, onProgress: (fraction: number) => void, signal?: AbortSignal) =>
    new Promise<{ run_id: string }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const form = new FormData();
      form.append("file", file);
      xhr.open("POST", "/api/runs/upload");
      xhr.responseType = "json";
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
        else reject(new ApiError(xhr.status, xhr.response?.detail ?? "Upload failed"));
      };
      xhr.onerror = () => reject(new ApiError(0, "Network error during upload"));
      xhr.onabort = () => reject(new ApiError(0, "Upload cancelled"));
      signal?.addEventListener("abort", () => xhr.abort());
      xhr.send(form);
    }),

  resolveReview: (
    reviewId: string,
    decision: {
      /** "pending" reopens a decided review (undo). */
      status: ReviewStatus;
      resolved_sku?: string | null;
      resolved_count?: number | null;
    },
  ) =>
    request<{ review_id: string }>(`/api/reviews/${encodeURIComponent(reviewId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewer: "dashboard", ...decision }),
    }),
};
