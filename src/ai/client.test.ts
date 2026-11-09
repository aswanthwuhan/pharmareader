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

  it('retries without response_format when the provider rejects it', async () => {
    await enable();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { response_format?: unknown };
      return body.response_format ? response({ error: { message: 'response_format unsupported' } }, 400) : reply('ok');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(chat([{ role: 'user', content: 'hi' }], { json: true })).resolves.toBe('ok');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as { response_format?: unknown };
    const second = JSON.parse(String(fetchMock.mock.calls[1][1].body)) as { response_format?: unknown };
    expect(first.response_format).toEqual({ type: 'json_object' });
    expect(second.response_format).toBeUndefined();
  });

  it('does not retry a 400 when JSON mode was not requested', async () => {
    await enable();
    const fetchMock = vi.fn(async () => response({ error: { message: 'bad request' } }, 400));
    vi.stubGlobal('fetch', fetchMock);

    const err = await failure(chat([{ role: 'user', content: 'hi' }]));
    expect(err.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('times out when the provider never answers', async () => {
    await enable();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }),
      ),
    );

    const err = await failure(chat([{ role: 'user', content: 'hi' }], { timeoutMs: 5 }));
    expect(err.kind).toBe('timeout');
    expect(err.message).toMatch(/timed out/i);
  });

  it('never calls the provider when the signal is already aborted', async () => {
    await enable();
    const fetchMock = vi.fn(async () => reply('ok'));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();

    await expect(chat([{ role: 'user', content: 'hi' }], { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates a caller abort during the request as AbortError', async () => {
    await enable();
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
            setTimeout(() => controller.abort(), 1);
          }),
      ),
    );

    await expect(chat([{ role: 'user', content: 'hi' }], { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('never echoes the API key back in a provider error', async () => {
    await enable();
    await setSetting('ai.apiKey', 'sk-test-secret-1234');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ error: { message: 'bad request: sk-test-secret-1234' } }, 400)),
    );

    const err = await failure(chat([{ role: 'user', content: 'hi' }]));
    expect(err.message).not.toContain('sk-test-secret-1234');
    expect(err.message).toContain('[redacted]');
  });

  it('never repeats the key in an auth error', async () => {
    await enable();
    await setSetting('ai.apiKey', 'sk-test-secret-1234');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ error: { message: 'Incorrect API key: sk-test-secret-1234' } }, 401)),
    );

    const err = await failure(chat([{ role: 'user', content: 'hi' }]));
    expect(err.kind).toBe('auth');
    expect(err.message).not.toContain('sk-test-secret-1234');
  });

  it('refuses a plain-http base URL but allows loopback', async () => {
    await enable('http://api.test/v1');
    const fetchMock = vi.fn(async () => reply('ok'));
    vi.stubGlobal('fetch', fetchMock);

    const err = await failure(chat([{ role: 'user', content: 'hi' }]));
    expect(err.kind).toBe('config');
    expect(err.message).toMatch(/https/i);
    expect(fetchMock).not.toHaveBeenCalled();

    await enable('http://localhost:8080/v1');
    await expect(chat([{ role: 'user', content: 'hi' }])).resolves.toBe('ok');
  });

  it('refuses a base URL with a query string', async () => {
    await enable('https://api.test/v1?key=leak');
    const err = await failure(chat([{ role: 'user', content: 'hi' }]));
    expect(err.kind).toBe('config');
  });
});

describe('mapHttpError', () => {
  it('points at the base URL for a 404', () => {
    expect(mapHttpError(404, '').message).toMatch(/base URL/i);
  });

  it('includes the provider message when there is one', () => {
    expect(mapHttpError(500, JSON.stringify({ error: { message: 'overloaded' } })).message).toContain('overloaded');
  });

  it('redacts the key from provider text', () => {
    const err = mapHttpError(400, JSON.stringify({ error: { message: 'bad key sk-super-secret' } }), 'sk-super-secret');
    expect(err.message).not.toContain('sk-super-secret');
    expect(err.message).toContain('[redacted]');
  });
});
