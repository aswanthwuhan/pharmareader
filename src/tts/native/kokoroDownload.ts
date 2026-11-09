/**
 * Pure helpers for the on-device Kokoro download UI.
 *
 * Kept out of `KokoroNativePanel` so the wording, the resume arithmetic and the storage
 * pre-check can be unit tested without a DOM or a native plugin.
 */

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
