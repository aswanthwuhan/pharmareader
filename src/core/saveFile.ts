/**
 * Save a generated file (backup zip, notes, card export) where the user can
 * find it.
 *
 * A browser download is an anchor click on a blob: URL. An Android WebView
 * silently drops that click — neither the app nor the Capacitor bridge installs
 * a DownloadListener — so on a phone the file must be written through
 * @capacitor/filesystem instead.
 */
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';

export interface SaveResult {
  /** Where the user will find the file, in words they can act on. */
  location: string;
}

export const SAVE_DIR = 'PharmaReader';
/**
 * A multiple of 3, so every chunk encodes to whole base64 groups with no middle
 * padding and the pieces can simply be appended. 3 MB keeps the transient
 * base64 string down to ~4 MB even for a multi-hundred-megabyte backup.
 */
export const CHUNK_BYTES = 3 * 1024 * 1024;

function safeName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/^\.+/, '');
  return cleaned || 'download';
}

export async function saveFile(blob: Blob, name: string): Promise<SaveResult> {
  const fileName = safeName(name);
  if (!Capacitor.isNativePlatform()) {
    downloadInBrowser(blob, fileName);
    return { location: 'your Downloads folder' };
  }

  const path = `${SAVE_DIR}/${fileName}`;
  await ensureStoragePermission();
  try {
    await writeNative(blob, path);
  } catch (err) {
    const detail = err instanceof Error && err.message ? ` ${err.message}` : '';
    throw new Error(`The file could not be saved to Documents/${SAVE_DIR}.${detail}`);
  }
  return { location: `Documents/${path}` };
}

/** Android 8–9 write to the public Documents folder only with the storage permission. */
async function ensureStoragePermission(): Promise<void> {
  let status: { publicStorage?: string };
  try {
    status = await Filesystem.checkPermissions();
  } catch {
    // A platform without a storage permission model: let the write try.
    return;
  }
  if (status.publicStorage === 'granted') return;
  try {
    status = await Filesystem.requestPermissions();
  } catch {
    return;
  }
  if (status.publicStorage === 'denied') {
    throw new Error(
      'PharmaReader needs storage permission to save files in Documents. Allow it in Android Settings → Apps → PharmaReader → Permissions, then try again.',
    );
  }
}

async function writeNative(blob: Blob, path: string): Promise<void> {
  let offset = 0;
  try {
    do {
      const end = Math.min(offset + CHUNK_BYTES, blob.size);
      const bytes = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
      const data = base64Of(bytes);
      if (offset === 0) {
        // recursive: create PharmaReader/ the first time.
        await Filesystem.writeFile({ path, data, directory: Directory.Documents, recursive: true });
      } else {
        await Filesystem.appendFile({ path, data, directory: Directory.Documents });
      }
      offset = end;
    } while (offset < blob.size);
  } catch (err) {
    // A half-written file looks like a backup but restores nothing, so a failed
    // append must not leave one behind. Best effort: the original error wins.
    await Filesystem.deleteFile({ path, directory: Directory.Documents }).catch(() => undefined);
    throw err;
  }
}

/** btoa over 32 KB slices: spreading a whole chunk into apply() overflows the stack. */
export function base64Of(bytes: Uint8Array): string {
  let binary = '';
  const SLICE = 0x8000;
  for (let i = 0; i < bytes.length; i += SLICE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + SLICE));
  }
  return btoa(binary);
}

function downloadInBrowser(blob: Blob, name: string): void {
  try {
    // The URL names the Blob rather than copying it: a 400 MB backup is not read
    // into memory a second time on its way to the Downloads folder.
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Firefox aborts a download whose blob URL is revoked too soon.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch {
    throw new Error('Your browser would not let this page save the file.');
  }
}
