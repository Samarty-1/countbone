/**
 * The HTTP surface, typed. Shapes mirror countbone/api/*.py and store/*.py.
 *
 * The store returns some columns as JSON text (review bbox/meta, run meta in
 * listings); they are parsed here, once, so no component ever sees a string
 * where it expects an object.
 *
 * Every request carries the X-Countbone header: the session is an HttpOnly
 * cookie, and the server only accepts cookie-authenticated writes that carry
 * a header another site could not add (CSRF protection).
 */

export type Phase = "frames" | "count" | "output" | "done" | "failed";
export type LiveStatus = "queued" | "running" | "done" | "failed";
export type Role = "counter" | "manager" | "admin";
export type RunKind = "count" | "receive" | "recount";

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
  kind?: RunKind;
  location?: string | null;
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
  location: string | null;
  kind: RunKind;
  created_by: string | null;
  walk_id: string | null;
  receipt_id: string | null;
  task_id: string | null;
  job_id: string | null;
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
  track_id?: number | null;
  track_sku?: string | null;
  counted?: boolean;
  sighting_sku?: string;
  candidates?: { sku: string; score: number }[];
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

export interface FinalRow {
  sku: string;
  label: string;
  machine: number;
  final: number;
  expected: number | null;
  variance: number | null;
  confidence: number | null;
  changes: string[];
  pending_reviews: number;
}

export interface FinalCounts {
  rows: FinalRow[];
  total: number;
  machine_total: number;
  settled: boolean;
  open_reviews: number;
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
  sampling?: { emitted: number; backfilled: number; retries: number; min_step: number; base_step: number; adaptive: boolean };
  continuity?: { gaps: number; max_shift_objects: number; risky_gaps: number; broken_gaps: number; unknown_gaps: number; score: number };
  shelf?: { gaps: number; missing_facings: number; compliance: number | null };
  contact_sheet?: { objects: number };
  labels_seen?: string[];
  identifier?: string;
  context?: Record<string, unknown>;
}

export interface AuditRow {
  id: number;
  run_id: string;
  kind: string;
  payload: Record<string, unknown> | null;
  created_at: number;
  actor: string | null;
  row_hash: string | null;
}

export interface RunDetail extends RunSummary {
  config_fingerprint: string | null;
  meta: RunMeta;
  counts: SkuCountRow[];
  reviews: Review[];
  live: LiveRun | null;
  final: FinalCounts;
  audit: AuditRow[];
  created_by_name: string | null;
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
  barcodes: string[];
  source: "config" | "studio";
  enrolled: boolean;
}

export interface Health {
  status: string;
  version: string;
  detect: string;
  identify: string;
  count: string;
  unknown_sku: string;
  auth: boolean;
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
  /** This frame's guess. */
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

export interface ShelfGap {
  row: number;
  x1: number;
  x2: number;
  y: number;
  h: number;
  missing_facings: number;
  between: [string | null, string | null];
  at_row_end: boolean;
  photo?: string;
}

export interface ShelfReport {
  rows: number;
  objects: number;
  gaps: ShelfGap[];
  missing_facings: number;
  planogram?: {
    planned_facings: number;
    matching: number;
    compliance: number | null;
    issues: { row: number; position: number | null; kind: string; expected: string | null; found: string | null }[];
  };
}

// -- accounts ---------------------------------------------------------------------
export interface Principal {
  user_id: string;
  username: string;
  display_name: string;
  role: Role;
  via: string;
}

export interface AuthStatus {
  auth_enabled: boolean;
  setup_needed: boolean;
  organisation: string | null;
  user: Principal | null;
}

export interface User {
  user_id: string;
  username: string;
  display_name: string;
  role: Role;
  disabled: number;
  created_at: number;
  last_login_at: number | null;
}

export interface ApiKey {
  key_id: string;
  name: string;
  role: Role;
  created_at: number;
  last_used_at: number | null;
  revoked: number;
  key?: string;
}

// -- operations ----------------------------------------------------------------------
export interface Location {
  code: string;
  name: string | null;
  site_id: string | null;
  zone: string | null;
  created_at: number;
  archived: number;
  skus_expected?: number;
  last_counted_at?: number | null;
  last_run_id?: string | null;
}

export interface ExpectedRow {
  location: string;
  sku: string;
  qty: number;
  source: string;
  updated_at: number;
}

export interface Task {
  task_id: string;
  kind: string;
  status: "open" | "done" | "escalated" | "cancelled";
  location: string | null;
  sku: string | null;
  run_id: string | null;
  reason: string | null;
  expected: number | null;
  counted: number | null;
  variance: number | null;
  value_at_risk: number | null;
  assignee: string | null;
  assignee_name: string | null;
  due_at: number | null;
  result: { recount?: number; by?: string; note?: string; run_id?: string; method?: string } | null;
  created_at: number;
  closed_at: number | null;
}

export type AdjustmentStatus = "blocked" | "proposed" | "approved" | "rejected" | "posted" | "failed" | "superseded";

export interface Adjustment {
  adjustment_id: string;
  location: string | null;
  sku: string;
  system_qty: number | null;
  counted_qty: number;
  delta: number;
  unit_value: number;
  value: number;
  run_id: string | null;
  task_id: string | null;
  status: AdjustmentStatus;
  rule: "auto" | "manager" | "admin" | null;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: number | null;
  note: string | null;
  integration: string | null;
  external_ref: string | null;
  post_error: string | null;
  posted_at: number | null;
  created_at: number;
}

export interface ReconcileRules {
  auto_approve_max_value: number;
  auto_approve_max_units: number;
  manager_max_value: number;
  recount_policy: "all" | "above_auto" | "none";
  recount_due_hours: number;
  post_to: string | null;
  auto_post: boolean;
  /** A recount is done by someone other than the first counter. */
  independent_recount: boolean;
  /** Nobody approves an adjustment they counted or recounted. */
  four_eyes: boolean;
}

export interface ReceiptLine {
  receipt_id: string;
  sku: string;
  expected_qty: number;
  received_qty: number | null;
  unit_cost: number;
}

export interface Discrepancy {
  sku: string;
  ordered: number;
  received: number;
  difference: number;
  unit_cost: number;
  value: number;
}

export interface Receipt {
  receipt_id: string;
  po_number: string;
  supplier: string | null;
  dock: string | null;
  status: "open" | "counted" | "discrepancy" | "closed";
  source: string | null;
  note: string | null;
  created_at: number;
  closed_at: number | null;
  expected_units?: number;
  received_units?: number | null;
  lines?: ReceiptLine[];
  runs?: string[];
  discrepancies?: Discrepancy[];
  claims?: Claim[];
  audit?: AuditRow[];
}

export type ClaimStatus = "draft" | "sent" | "accepted" | "rejected" | "recovered";

export interface Claim {
  claim_id: string;
  kind: string;
  counterparty: string | null;
  status: ClaimStatus;
  receipt_id: string | null;
  run_ids: string[];
  amount: number;
  recovered_amount: number;
  currency: string;
  note: string | null;
  pack_path: string | null;
  pack_sha256: string | null;
  created_at: number;
  receipt?: Receipt | null;
  discrepancies?: Discrepancy[];
  audit?: AuditRow[];
}

export interface VerifyResult {
  ok: boolean;
  signature_ok?: boolean;
  trusted_key?: boolean | null;
  key_id?: string;
  claim_id?: string;
  files_checked?: number;
  problems: string[];
}

export interface Walk {
  walk_id: string;
  location: string | null;
  name: string | null;
  status: "open" | "closed";
  created_at: number;
  runs?: number | string[];
  counts?: Record<string, number>;
  total?: number;
  naive_total?: number;
  duplicates_removed?: number;
  needs_review?: boolean;
  alignments?: { run_id: string; status: string; matched?: number; duplicates?: number; detail?: string }[];
}

export interface StudioSku {
  sku: string;
  label: string;
  unit_value: number;
  hue: [number, number] | null;
  barcodes: string[];
  source: "config" | "studio";
  photos: number;
  archived: boolean;
}

export interface StudioPhoto {
  photo_id: string;
  sku: string;
  source: "upload" | "review";
  run_id: string | null;
  review_id: string | null;
  created_at: number;
}

export interface ProductQuality {
  photos: number;
  self_recognition: number | null;
  confused_with: Record<string, number>;
  nearest: string | null;
  nearest_similarity: number | null;
  accept_threshold: number;
  status: "ready" | "needs photos" | "confusable";
  /** Shares its colour with an unphotographed product and has too few photos to trust its own bar. */
  more_photos_advised: boolean;
  photos_advised: number;
}

export interface StudioQuality {
  products: Record<string, ProductQuality>;
  calibration: Record<string, unknown>;
  /** Colour-only products a photographed look-alike shadows (they go to review until photographed). */
  colour_conflicts: { sku: string; label: string; shares_colour_with: string[] }[];
  enrolled: number;
}

export interface IdentifyResult {
  matches: { sku: string; label: string; score: number }[];
  decision: string | null;
  confidence: number;
  accept: number;
}

export interface Site {
  site_id: string;
  name: string;
  customer: string | null;
  address: string | null;
  timezone: string | null;
}

export interface ServiceJob {
  job_id: string;
  site_id: string | null;
  site_name: string | null;
  customer: string | null;
  title: string;
  scheduled_for: number | null;
  crew: string[];
  locations: string[];
  status: "planned" | "in_progress" | "done" | "cancelled";
  data_consent: number;
  notes: string | null;
  run_count?: number;
  runs?: string[];
}

export interface IntegrationKind {
  kind: string;
  label: string;
  can_pull_expected: boolean;
  can_push_adjustments: boolean;
  can_pull_purchase_orders: boolean;
  settings_fields: { key: string; label: string; required?: string }[];
  secret_fields: { key: string; label: string; required?: string }[];
}

export interface Integration {
  name: string;
  kind: string;
  settings: Record<string, unknown>;
  enabled: number;
  has_secrets: boolean;
  updated_at: number;
  last_sync_at: number | null;
  last_error: string | null;
}

export interface Settings {
  organisation: string | null;
  schema_version: number;
  evidence_key_id: string;
  modules: Modules;
}

/** Product modules a site can switch off; the server refuses what is off. */
export interface Modules {
  receive: boolean;
}

// -- transport ---------------------------------------------------------------------------
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Fired when the server says the session is gone, so the shell can show sign-in. */
export const AUTH_LOST = "countbone:auth-lost";

const BASE_HEADERS = { "X-Countbone": "1" };

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...BASE_HEADERS, ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      message = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* not JSON: keep the status text */
    }
    if (res.status === 401 && !path.startsWith("/api/auth/")) window.dispatchEvent(new Event(AUTH_LOST));
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const form = (fields: Record<string, string | Blob | Blob[] | null | undefined>): RequestInit => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v == null) continue;
    if (Array.isArray(v)) v.forEach((b) => fd.append(k, b));
    else fd.append(k, v);
  }
  return { method: "POST", body: fd };
};

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
  return { ...(raw as unknown as RunSummary), needs_review: Boolean(raw.needs_review), kind: (raw.kind as RunKind) ?? "count" };
}

export const isPending = (r: RunResponse): r is { run_id: string; pending: LiveRun } => "pending" in r;

/** Artifacts are stored with OS separators; URLs want forward slashes. */
export const artifactUrl = (runId: string, path: string) =>
  `/api/runs/${encodeURIComponent(runId)}/artifacts/${path.replaceAll("\\", "/")}`;

export const videoUrl = (runId: string) => `/api/runs/${encodeURIComponent(runId)}/video`;
export const photoUrl = (photoId: string) => `/api/studio/photos/${encodeURIComponent(photoId)}.jpg`;
export const labelUrl = (code: string) => `/api/labels/${encodeURIComponent(code)}.svg`;
export const labelSheetUrl = (codes?: string[]) =>
  `/api/labels-sheet${codes?.length ? `?codes=${codes.map(encodeURIComponent).join(",")}` : ""}`;
export const packUrl = (claimId: string) => `/api/claims/${encodeURIComponent(claimId)}/pack.zip`;

const q = (params: Record<string, string | number | boolean | null | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : "";
};

export interface UploadOptions {
  location?: string | null;
  kind?: RunKind;
  receipt_id?: string | null;
  task_id?: string | null;
  walk_id?: string | null;
  job_id?: string | null;
}

export const api = {
  // accounts
  authStatus: () => request<AuthStatus>("/api/auth/status"),
  login: (username: string, password: string) =>
    request<{ user: User }>("/api/auth/login", json("POST", { username, password, client: "dashboard" })),
  setup: (body: { setup_code: string; username: string; password: string; display_name?: string; organisation?: string }) =>
    request<{ user: User }>("/api/auth/setup", json("POST", body)),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", json("POST")),
  changePassword: (current_password: string, new_password: string) =>
    request<{ ok: boolean }>("/api/auth/password", json("POST", { current_password, new_password })),

  health: () => request<Health>("/api/health"),
  catalog: () => request<CatalogEntry[]>("/api/catalog"),

  runs: async (filters: { location?: string; kind?: string; limit?: number } = {}) => {
    const body = await request<{ in_flight: LiveRun[]; runs: Record<string, unknown>[] }>(`/api/runs${q(filters)}`);
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
      final: body.final as FinalCounts,
      audit: (body.audit as AuditRow[]) ?? [],
      created_by_name: (body.created_by_name as string) ?? null,
    };
  },

  inspector: (runId: string) => request<InspectorDoc>(artifactUrl(runId, "inspector.json")),
  shelf: (runId: string) => request<ShelfReport>(artifactUrl(runId, "shelf.json")),

  startFromPath: (path: string, location?: string | null) =>
    request<{ run_id: string }>("/api/runs", json("POST", { path, location: location || undefined })),

  /**
   * XHR rather than fetch: fetch still cannot report upload progress, and a
   * multi-hundred-megabyte aisle walk with no progress bar looks like a hang.
   */
  upload: (file: File, onProgress: (fraction: number) => void, signal?: AbortSignal, opts: UploadOptions = {}) =>
    new Promise<{ run_id: string }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const fd = new FormData();
      fd.append("file", file);
      for (const [k, v] of Object.entries(opts)) if (v) fd.append(k, String(v));
      xhr.open("POST", "/api/runs/upload");
      xhr.withCredentials = true;
      xhr.setRequestHeader("X-Countbone", "1");
      xhr.responseType = "json";
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
        else {
          if (xhr.status === 401) window.dispatchEvent(new Event(AUTH_LOST));
          reject(new ApiError(xhr.status, xhr.response?.detail ?? "Upload failed"));
        }
      };
      xhr.onerror = () => reject(new ApiError(0, "Network error during upload"));
      xhr.onabort = () => reject(new ApiError(0, "Upload cancelled"));
      signal?.addEventListener("abort", () => xhr.abort());
      xhr.send(fd);
    }),

  resolveReview: (
    reviewId: string,
    decision: {
      /** "pending" reopens a decided review (undo). */
      status: ReviewStatus;
      resolved_sku?: string | null;
      resolved_count?: number | null;
    },
  ) => request<{ review_id: string; learned_photo: string | null }>(`/api/reviews/${encodeURIComponent(reviewId)}`, json("POST", decision)),

  // walks
  walks: (location?: string) => request<Walk[]>(`/api/walks${q({ location })}`),
  walk: (id: string) => request<Walk>(`/api/walks/${encodeURIComponent(id)}`),
  createWalk: (location: string | null, name?: string) => request<Walk>("/api/walks", json("POST", { location, name })),
  closeWalk: (id: string) => request<Walk>(`/api/walks/${encodeURIComponent(id)}/close`, json("POST")),

  // locations
  locations: () => request<Location[]>("/api/locations"),
  location: (code: string) =>
    request<Location & { expected: ExpectedRow[]; planogram: string[][] | null; runs: Record<string, unknown>[]; walks: Walk[]; tasks: Task[]; adjustments: Adjustment[] }>(
      `/api/locations/${encodeURIComponent(code)}/detail`,
    ).then((l) => ({ ...l, runs: l.runs.map(normaliseSummary) })),
  saveLocation: (body: { code: string; name?: string | null; zone?: string | null; site_id?: string | null }) =>
    request<Location>("/api/locations", json("POST", body)),
  archiveLocation: (code: string) => request<{ ok: boolean }>(`/api/locations/${encodeURIComponent(code)}`, json("DELETE")),
  importLocations: (file: File) =>
    request<{ locations: number; book_stock_rows?: number }>("/api/locations/bulk", form({ file })),
  setExpected: (code: string, quantities: Record<string, number>, replace = true) =>
    request<ExpectedRow[]>(`/api/locations/${encodeURIComponent(code)}/expected`, json("PUT", { quantities, replace })),
  setPlanogram: (code: string, rows: string[][]) =>
    request<{ rows: string[][] }>(`/api/locations/${encodeURIComponent(code)}/planogram`, json("PUT", { rows })),

  // tasks
  tasks: (filters: { status?: string; mine?: boolean; location?: string } = {}) => request<Task[]>(`/api/tasks${q(filters)}`),
  assignTask: (id: string, assignee: string | null, due_at?: number | null) =>
    request<Task>(`/api/tasks/${encodeURIComponent(id)}/assign`, json("POST", { assignee, due_at })),
  completeTask: (id: string, count: number, note?: string) =>
    request<Task>(`/api/tasks/${encodeURIComponent(id)}/complete`, json("POST", { count, note })),
  cancelTask: (id: string, note: string) => request<Task>(`/api/tasks/${encodeURIComponent(id)}/cancel`, json("POST", { note })),

  // reconcile
  adjustments: (filters: { status?: string; location?: string } = {}) => request<Adjustment[]>(`/api/adjustments${q(filters)}`),
  adjustmentSummary: () =>
    request<{ by_status: Record<string, { count: number; value: number }>; rules: ReconcileRules }>("/api/adjustments/summary"),
  approve: (id: string, note?: string) => request<Adjustment>(`/api/adjustments/${encodeURIComponent(id)}/approve`, json("POST", { note })),
  approveMany: (ids: string[]) =>
    request<{ approved: string[]; errors: Record<string, string> }>("/api/adjustments/approve", json("POST", { adjustment_ids: ids })),
  reject: (id: string, note: string) => request<Adjustment>(`/api/adjustments/${encodeURIComponent(id)}/reject`, json("POST", { note })),
  post: (ids: string[] | null, integration?: string | null) =>
    request<{ posted: number; failed: number }>("/api/adjustments/post", json("POST", { adjustment_ids: ids, integration })),
  markExported: (ids: string[], reference: string) =>
    request<{ marked: number }>("/api/adjustments/mark-exported", json("POST", { adjustment_ids: ids, reference })),
  rules: () => request<ReconcileRules>("/api/reconcile/rules"),
  saveRules: (patch: Partial<ReconcileRules>) => request<ReconcileRules>("/api/reconcile/rules", json("PUT", patch)),
  report: (since?: number, until?: number) =>
    request<{ by_status: Record<string, { count: number; units: number; value: number }>; net_value_posted: number; gross_value_posted: number; open: number; adjustments: Adjustment[] }>(
      `/api/reconcile/report${q({ since, until })}`,
    ),

  // receive
  receipts: (status?: string) => request<Receipt[]>(`/api/receipts${q({ status })}`),
  receipt: (id: string) => request<Receipt>(`/api/receipts/${encodeURIComponent(id)}`),
  createReceipt: (body: { po_number: string; supplier?: string; dock?: string; lines: Record<string, { qty: number; unit_cost?: number }>; note?: string }) =>
    request<Receipt>("/api/receipts", json("POST", body)),
  importReceipt: (po_number: string, file: File, supplier?: string, dock?: string) =>
    request<Receipt>("/api/receipts/import", form({ po_number, supplier, dock, file })),
  pullReceipt: (integration: string, po_number: string, dock?: string) =>
    request<Receipt>("/api/receipts/pull", json("POST", { integration, po_number, dock })),
  closeReceipt: (id: string, note?: string) => request<Receipt>(`/api/receipts/${encodeURIComponent(id)}/close`, json("POST", { note })),

  // evidence
  claims: (status?: string) => request<Claim[]>(`/api/claims${q({ status })}`),
  claim: (id: string) => request<Claim>(`/api/claims/${encodeURIComponent(id)}`),
  createClaim: (body: { kind: string; run_ids: string[]; receipt_id?: string | null; counterparty?: string; amount?: number; note?: string }) =>
    request<Claim>("/api/claims", json("POST", body)),
  updateClaim: (id: string, patch: Partial<Pick<Claim, "status" | "counterparty" | "amount" | "recovered_amount" | "note">>) =>
    request<Claim>(`/api/claims/${encodeURIComponent(id)}`, json("PATCH", patch)),
  buildPack: (id: string, includeVideo: boolean) =>
    request<{ sha256: string; bytes: number; manifest_sha256: string }>(
      `/api/claims/${encodeURIComponent(id)}/pack${q({ include_video: includeVideo })}`,
      json("POST"),
    ),
  verifyPack: (file: File) => request<VerifyResult>("/api/evidence/verify", form({ file })),
  publicKey: () => request<{ key_id: string; public_key_pem: string }>("/api/evidence/public-key"),
  verifyChain: () =>
    request<{ ok: boolean; checked: number; legacy_rows: number; head?: string; broken_at?: number; problem?: string }>("/api/audit/verify"),
  recentAudit: (limit = 100) => request<AuditRow[]>(`/api/audit/recent${q({ limit })}`),

  // catalog studio
  studioSkus: () => request<StudioSku[]>("/api/studio/skus"),
  saveSku: (body: { sku: string; label?: string; unit_value?: number; hue?: [number, number] | null; barcodes?: string[]; archived?: boolean }) =>
    request<StudioSku>("/api/studio/skus", json("POST", body)),
  importSkus: (file: File) => request<{ imported: number }>("/api/studio/skus/import", form({ file })),
  photos: (sku: string) => request<StudioPhoto[]>(`/api/studio/skus/${encodeURIComponent(sku)}/photos`),
  addPhotos: (sku: string, files: File[]) =>
    request<{ added: string[]; quality: ProductQuality | null }>(`/api/studio/skus/${encodeURIComponent(sku)}/photos`, form({ files })),
  deletePhoto: (id: string) => request<{ ok: boolean }>(`/api/studio/photos/${encodeURIComponent(id)}`, json("DELETE")),
  identify: (file: File) => request<IdentifyResult>("/api/studio/identify", form({ file })),
  quality: () => request<StudioQuality>("/api/studio/quality"),

  // service
  sites: () => request<Site[]>("/api/sites"),
  createSite: (body: { name: string; customer?: string; address?: string; timezone?: string }) => request<Site>("/api/sites", json("POST", body)),
  serviceJobs: (filters: { status?: string; mine?: boolean } = {}) => request<ServiceJob[]>(`/api/service-jobs${q(filters)}`),
  createServiceJob: (body: { site_id?: string | null; title: string; scheduled_for?: number | null; crew: string[]; locations: string[]; data_consent: boolean; notes?: string }) =>
    request<ServiceJob>("/api/service-jobs", json("POST", body)),
  updateServiceJob: (id: string, patch: Partial<Pick<ServiceJob, "status" | "title" | "notes" | "crew" | "locations">> & { data_consent?: boolean }) =>
    request<ServiceJob>(`/api/service-jobs/${encodeURIComponent(id)}`, json("PATCH", patch)),

  // admin
  users: () => request<User[]>("/api/users"),
  createUser: (body: { username: string; password: string; role: Role; display_name?: string }) => request<User>("/api/users", json("POST", body)),
  updateUser: (id: string, patch: { role?: Role; display_name?: string; disabled?: boolean; password?: string }) =>
    request<User>(`/api/users/${encodeURIComponent(id)}`, json("PATCH", patch)),
  apiKeys: () => request<ApiKey[]>("/api/api-keys"),
  createApiKey: (name: string, role: Role) => request<ApiKey>("/api/api-keys", json("POST", { name, role })),
  revokeApiKey: (id: string) => request<{ ok: boolean }>(`/api/api-keys/${encodeURIComponent(id)}`, json("DELETE")),
  integrationKinds: () => request<IntegrationKind[]>("/api/integrations/kinds"),
  integrations: () => request<Integration[]>("/api/integrations"),
  saveIntegration: (body: { name: string; kind: string; settings: Record<string, unknown>; secrets?: Record<string, string> | null; enabled: boolean }) =>
    request<Integration>("/api/integrations", json("PUT", body)),
  testIntegration: (name: string) => request<{ ok: boolean; detail: string }>(`/api/integrations/${encodeURIComponent(name)}/test`, json("POST")),
  pullExpected: (name: string, locations?: string[]) =>
    request<{ locations: number; rows: number }>(`/api/integrations/${encodeURIComponent(name)}/pull-expected`, json("POST", { locations })),
  deleteIntegration: (name: string) => request<{ ok: boolean }>(`/api/integrations/${encodeURIComponent(name)}`, json("DELETE")),
  settings: () => request<Settings>("/api/settings"),
  saveSettings: (body: { organisation?: string; modules?: Partial<Modules> }) => request<Settings>("/api/settings", json("PUT", body)),
};
