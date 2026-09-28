/**
 * Where recordings wait until they are uploaded (native).
 *
 * The camera writes into a temporary folder the OS may clear whenever it
 * likes; a recording waiting for signal in a warehouse dead zone must
 * survive that, and an app restart. So each one is moved into the app's
 * documents folder, and read back in chunks for the resumable upload (a
 * 1 GB walk is never loaded into memory at once).
 */
import { Directory, File, Paths } from 'expo-file-system';

export interface StoredRecording {
  /** file:// URI (native) or recording id (web). */
  ref: string;
  size: number;
  name: string;
  mime: string;
}

const dir = () => new Directory(Paths.document, 'recordings');

/** Take ownership of a recording the camera just wrote. */
export async function keepRecording(source: string | Blob, id: string): Promise<StoredRecording> {
  if (typeof source !== 'string') throw new Error('native recordings are files');
  const folder = dir();
  if (!folder.exists) folder.create({ idempotent: true, intermediates: true });
  const src = new File(source.startsWith('file://') ? source : `file://${source}`);
  const ext = (src.uri.split('.').pop() || 'mp4').toLowerCase();
  const dest = new File(folder, `${id}.${ext}`);
  await src.move(dest);
  return { ref: dest.uri, size: dest.size, name: `${id}.${ext}`, mime: ext === 'mov' ? 'video/quicktime' : 'video/mp4' };
}

/** One chunk of a stored recording. */
export async function readChunk(ref: string, offset: number, length: number): Promise<Uint8Array> {
  const handle = new File(ref).open();
  try {
    handle.offset = offset;
    return handle.readBytes(length);
  } finally {
    handle.close();
  }
}

export async function forgetRecording(ref: string): Promise<void> {
  const f = new File(ref);
  if (f.exists) f.delete();
}

export async function recordingExists(ref: string): Promise<boolean> {
  return new File(ref).exists;
}
