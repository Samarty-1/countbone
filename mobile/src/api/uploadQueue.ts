/**
 * The offline upload queue.
 *
 * A recording is queued the moment it stops, then sent in 4 MB chunks with
 * the server's resumable upload API. Every chunk's progress is saved, so a
 * dead zone, a closed app, or a reboot costs at most one chunk: the upload
 * resumes where the server says it got to. The recording's own id is the
 * upload's client_id, so a retry can never create a second count of the
 * same walk.
 *
 * States:  waiting -> uploading -> done          (the server has it, counting)
 *                  \-> waiting (retry later)      network trouble, backs off
 *                  \-> failed                      the server refused it: needs a person
 *
 * Each recording belongs to whoever was signed in when it was filmed. On a
 * shared phone, the next person's sign-in must not upload it as theirs: a
 * recording waits for its own filmer to sign in again.
 *
 * The phone hashes the video as it sends it and gives the server the SHA-256
 * at the end, so a file damaged on the way is never counted.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Network from 'expo-network';
import { AppState } from 'react-native';

import { forgetRecording, readChunk, recordingExists, type StoredRecording } from '@/storage/recordings';
import { api, ApiError, hasToken, type RunKind } from './client';

export interface Target {
  kind: RunKind;
  location: string | null;
  receipt_id: string | null;
  task_id: string | null;
  walk_id: string | null;
  job_id: string | null;
  /** How the item is shown in lists: "A07-B03 · cycle count". */
  title: string;
}

export interface QueueItem {
  id: string;
  createdAt: number;
  recording: StoredRecording;
  target: Target;
  durationS: number | null;
  state: 'waiting' | 'uploading' | 'done' | 'failed';
  uploadId: string | null;
  sent: number;
  runId: string | null;
  error: string | null;
  attempts: number;
  nextTryAt: number;
  /** Who filmed it (user_id). Absent on items queued before this was recorded. */
  ownerId?: string | null;
  ownerName?: string | null;
}

const KEY = 'countbone.queue.v1';
const USER_KEY = 'countbone.queue.user';
const CHUNK = 4 * 1024 * 1024;

let items: QueueItem[] = [];
let loaded = false;
let running = false;
/** The signed-in user, remembered so an offline launch still knows whose queue this is. */
let currentUser: { id: string; name: string } | null = null;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((l) => l());

async function save() {
  await AsyncStorage.setItem(KEY, JSON.stringify(items));
  emit();
}

async function load() {
  if (loaded) return;
  loaded = true;
  try {
    items = JSON.parse((await AsyncStorage.getItem(KEY)) ?? '[]');
  } catch {
    items = [];
  }
  try {
    currentUser ??= JSON.parse((await AsyncStorage.getItem(USER_KEY)) ?? 'null');
  } catch {
    currentUser = null;
  }
  // An upload interrupted mid-chunk resumes from the server's offset.
  items = items.map((i) => (i.state === 'uploading' ? { ...i, state: 'waiting' } : i));
  emit();
}

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export const snapshot = () => items;

/** Called by the session on sign-in (the user) and sign-out (null). */
export async function setQueueUser(user: { id: string; name: string } | null) {
  currentUser = user;
  await AsyncStorage.setItem(USER_KEY, JSON.stringify(user)).catch(() => undefined);
  emit();
  if (user) void pump();
}

/** A recording someone else filmed: it waits for them rather than uploading as the current user. */
export const waitsForSomeoneElse = (i: QueueItem) =>
  !!i.ownerId && !!currentUser && i.ownerId !== currentUser.id;

function update(id: string, patch: Partial<QueueItem>) {
  items = items.map((i) => (i.id === id ? { ...i, ...patch } : i));
}

export function newRecordingId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `rec_${Date.now().toString(36)}_${rand}`;
}

export async function enqueue(recording: StoredRecording, target: Target, id: string, durationS: number | null) {
  await load();
  items = [
    { id, createdAt: Date.now(), recording, target, durationS, state: 'waiting', uploadId: null, sent: 0,
      runId: null, error: null, attempts: 0, nextTryAt: 0,
      ownerId: currentUser?.id ?? null, ownerName: currentUser?.name ?? null },
    ...items,
  ];
  await save();
  void pump();
}

export async function retry(id: string) {
  update(id, { state: 'waiting', error: null, nextTryAt: 0, attempts: 0 });
  await save();
  void pump();
}

/** Remove from the queue, deleting the local copy unless the server has it. */
export async function discard(id: string) {
  const item = items.find((i) => i.id === id);
  if (item) await forgetRecording(item.recording.ref).catch(() => undefined);
  items = items.filter((i) => i.id !== id);
  await save();
}

/** Forget finished items older than a week (the server keeps them). */
async function prune() {
  const cutoff = Date.now() - 7 * 86400 * 1000;
  const before = items.length;
  items = items.filter((i) => !(i.state === 'done' && i.createdAt < cutoff));
  if (items.length !== before) await save();
}

function retryable(e: unknown): boolean {
  if (!(e instanceof ApiError)) return true;
  return e.status === 0 || e.status >= 500 || e.status === 408 || e.status === 429 || e.status === 409;
}

async function sendOne(item: QueueItem) {
  if (!(await recordingExists(item.recording.ref))) {
    update(item.id, { state: 'failed', error: 'The recording is no longer on this phone.' });
    return;
  }
  update(item.id, { state: 'uploading', error: null });
  await save();
  let uploadId = item.uploadId;
  let sent = item.sent;
  const t = item.target;
  const started = await api.startUpload({
    filename: item.recording.name,
    size: item.recording.size,
    client_id: item.id,
    kind: t.kind,
    location: t.location,
    receipt_id: t.receipt_id,
    task_id: t.task_id,
    walk_id: t.walk_id,
    job_id: t.job_id,
  });
  uploadId = started.upload_id;
  if (started.status === 'complete' && started.run_id) {
    update(item.id, { state: 'done', uploadId, sent: item.recording.size, runId: started.run_id });
    await forgetRecording(item.recording.ref).catch(() => undefined);
    return;
  }
  sent = started.offset; // the server's word, not ours
  update(item.id, { uploadId, sent });
  // The hash covers every byte in order, so on a resume the part the server
  // already has is read back and hashed first (reading is far cheaper than
  // the network it replaces).
  const hash = sha256.create();
  for (let at = 0; at < sent; ) {
    const bytes = await readChunk(item.recording.ref, at, Math.min(CHUNK, sent - at));
    hash.update(bytes);
    at += bytes.length;
  }
  while (sent < item.recording.size) {
    const bytes = await readChunk(item.recording.ref, sent, Math.min(CHUNK, item.recording.size - sent));
    const next = await api.putChunk(uploadId, sent, bytes);
    if (next === sent + bytes.length) {
      hash.update(bytes);
    } else if (next !== sent) {
      // The server is somewhere else (another attempt got further): the
      // running hash no longer lines up, so start this upload over cleanly.
      throw new ApiError(409, `server is at byte ${next}; resuming from there`);
    }
    sent = next;
    update(item.id, { sent });
    await save();
  }
  const digest = Array.from(hash.digest(), (b) => b.toString(16).padStart(2, '0')).join('');
  const done = await api.completeUpload(uploadId, digest);
  update(item.id, { state: 'done', runId: done.run_id, sent: item.recording.size, attempts: 0 });
  // The server has the video and its hash: the phone's copy is no longer needed.
  await forgetRecording(item.recording.ref).catch(() => undefined);
}

/** Send whatever is due, one recording at a time. Safe to call any time. */
export async function pump() {
  await load();
  if (running || !hasToken()) return;
  running = true;
  try {
    const net = await Network.getNetworkStateAsync().catch(() => ({ isConnected: true }));
    if (net.isConnected === false) return;
    for (;;) {
      const now = Date.now();
      const next = items
        .filter((i) => i.state === 'waiting' && i.nextTryAt <= now && !waitsForSomeoneElse(i))
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!next) break;
      try {
        await sendOne(next);
      } catch (e) {
        const attempts = next.attempts + 1;
        if (retryable(e)) {
          update(next.id, {
            state: 'waiting',
            attempts,
            error: e instanceof Error ? e.message : String(e),
            nextTryAt: Date.now() + Math.min(120_000, 2000 * 2 ** Math.min(attempts, 6)),
          });
        } else {
          update(next.id, { state: 'failed', attempts, error: e instanceof Error ? e.message : String(e) });
        }
      }
      await save();
      if (!hasToken()) break;
    }
    await prune();
  } finally {
    running = false;
  }
}

let started = false;
/** Start the background triggers: network back, app foregrounded, and a timer. */
export function startQueue() {
  if (started) return;
  started = true;
  void pump();
  Network.addNetworkStateListener((s) => {
    if (s.isConnected) void pump();
  });
  AppState.addEventListener('change', (s) => {
    if (s === 'active') void pump();
  });
  setInterval(() => {
    if (items.some((i) => i.state === 'waiting')) void pump();
  }, 15_000);
}
