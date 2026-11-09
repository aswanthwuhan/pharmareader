import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../core/db';
import { setSetting } from '../core/settings';
import { AiError, chat, mapHttpError } from './client';

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

const reply = (content: string, status = 200) => response({ choices: [{ message: { content } }] }, status);

async function enable(baseUrl = 'https://api.test/v1') {
  await setSetting('ai.enabled', true);
  await setSetting('ai.baseUrl', baseUrl);
  await setSetting('ai.apiKey', 'sk-test');
  await setSetting('ai.model', 'test-model');
}

async function failure(promise: Promise<unknown>): Promise<AiError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof AiError) return err;
    throw err;
  }
  throw new Error('expected the call to fail');
}

beforeEach(async () => {
  await db.settings.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('chat', () => {
  it('refuses to call out while AI is off', async () => {
    const err = await failure(chat([{ role: 'user', content: 'hi' }]));
    expect(err.kind).toBe('disabled');
  });

  it('posts to /chat/completions with the key and asks for JSON when needed', async () => {
    await enable();
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => reply(' hello '));
    vi.stubGlobal('fetch', fetchMock);

    await expect(chat([{ role: 'user', content: 'hi' }], { json: true })).resolves.toBe('hello');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.test/v1/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(String(init.body)) as { model: string; response_format?: unknown };
    expect(body.model).toBe('test-model');
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('adds the browser-access header for Anthropic', async () => {
    await enable('https://api.anthropic.com/v1');
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => reply('ok'));
    vi.stubGlobal('fetch', fetchMock);

    await chat([{ role: 'user', content: 'hi' }]);

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true');
  });

  it('reports a rejected key as an auth error', async () => {
    await enable();
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: { message: 'Incorrect API key' } }, 401)));

    const err = await failure(chat([{ role: 'user', content: 'hi' }]));
    expect(err.kind).toBe('auth');
    expect(err.status).toBe(401);
    expect(err.message).toMatch(/API key/i);
  });

  it('reports rate limiting', async () => {
    await enable();
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: { message: 'quota' } }, 429)));

    const err = await failure(chat([{ role: 'user', content: 'hi' }]));
    expect(err.kind).toBe('rate');
    expect(err.message).toMatch(/429/);
  });

  it('reports a blocked browser request as a network/CORS error', async () => {
    await enable();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    const err = await failure(chat([{ role: 'user', content: 'hi' }]));
    expect(err.kind).toBe('network');
    expect(err.message).toMatch(/CORS/);
  });

  it('rejects an empty completion', async () => {
    await enable();
    vi.stubGlobal('fetch', vi.fn(async () => response({ choices: [{ message: { content: '' } }] })));

    const err = await failure(chat([{ role: 'user', content: 'hi' }]));
    expect(err.kind).toBe('server');
  });
});

describe('mapHttpError', () => {
  it('points at the base URL for a 404', () => {
    expect(mapHttpError(404, '').message).toMatch(/base URL/i);
  });

  it('includes the provider message when there is one', () => {
    expect(mapHttpError(500, JSON.stringify({ error: { message: 'overloaded' } })).message).toContain('overloaded');
  });
});
