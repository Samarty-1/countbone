/**
 * The countbone API, from the phone.
 *
 * The phone signs in once and keeps a Bearer token (the dashboard uses an
 * HttpOnly cookie instead; the server accepts both). Server URL and token
 * live in AsyncStorage, so the app reopens signed in and aimed at the right
 * server. Shapes mirror the server (countbone/api/*.py).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

export type Role = 'counter' | 'manager' | 'admin';
export type RunKind = 'count' | 'receive' | 'recount';

export interface Principal {
  user_id: string;
  username: string;
  display_name: string;
  role: Role;
}

export interface Location {
  code: string;
  name: string | null;
  zone: string | null;
  last_counted_at?: number | null;
  skus_expected?: number;
}

export interface Receipt {
  receipt_id: string;
  po_number: string;
  supplier: string | null;
  dock: string | null;
  status: 'open' | 'counted' | 'discrepancy' | 'closed';
  expected_units?: number;
  received_units?: number | null;
}

export interface Task {
  task_id: string;
  status: 'open' | 'done' | 'escalated' | 'cancelled';
  location: string | null;
  sku: string | null;
  reason: string | null;
  expected: number | null;
  counted: number | null;
  variance: number | null;
  value_at_risk: number | null;
  assignee_name: string | null;
  due_at: number | null;
  run_id: string | null;
}

export interface Walk {
  walk_id: string;
  location: string | null;
  name: string | null;
  status: 'open' | 'closed';
}

export interface ServiceJob {
  job_id: string;
  title: string;
  site_name: string | null;
  status: 'planned' | 'in_progress' | 'done' | 'cancelled';
  locations: string[];
  scheduled_for: number | null;
}

export interface CatalogEntry {
  sku: string;
  label: string;
  swatch: string | null;
  unit_value: number;
}

export interface FinalRow {
  sku: string;
  label: string;
  machine: number;
  final: number;
  expected: number | null;
  variance: number | null;
  confidence: number | null;
  pending_reviews: number;
}

export interface Review {
  review_id: string;
  run_id: string;
  sku: string;
  reason: string;
  confidence: number;
  crop_path: string | null;
  status: 'pending' | 'accepted' | 'rejected' | 'corrected';
  resolved_sku: string | null;
  meta: {
    scope?: 'sku' | 'item';
    count?: number;
    counted?: boolean;
    track_sku?: string | null;
    candidates?: { sku: string; score: number }[];
  };
}

export interface LiveRun {
  run_id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  error: string | null;
  phase?: string;
  telemetry?: { frames_read: number; frames_expected: number | null; tracks: number; detections: number };
  location?: string | null;
}

export interface RunDetail {
  run_id: string;
  started_at: number;
  total: number;
  overall_confidence: number;
  needs_review: boolean;
  location: string | null;
  kind: RunKind;
  receipt_id: string | null;
  task_id: string | null;
  meta: {
    warnings?: string[];
    continuity?: { score: number; broken_gaps: number };
    shelf?: { gaps: number; missing_facings: number; compliance: number | null };
    labels_seen?: string[];
  };
  reviews: Review[];
  final: { rows: FinalRow[]; total: number; machine_total: number; settled: boolean; open_reviews: number };
}

export type RunResponse = RunDetail | { run_id: string; pending: LiveRun };
export const isPending = (r: RunResponse): r is { run_id: string; pending: LiveRun } => 'pending' in r;

export interface RunSummary {
  run_id: string;
  started_at: number;
  total: number;
  location: string | null;
  kind: RunKind;
  needs_review: number | boolean;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// -- connection state ---------------------------------------------------------------
const KEY_SERVER = 'countbone.server';
const KEY_TOKEN = 'countbone.token';

/** The web preview is served next to the API in development; a phone is not. */
export function defaultServer(): string {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:8000`;
  }
  return 'http://192.168.1.10:8000';
}

let server = defaultServer();
let token: string | null = null;
const listeners = new Set<() => void>();

export async function hydrate(): Promise<{ server: string; token: string | null }> {
  const [s, t] = await Promise.all([AsyncStorage.getItem(KEY_SERVER), AsyncStorage.getItem(KEY_TOKEN)]);
  server = s || server;
  token = t;
  return { server, token };
}

export const getServer = () => server;
export const hasToken = () => !!token;

export async function setServer(url: string) {
  server = url.trim().replace(/\/+$/, '');
  await AsyncStorage.setItem(KEY_SERVER, server);
}

async function setToken(t: string | null) {
  token = t;
  if (t) await AsyncStorage.setItem(KEY_TOKEN, t);
  else await AsyncStorage.removeItem(KEY_TOKEN);
  listeners.forEach((l) => l());
}

/** Called when the server rejects the token: the app returns to sign-in. */
export function onSignedOut(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export const authHeaders = (): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {});

/** A URL for an image the server serves behind auth (RN Image sends headers). */
export const authedSource = (path: string) => ({ uri: `${server}${path}`, headers: authHeaders() });

export async function request<T>(path: string, init: RequestInit = {}, timeoutMs = 15000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${server}${path}`, {
      ...init,
      signal: init.signal ?? ctrl.signal,
      headers: { ...authHeaders(), ...(init.headers as Record<string, string> | undefined) },
    });
  } catch {
    throw new ApiError(0, ctrl.signal.aborted ? 'The server did not answer in time' : 'Cannot reach the server');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let message = res.statusText || `HTTP ${res.status}`;
    try {
      const body = await res.json();
      message = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* keep the status text */
    }
    if (res.status === 401 && token && !path.startsWith('/api/auth/login')) await setToken(null);
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const qs = (params: Record<string, string | number | boolean | null | undefined>) => {
  const parts = Object.entries(params)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
};

export const api = {
  async login(username: string, password: string): Promise<Principal> {
    const res = await request<{ token: string; user: Principal }>(
      '/api/auth/login',
      json('POST', { username, password, client: `countbone-${Platform.OS}` }),
    );
    await setToken(res.token);
    return res.user;
  },
  async logout() {
    await request('/api/auth/logout', json('POST')).catch(() => undefined);
    await setToken(null);
  },
  me: () => request<Principal>('/api/auth/me'),
  health: () => request<{ status: string; version: string; identify: string }>('/api/health', {}, 5000),

  locations: () => request<Location[]>('/api/locations'),
  /** Site settings; `modules` says which product areas are switched on. */
  settings: () => request<{ organisation: string | null; modules: { receive: boolean } }>('/api/settings'),
  receipts: () => request<Receipt[]>('/api/receipts'),
  tasks: (mine = true) => request<Task[]>(`/api/tasks${qs({ status: 'open', mine })}`),
  completeTask: (id: string, count: number, note?: string) =>
    request<Task>(`/api/tasks/${encodeURIComponent(id)}/complete`, json('POST', { count, note })),
  walks: () => request<Walk[]>('/api/walks'),
  createWalk: (location: string | null) => request<Walk>('/api/walks', json('POST', { location })),
  serviceJobs: () => request<ServiceJob[]>(`/api/service-jobs${qs({ mine: true })}`),
  catalog: () => request<CatalogEntry[]>('/api/catalog'),

  runs: (limit = 30) => request<{ runs: RunSummary[]; in_flight: LiveRun[] }>(`/api/runs${qs({ limit })}`),
  run: (id: string) => request<RunResponse>(`/api/runs/${encodeURIComponent(id)}`),
  resolveReview: (id: string, decision: { status: Review['status']; resolved_sku?: string | null; resolved_count?: number | null }) =>
    request<{ review_id: string }>(`/api/reviews/${encodeURIComponent(id)}`, json('POST', decision)),

  // resumable uploads (the offline queue)
  startUpload: (body: {
    filename: string;
    size: number;
    client_id: string;
    kind: RunKind;
    location?: string | null;
    receipt_id?: string | null;
    task_id?: string | null;
    walk_id?: string | null;
    job_id?: string | null;
  }) => request<{ upload_id: string; offset: number; size: number; status: string; run_id: string | null }>('/api/uploads', json('POST', body)),
  uploadStatus: (id: string) => request<{ offset: number; status: string; run_id: string | null }>(`/api/uploads/${encodeURIComponent(id)}`),
  async putChunk(id: string, offset: number, bytes: Uint8Array): Promise<number> {
    const res = await fetch(`${server}/api/uploads/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { ...authHeaders(), 'Upload-Offset': String(offset), 'Content-Type': 'application/octet-stream' },
      body: bytes as unknown as BodyInit,
    });
    const next = Number(res.headers.get('Upload-Offset'));
    if (res.status === 204 || res.status === 409) {
      // 409: the server has a different offset; resume from where it says.
      if (Number.isFinite(next)) return next;
    }
    if (res.status === 401) await setToken(null);
    throw new ApiError(res.status, `upload chunk failed (HTTP ${res.status})`);
  },
  completeUpload: (id: string, sha256?: string) =>
    request<{ run_id: string }>(`/api/uploads/${encodeURIComponent(id)}/complete`, json('POST', sha256 ? { sha256 } : undefined), 60000),
};
