/**
 * Where recordings wait until they are uploaded (web preview).
 *
 * A browser recording is a Blob in memory; IndexedDB keeps it across a
 * reload, which is what makes the offline queue real in the preview too.
 */
import type { StoredRecording } from './recordings';

export type { StoredRecording };

const DB = 'countbone-recordings';
const STORE = 'blobs';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function keepRecording(source: string | Blob, id: string): Promise<StoredRecording> {
  const blob = typeof source === 'string' ? await (await fetch(source)).blob() : source;
  await tx('readwrite', (s) => s.put(blob, id));
  const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
  return { ref: id, size: blob.size, name: `${id}.${ext}`, mime: blob.type || 'video/webm' };
}

export async function readChunk(ref: string, offset: number, length: number): Promise<Uint8Array> {
  const blob = await tx<Blob | undefined>('readonly', (s) => s.get(ref) as IDBRequest<Blob | undefined>);
  if (!blob) throw new Error('the recording is no longer on this device');
  return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
}

export async function forgetRecording(ref: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(ref));
}

export async function recordingExists(ref: string): Promise<boolean> {
  return !!(await tx<Blob | undefined>('readonly', (s) => s.get(ref) as IDBRequest<Blob | undefined>));
}
