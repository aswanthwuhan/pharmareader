import { describe, expect, it } from 'vitest';
import {
  KOKORO_ARCHIVE_BYTES,
  KOKORO_REQUIRED_BYTES,
  downloadLabel,
  formatBytes,
  meteredWarning,
  resumeFraction,
  storageWarning,
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
