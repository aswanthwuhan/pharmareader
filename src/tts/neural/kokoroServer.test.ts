import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setSetting } from '../../core/settings';
import { DEFAULT_SERVER_URL, SERVER_URL_SETTING, fetchVoices, isServerReachable, kokoroServerEngine } from './kokoroServer';

const BASE = 'http://192.168.1.20:8880';
const bodies: unknown[] = [];
const urls: string[] = [];

function okJson(data: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', json: async () => data } as unknown as Response;
}

function okBlob(data: Blob): Response {
  return { ok: true, status: 200, statusText: 'OK', blob: async () => data } as unknown as Response;
}

beforeEach(async () => {
  bodies.length = 0;
  urls.length = 0;
  await setSetting(SERVER_URL_SETTING, BASE);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('kokoroServer', () => {
  it('POSTs the OpenAI speech body', async () => {
    const audio = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        urls.push(String(url));
        if (init?.body) bodies.push(JSON.parse(String(init.body)));
        return okBlob(audio);
      })
    );

    const blob = await kokoroServerEngine.synthesize!('Take one tablet daily.', { voiceId: 'am_adam', rate: 1.25 });

    expect(blob).toBe(audio);
    expect(urls[0]).toBe(`${BASE}/v1/audio/speech`);
    expect(bodies[0]).toEqual({
      model: 'kokoro',
      input: 'Take one tablet daily.',
      voice: 'am_adam',
      response_format: 'mp3',
      speed: 1.25,
    });
  });

  it('reads voices from either the array or the wrapped shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson({ voices: ['af_heart', 'bm_george'] }))
    );
    await expect(fetchVoices(BASE)).resolves.toEqual(['af_heart', 'bm_george']);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson(['af_bella']))
    );
    await expect(fetchVoices(BASE)).resolves.toEqual(['af_bella']);
  });

  it('falls back to af_heart when the voices endpoint fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 } as unknown as Response)));
    await expect(fetchVoices(BASE)).rejects.toThrow(/500/);
    // listVoices keeps its default instead of throwing at the UI.
    await expect(kokoroServerEngine.listVoices()).resolves.toEqual([
      { id: 'af_heart', name: 'Heart', lang: 'en-US' },
    ]);
  });

  it('probes reachability and gives up quickly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson([])));
    await expect(isServerReachable(BASE)).resolves.toBe(true);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );
    await expect(isServerReachable(BASE)).resolves.toBe(false);
    await expect(kokoroServerEngine.isReady()).resolves.toBe(false);
  });

  it('reports a server error instead of returning broken audio', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, statusText: 'Service Unavailable' } as unknown as Response))
    );
    await expect(kokoroServerEngine.synthesize!('hello', { rate: 1 })).rejects.toThrow(/503/);
  });

  it('defaults to localhost:8880', () => {
    expect(DEFAULT_SERVER_URL).toBe('http://localhost:8880');
  });
});
