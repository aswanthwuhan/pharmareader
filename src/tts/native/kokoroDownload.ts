/**
 * Pure helpers for the on-device Kokoro download UI.
 *
 * Kept out of `KokoroNativePanel` so the wording, the resume arithmetic, the storage
 * pre-check and the "someone is already downloading" wait can be unit tested without a
 * DOM or a native plugin.
 */
import type { KokoroStage } from './kokoroFailure';

/** 334 MiB archive of `kokoro-multi-lang-v1_0` (matches KokoroModel.ARCHIVE_BYTES). */
export const KOKORO_ARCHIVE_BYTES = 349_886_476;
/** Archive plus unpacked model: both exist while the archive is being unpacked (~734 MiB). */
export const KOKORO_REQUIRED_BYTES = 769_886_476;

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${mb >= 100 ? mb.toFixed(0) : mb.toFixed(1)} MB`;
}

/** How much of the archive a previous attempt already saved, 0..1. */
export function resumeFraction(
  partialBytes: number | undefined,
  archiveBytes: number = KOKORO_ARCHIVE_BYTES
): number {
  if (!partialBytes || !Number.isFinite(partialBytes) || partialBytes <= 0) return 0;
  if (!Number.isFinite(archiveBytes) || archiveBytes <= 0) return 0;
  return Math.min(1, partialBytes / archiveBytes);
}

export interface DownloadLabelInput {
  downloaded: boolean;
  partialBytes?: number;
  archiveBytes?: number;
}

/** "Download model (334 MB)" / "Resume download (334 MB)" / "Downloaded". */
export function downloadLabel(input: DownloadLabelInput): string {
  const size = formatBytes(input.archiveBytes ?? KOKORO_ARCHIVE_BYTES);
  if (input.downloaded) return 'Downloaded';
  if (resumeFraction(input.partialBytes, input.archiveBytes) > 0) {
    return `Resume download (${size})`;
  }
  return `Download model (${size})`;
}

/**
 * A warning when the phone cannot hold the download plus the unpacked model, else null.
 * `freeBytes` of 0/undefined means "unknown" and is not treated as a failure.
 */
export function storageWarning(
  freeBytes: number | undefined,
  requiredBytes: number | undefined = KOKORO_REQUIRED_BYTES
): string | null {
  if (!freeBytes || !requiredBytes || freeBytes <= 0) return null;
  if (freeBytes >= requiredBytes) return null;
  return (
    `Not enough free storage: ${formatBytes(freeBytes)} available, ` +
    `about ${formatBytes(requiredBytes)} needed (the download plus the unpacked model).`
  );
}

/** The mobile-data warning shown before a download, or null when it does not apply. */
export function meteredWarning(metered: boolean | undefined, downloaded: boolean): string | null {
  if (!metered || downloaded) return null;
  return `334 MB download — use Wi-Fi. On mobile data this can use a large part of a data plan.`;
}

/**
 * The plugin runs one download at a time and rejects a second `download()` with
 * code `BUSY` ("A model download is already running"). That is not a failure:
 * the first call is still working, and the right move is to wait for it.
 */
export function isBusyError(err: unknown): boolean {
  if (!err) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && code.toUpperCase() === 'BUSY') return true;
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return /already (running|downloading)|download is already/i.test(message);
}

interface StagedError {
  downloadStage?: KokoroStage;
}

/**
 * Remember which stage a native download failed in.
 *
 * The download runs outside the component that started it, so a remounted panel
 * only has the stored rejection to describe — and "Failed while downloading the
 * 334 MB model" is wrong for a failure that happened while unpacking.
 */
export function tagDownloadStage(err: unknown, stage: KokoroStage): Error {
  const tagged = err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'The download failed.');
  try {
    (tagged as Error & StagedError).downloadStage = stage;
  } catch {
    /* a frozen error object is still worth throwing as it is */
  }
  return tagged;
}

export function downloadStageOf(err: unknown): KokoroStage | undefined {
  const stage = (err as StagedError | null | undefined)?.downloadStage;
  return typeof stage === 'string' ? stage : undefined;
}

export interface RunningDownloadStatus {
  downloaded: boolean;
  /** Bytes of the archive already saved; moves as the HTTP download writes. */
  partialBytes?: number;
  archiveBytes?: number;
}

export interface FollowDownloadOptions {
  /** Reads the plugin's state; the native `status()` call. */
  status(): Promise<RunningDownloadStatus>;
  /** Subscribes to `downloadProgress`; resolves to the matching unsubscribe. */
  listen(onProgress: (fraction: number) => void): Promise<() => void>;
  /** Fraction received so far (from the listener and from the polled byte counts). */
  onProgress(fraction: number): void;
  /** The archive is complete and the plugin is unpacking it (the slow part). */
  onUnpacking?(): void;
  /** How often to ask the plugin for its state. */
  pollMs?: number;
  /** How long the saved byte count may stay frozen before the wait is declared failed. */
  stallMs?: number;
  /**
   * How long the unpack/verify pass may run without the plugin reporting the
   * model as downloaded. It reports no progress there (the archive is already
   * complete), so only a cap can tell "slow phone" from "the io thread died".
   */
  unpackMs?: number;
}

const DEFAULT_POLL_MS = 2000;
const DEFAULT_STALL_MS = 5 * 60_000;
/** Unpacking 334 MB on a slow phone takes minutes; 15 is well past any honest run. */
const DEFAULT_UNPACK_MS = 15 * 60_000;

/**
 * Wait for a download that this WebView did not start (it got BUSY because a
 * previous mount, or the native side itself, is already downloading).
 *
 * Polling `status()` is the only truth that survives the JS listener being
 * dropped; the listener is kept as well so the bar moves between polls. During
 * the unpack/verify pass `partialBytes` sits at the full archive size and
 * `downloaded` is still false, which is reported as work in progress — not as a
 * stalled download, because that pass is expected to take minutes. That pass
 * needs its own, much longer cap (`unpackMs`): its byte count cannot move, so
 * without one a dead io thread would hang every later caller forever.
 */
export async function followRunningDownload(options: FollowDownloadOptions): Promise<void> {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const stallMs = options.stallMs ?? DEFAULT_STALL_MS;
  const unpackMs = options.unpackMs ?? DEFAULT_UNPACK_MS;
  const stopListening = await options.listen((fraction) => {
    options.onProgress(Math.min(1, Math.max(0, fraction)));
  });
  try {
    let lastBytes = -1;
    let frozenPolls = 0;
    let unpacking = false;
    let unpackPolls = 0;
    for (;;) {
      const status = await options.status();
      if (status.downloaded) return;
      const archiveBytes =
        status.archiveBytes && status.archiveBytes > 0 ? status.archiveBytes : KOKORO_ARCHIVE_BYTES;
      const partialBytes = status.partialBytes && status.partialBytes > 0 ? status.partialBytes : 0;
      const fraction = resumeFraction(partialBytes, archiveBytes);
      if (fraction >= 1) {
        if (!unpacking) {
          unpacking = true;
          unpackPolls = 0;
          options.onUnpacking?.();
        }
        options.onProgress(1);
        // The byte counter is frozen at 100% by design here, so the download's
        // stall check cannot see a dead unpack. A generous cap keeps the wait
        // from becoming an endless "Unpacking… 100%" that never settles.
        unpackPolls += 1;
        if (unpackPolls * pollMs > unpackMs) {
          throw new Error(
            'The archive finished downloading, but unpacking it stopped making progress. Start the download again — the archive is already saved.'
          );
        }
      } else {
        options.onProgress(fraction);
        if (partialBytes === lastBytes) {
          frozenPolls += 1;
          if (frozenPolls * pollMs > stallMs) {
            throw new Error(
              'The download stopped making progress. Start it again to continue from where it stopped.'
            );
          }
        } else {
          lastBytes = partialBytes;
          frozenPolls = 0;
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
    }
  } finally {
    stopListening();
  }
}
