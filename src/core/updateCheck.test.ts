import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from './db';
import { getSetting, setSetting } from './settings';
import {
  checkForUpdate,
  dismissUpdate,
  isUpdateCheckDue,
  pickNewerRelease,
  releaseVersion,
  RELEASES_URL,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_CHECK_KEY,
  UPDATE_CHECKED_AT_KEY,
  UPDATE_DISMISSED_KEY,
} from './updateCheck';
import { APP_VERSION } from './version';

const NOW = 1_700_000_000_000;

function release(tag: string, overrides: Record<string, unknown> = {}) {
  return {
    tag_name: tag,
    html_url: `https://github.com/aswanthwuhan/pharmareader/releases/tag/${tag}`,
    draft: false,
    prerelease: true,
    body: 'notes nobody reads',
    ...overrides,
  };
}

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function failResponse(status = 404): Response {
  return { ok: false, status, json: async () => ({ message: 'Not Found' }) } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  await db.delete();
  await db.open();
  fetchMock = vi.fn(async () => okResponse([release('v0.4.0')]));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await db.delete();
  await db.open();
});

describe('releaseVersion', () => {
  it('strips the leading v from GitHub tags', () => {
    expect(releaseVersion('v0.4.0')).toBe('0.4.0');
    expect(releaseVersion(' 0.4.0-rc.1 ')).toBe('0.4.0-rc.1');
  });
});

describe('pickNewerRelease', () => {
  it('picks the newest release that is newer than the app', () => {
    const picked = pickNewerRelease(
      [release('v0.3.1'), release('v0.4.0'), release('v0.3.0'), release('v0.2.9')],
      '0.3.0',
    );
    expect(picked?.version).toBe('0.4.0');
  });

  it('counts pre-releases, because every PharmaReader release is one', () => {
    expect(pickNewerRelease([release('v0.4.0-rc.1')], '0.3.0')?.version).toBe('0.4.0-rc.1');
  });

  it('skips drafts and malformed entries', () => {
    const picked = pickNewerRelease(
      [
        release('v0.5.0', { draft: true }),
        release('latest'),
        { tag_name: 'v0.6.0' },
        'not an object',
        release('v0.4.0'),
      ],
      '0.3.0',
    );
    expect(picked?.version).toBe('0.4.0');
  });

  it('reports nothing when the app is already the newest', () => {
    expect(pickNewerRelease([release('v0.3.0')], '0.3.0')).toBeNull();
    expect(pickNewerRelease([], '0.3.0')).toBeNull();
    expect(pickNewerRelease(null, '0.3.0')).toBeNull();
  });
});

describe('isUpdateCheckDue', () => {
  it('is never due while the toggle is off', () => {
    expect(isUpdateCheckDue(false, undefined, NOW)).toBe(false);
  });

  it('is due once, then not again within 24 hours', () => {
    expect(isUpdateCheckDue(true, undefined, NOW)).toBe(true);
    expect(isUpdateCheckDue(true, NOW - UPDATE_CHECK_INTERVAL_MS + 1, NOW)).toBe(false);
    expect(isUpdateCheckDue(true, NOW - UPDATE_CHECK_INTERVAL_MS, NOW)).toBe(true);
  });

  it('does not poll in a loop after the clock is set back', () => {
    expect(isUpdateCheckDue(true, NOW + 60_000, NOW)).toBe(false);
  });
});

describe('checkForUpdate', () => {
  it('does nothing while the reader has not opted in', async () => {
    expect(await checkForUpdate({ now: NOW })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await getSetting(UPDATE_CHECKED_AT_KEY, undefined)).toBeUndefined();
  });

  it('asks GitHub once a day with no data beyond the Accept header', async () => {
    await setSetting(UPDATE_CHECK_KEY, true);

    const result = await checkForUpdate({ now: NOW });

    expect(result).toEqual({
      version: '0.4.0',
      url: 'https://github.com/aswanthwuhan/pharmareader/releases/tag/v0.4.0',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(RELEASES_URL);
    expect(init.headers).toEqual({ Accept: 'application/vnd.github+json' });
    expect(Object.keys(init).sort()).toEqual(['headers', 'signal']);
    expect(await getSetting(UPDATE_CHECKED_AT_KEY, undefined)).toBe(NOW);
  });

  it('is throttled for 24 hours after an attempt', async () => {
    await setSetting(UPDATE_CHECK_KEY, true);
    await checkForUpdate({ now: NOW });
    fetchMock.mockClear();

    expect(await checkForUpdate({ now: NOW + 60_000 })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports nothing when the running version is up to date', async () => {
    await setSetting(UPDATE_CHECK_KEY, true);
    fetchMock.mockResolvedValueOnce(okResponse([release(`v${APP_VERSION}`)]));

    expect(await checkForUpdate({ now: NOW })).toBeNull();
    // Still counts as the one attempt of the day.
    expect(await getSetting(UPDATE_CHECKED_AT_KEY, undefined)).toBe(NOW);
  });

  it('stays silent when the same version was dismissed', async () => {
    await setSetting(UPDATE_CHECK_KEY, true);
    await dismissUpdate('0.4.0');

    expect(await checkForUpdate({ now: NOW })).toBeNull();
    expect(await getSetting(UPDATE_DISMISSED_KEY, undefined)).toBe('0.4.0');

    // A later release is offered again.
    fetchMock.mockResolvedValueOnce(okResponse([release('v0.5.0')]));
    expect((await checkForUpdate({ now: NOW + UPDATE_CHECK_INTERVAL_MS }))?.version).toBe('0.5.0');
  });

  it('stays silent on an HTTP failure and does not ask again that day', async () => {
    await setSetting(UPDATE_CHECK_KEY, true);
    fetchMock.mockResolvedValueOnce(failResponse(403));

    expect(await checkForUpdate({ now: NOW })).toBeNull();
    expect(await getSetting(UPDATE_CHECKED_AT_KEY, undefined)).toBe(NOW);
  });

  it('stays silent when the network rejects the request', async () => {
    await setSetting(UPDATE_CHECK_KEY, true);
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    expect(await checkForUpdate({ now: NOW })).toBeNull();
  });

  it('stays silent when the response is not a release list', async () => {
    await setSetting(UPDATE_CHECK_KEY, true);
    fetchMock.mockResolvedValueOnce(okResponse({ message: 'whatever' }));

    expect(await checkForUpdate({ now: NOW })).toBeNull();
  });

  it('gives up after the timeout instead of holding the app', async () => {
    await setSetting(UPDATE_CHECK_KEY, true);
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );

    expect(await checkForUpdate({ now: NOW, timeoutMs: 5 })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not call GitHub while offline', async () => {
    await setSetting(UPDATE_CHECK_KEY, true);
    const onLine = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine');
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    try {
      expect(await checkForUpdate({ now: NOW })).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (onLine) Object.defineProperty(Navigator.prototype, 'onLine', onLine);
      delete (navigator as unknown as { onLine?: boolean }).onLine;
    }
  });
});

describe('pickNewerRelease link safety', () => {
  it('ignores a release whose page is not a GitHub https URL', () => {
    expect(
      pickNewerRelease([{ tag_name: 'v99.0.0', html_url: 'javascript:alert(1)' }], '0.3.0'),
    ).toBeNull();
  });
});
