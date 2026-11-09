/**
 * Minimal client for any OpenAI-compatible chat endpoint (bring your own key).
 * AI is off by default; nothing leaves the device until `ai.enabled` is on.
 */
import { getSetting } from '../core/settings';

export type AiPresetId = 'openai' | 'deepseek' | 'gemini' | 'anthropic' | 'custom';

export interface AiPreset {
  id: AiPresetId;
  label: string;
  baseUrl: string;
  model: string;
}

export const AI_PRESETS: readonly AiPreset[] = [
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  {
    id: 'gemini',
    label: 'Gemini (OpenAI-compatible)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
  },
  {
    id: 'anthropic',
    label: 'Anthropic (OpenAI-compatible)',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-haiku-5-5',
  },
  { id: 'custom', label: 'Custom', baseUrl: '', model: '' },
];

export const AI_DEFAULTS = {
  enabled: false,
  baseUrl: AI_PRESETS[0].baseUrl,
  model: AI_PRESETS[0].model,
  apiKey: '',
};

export interface AiConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export type AiErrorKind = 'disabled' | 'config' | 'auth' | 'rate' | 'network' | 'timeout' | 'server';

export class AiError extends Error {
  constructor(message: string, readonly kind: AiErrorKind, readonly status?: number) {
    super(message);
    this.name = 'AiError';
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  /** Ask the provider for a JSON object (response_format). */
  json?: boolean;
  signal?: AbortSignal;
}

/** 60 s is long enough for a large summary, short enough to fail visibly. */
export const AI_TIMEOUT_MS = 60_000;

export async function readAiConfig(): Promise<AiConfig> {
  const [enabled, baseUrl, apiKey, model] = await Promise.all([
    getSetting('ai.enabled', AI_DEFAULTS.enabled),
    getSetting('ai.baseUrl', AI_DEFAULTS.baseUrl),
    getSetting('ai.apiKey', AI_DEFAULTS.apiKey),
    getSetting('ai.model', AI_DEFAULTS.model),
  ]);
  return { enabled, baseUrl, apiKey, model };
}

/** POST {baseUrl}/chat/completions and return the assistant text. */
export async function chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  const cfg = await readAiConfig();
  if (!cfg.enabled) throw new AiError('AI is off. Turn it on in Settings → AI.', 'disabled');

  const baseUrl = cfg.baseUrl.trim().replace(/\/+$/, '');
  const apiKey = cfg.apiKey.trim();
  const model = cfg.model.trim();
  if (!baseUrl) throw new AiError('Set the provider base URL in Settings → AI.', 'config');
  if (!apiKey) throw new AiError('Add your API key in Settings → AI.', 'config');
  if (!model) throw new AiError('Set a model name in Settings → AI.', 'config');

  let url: URL;
  try {
    url = new URL(`${baseUrl}/chat/completions`);
  } catch {
    throw new AiError('The base URL is not a valid URL.', 'config');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  // Anthropic's endpoint refuses browser calls unless the caller opts in explicitly.
  if (url.hostname.endsWith('anthropic.com')) {
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  }

  const body: Record<string, unknown> = { model, messages };
  if (opts.json) body.response_format = { type: 'json_object' };

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, AI_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw toRequestError(err, timedOut, url.host, opts.signal);
    }

    if (!res.ok) throw mapHttpError(res.status, await res.text().catch(() => ''));

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new AiError('The provider sent a response that was not JSON.', 'server', res.status);
    }
    const content = assistantText(data);
    if (!content) throw new AiError('The provider returned no text. Check the model name.', 'server', res.status);
    return content;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/** Turn a non-2xx response into an actionable message. */
export function mapHttpError(status: number, body: string): AiError {
  const detail = errorDetail(body);
  if (status === 401 || status === 403) {
    return new AiError(`The provider rejected your API key (HTTP ${status}). Check the key in Settings → AI.`, 'auth', status);
  }
  if (status === 429) {
    return new AiError('Rate limit or quota reached (HTTP 429). Wait a minute and try again.', 'rate', status);
  }
  if (status === 404) {
    return new AiError(`Endpoint not found (HTTP 404). Check the base URL — it usually ends in /v1.${detail}`, 'config', status);
  }
  if (status >= 500) {
    return new AiError(`The provider had a server error (HTTP ${status}). Try again shortly.${detail}`, 'server', status);
  }
  return new AiError(`Request failed (HTTP ${status}).${detail}`, 'server', status);
}

function errorDetail(body: string): string {
  if (!body) return '';
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    const err = parsed.error;
    const msg = typeof err === 'string' ? err : typeof err?.message === 'string' ? err.message : undefined;
    const fallback = typeof parsed.message === 'string' ? parsed.message : undefined;
    const text = msg ?? fallback;
    if (text) return ` ${text.slice(0, 200)}`;
  } catch {
    // not JSON: fall through to the raw snippet
  }
  const snippet = body.trim().replace(/\s+/g, ' ').slice(0, 200);
  return snippet ? ` ${snippet}` : '';
}

function toRequestError(err: unknown, timedOut: boolean, host: string, callerSignal?: AbortSignal): Error {
  if (err instanceof Error && err.name === 'AbortError') {
    if (timedOut) return new AiError('The request timed out after 60 seconds. Try again.', 'timeout');
    if (callerSignal?.aborted) return err;
    return new AiError('The request was cancelled before the provider answered.', 'network');
  }
  if (err instanceof AiError) return err;
  return new AiError(
    `Could not reach ${host}. The network failed, or the provider blocked the browser request (CORS). Check the base URL.`,
    'network',
  );
}

function assistantText(data: unknown): string {
  const choice = (data as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === 'string') return content.trim();
  // Some providers send content as parts.
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : ((part as { text?: unknown })?.text ?? '')))
      .join('')
      .trim();
  }
  return '';
}
