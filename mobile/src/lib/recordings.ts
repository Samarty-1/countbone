/**
 * Recordings that have not reached the server yet.
 *
 * A take is registered here the moment recording stops, and removed only
 * once the server has accepted it, so a dropped upload never loses footage.
 * Native takes are files and survive a restart (their metadata is persisted);
 * web takes are in-memory blobs and last as long as the tab.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import type { UploadMedia } from './api.ts';

export interface Recording {
  id: string;
  media: UploadMedia;
  createdAt: number;
  durationS: number | null;
  sizeBytes: number | null;
  /** Where the take came from, for the history list. */
  origin: 'camera' | 'replay';
}

const KEY = 'countbone.recordings.v1';
const store = new Map<string, Recording>();
const listeners = new Set<() => void>();
let hydrated: Promise<void> | null = null;
/** Stable between changes, as useSyncExternalStore requires. */
let snapshot: Recording[] = [];

function emit(): void {
  snapshot = [...store.values()].sort((a, b) => b.createdAt - a.createdAt);
  for (const l of listeners) l();
}

/** Only file-backed takes can outlive the process. */
async function persist(): Promise<void> {
  const files = [...store.values()].filter((r) => r.media.kind === 'file');
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(files));
  } catch (err) {
    console.warn('recordings: could not persist', err);
  }
}

function isRecording(v: unknown): v is Recording {
  if (!v || typeof v !== 'object') return false;
  const r = v as Partial<Recording>;
  return (
    typeof r.id === 'string' &&
    typeof r.createdAt === 'number' &&
    !!r.media &&
    r.media.kind === 'file' &&
    typeof r.media.uri === 'string'
  );
}

export function hydrateRecordings(): Promise<void> {
  hydrated ??= AsyncStorage.getItem(KEY)
    .then((text) => {
      if (!text) return;
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) return;
      for (const r of parsed) if (isRecording(r) && !store.has(r.id)) store.set(r.id, r);
      emit();
    })
    .catch((err: unknown) => console.warn('recordings: could not load', err));
  return hydrated;
}

export function addRecording(rec: Omit<Recording, 'id' | 'createdAt'>): Recording {
  const id = `rec_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const full: Recording = { ...rec, id, createdAt: Date.now() / 1000 };
  store.set(id, full);
  emit();
  void persist();
  return full;
}

export function getRecording(id: string): Recording | undefined {
  return store.get(id);
}

export function removeRecording(id: string): void {
  if (store.delete(id)) {
    emit();
    void persist();
  }
}

export function listRecordings(): Recording[] {
  return snapshot;
}

export function subscribeRecordings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A filename the server will accept (it checks the extension) and keep. */
export function takeName(ext: string, at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `aisle_${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}_${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}.${ext}`;
}
