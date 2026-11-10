import { describe, expect, it, vi } from 'vitest';
import {
  KOKORO_ARCHIVE_BYTES,
  KOKORO_REQUIRED_BYTES,
  downloadLabel,
  downloadStageOf,
  followRunningDownload,
  formatBytes,
  isBusyError,
  meteredWarning,
  resumeFraction,
  storageWarning,
  tagDownloadStage,
} from './kokoroDownload';

describe('formatBytes', () => {
  it('formats the archive size the way the panel shows it', () => {
    expect(formatBytes(KOKORO_ARCHIVE_BYTES)).toBe('334 MB');
    expect(formatBytes(KOKORO_REQUIRED_BYTES)).toBe('734 MB');
  });

  it('handles small and missing sizes', () => {
    expect(formatBytes(undefined)).toBe('0 MB');
    expect(formatBytes(0)).toBe('0 MB');
    expect(formatBytes(-5)).toBe('0 MB');
    expect(formatBytes(Number.NaN)).toBe('0 MB');
    expect(formatBytes(512 * 1024)).toBe('512 KB');
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
  });
});

describe('resumeFraction', () => {
  it('is zero without a partial file', () => {
    expect(resumeFraction(undefined)).toBe(0);
    expect(resumeFraction(0)).toBe(0);
    expect(resumeFraction(-1)).toBe(0);
  });

  it('reports how much of the archive is already on disk', () => {
    expect(resumeFraction(KOKORO_ARCHIVE_BYTES / 2)).toBeCloseTo(0.5, 5);
    expect(resumeFraction(KOKORO_ARCHIVE_BYTES)).toBe(1);
    // Never above 100%, even if a stale .part is larger than the current archive.
    expect(resumeFraction(KOKORO_ARCHIVE_BYTES * 2)).toBe(1);
    expect(resumeFraction(100, 0)).toBe(0);
  });
});

describe('downloadLabel', () => {
  it('offers a resume when a partial download exists', () => {
    expect(downloadLabel({ downloaded: false })).toBe('Download model (334 MB)');
    expect(downloadLabel({ downloaded: false, partialBytes: 1_000_000 })).toBe(
      'Resume download (334 MB)'
    );
    expect(downloadLabel({ downloaded: true, partialBytes: 1_000_000 })).toBe('Downloaded');
  });
});

describe('storageWarning', () => {
  it('stays quiet when there is enough room or the size is unknown', () => {
    expect(storageWarning(undefined)).toBeNull();
    expect(storageWarning(0)).toBeNull();
    expect(storageWarning(KOKORO_REQUIRED_BYTES)).toBeNull();
    expect(storageWarning(KOKORO_REQUIRED_BYTES + 1)).toBeNull();
  });

  it('explains the shortfall when the phone cannot hold the model', () => {
    const warning = storageWarning(100 * 1024 * 1024);
    expect(warning).toContain('Not enough free storage');
    expect(warning).toContain('100 MB available');
    expect(warning).toContain('734 MB needed');
  });
});

describe('meteredWarning', () => {
  it('warns about the download only while it is still needed', () => {
    expect(meteredWarning(undefined, false)).toBeNull();
    expect(meteredWarning(false, false)).toBeNull();
    expect(meteredWarning(true, true)).toBeNull();
    const warning = meteredWarning(true, false);
    expect(warning).toContain('334 MB');
    expect(warning).toContain('Wi-Fi');
  });
});

describe('isBusyError', () => {
  it('recognises the plugin refusal to start a second download', () => {
    expect(isBusyError(Object.assign(new Error('A model download is already running'), { code: 'BUSY' }))).toBe(
      true
    );
    // Older builds only sent the code on a plain object.
    expect(isBusyError({ code: 'busy' })).toBe(true);
    expect(isBusyError(new Error('A model download is already running'))).toBe(true);
  });

  it('does not mistake a real failure for a busy plugin', () => {
    expect(isBusyError(null)).toBe(false);
    expect(isBusyError(undefined)).toBe(false);
    expect(isBusyError(new Error('disk full'))).toBe(false);
    expect(isBusyError(Object.assign(new Error('not enough space'), { code: 'ENOSPC' }))).toBe(false);
    expect(isBusyError('no such model')).toBe(false);
  });
});

describe('tagDownloadStage', () => {
  it('carries the stage the download failed in to the remounted panel', () => {
    const boom = tagDownloadStage(new Error('disk full'), 'unpack');
    expect(downloadStageOf(boom)).toBe('unpack');
    expect(boom.message).toBe('disk full');

    const text = tagDownloadStage('worker stopped', 'load');
    expect(downloadStageOf(text)).toBe('load');
    expect(text.message).toBe('worker stopped');

    expect(downloadStageOf(new Error('plain'))).toBeUndefined();
    expect(downloadStageOf(undefined)).toBeUndefined();
  });
});

describe('followRunningDownload', () => {
  it('follows the plugin state until the model is unpacked', async () => {
    const statuses = [
      { downloaded: false, partialBytes: 100, archiveBytes: 400 },
      { downloaded: false, partialBytes: 400, archiveBytes: 400 },
      { downloaded: true, partialBytes: 0, archiveBytes: 400 },
    ];
    const fractions: number[] = [];
    const unpacked = vi.fn();
    const unsubscribe = vi.fn();

    await followRunningDownload({
      status: async () => statuses.shift() ?? { downloaded: true },
      listen: async () => unsubscribe,
      onProgress: (fraction) => fractions.push(fraction),
      onUnpacking: unpacked,
      pollMs: 1,
    });

    expect(fractions).toEqual([0.25, 1]);
    // The archive is complete but the model is not: that is the unpack/verify pass.
    expect(unpacked).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('takes progress from the plugin events as well as the polled bytes', async () => {
    const statuses = [
      { downloaded: false, partialBytes: 100, archiveBytes: 400 },
      { downloaded: true },
    ];
    const fractions: number[] = [];

    await followRunningDownload({
      status: async () => statuses.shift() ?? { downloaded: true },
      listen: async (onProgress) => {
        onProgress(0.5);
        return () => undefined;
      },
      onProgress: (fraction) => fractions.push(fraction),
      pollMs: 1,
    });

    expect(fractions).toEqual([0.5, 0.25]);
  });

  it('does nothing when the download already finished', async () => {
    const progress = vi.fn();
    await followRunningDownload({
      status: async () => ({ downloaded: true }),
      listen: async () => () => undefined,
      onProgress: progress,
    });
    expect(progress).not.toHaveBeenCalled();
  });

  it('gives up when the saved bytes stop moving, and stops listening', async () => {
    const unsubscribe = vi.fn();
    const waiting = followRunningDownload({
      status: async () => ({ downloaded: false, partialBytes: 10, archiveBytes: 100 }),
      listen: async () => unsubscribe,
      onProgress: () => undefined,
      pollMs: 1,
      stallMs: 5,
    });

    await expect(waiting).rejects.toThrow('stopped making progress');
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('gives up when the unpack pass never finishes, and stops listening', async () => {
    // The archive is complete but `downloaded` never turns true: the byte count
    // is frozen at 100% by design, so only the unpack cap can end the wait.
    const unsubscribe = vi.fn();
    const waiting = followRunningDownload({
      status: async () => ({ downloaded: false, partialBytes: 400, archiveBytes: 400 }),
      listen: async () => unsubscribe,
      onProgress: () => undefined,
      onUnpacking: () => undefined,
      pollMs: 1,
      unpackMs: 5,
    });

    await expect(waiting).rejects.toThrow('unpacking it stopped making progress');
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
