/**
 * Turns a failed native Kokoro call into what the settings panel shows.
 *
 * The plugin rejects with a human message plus a machine code, but that message alone cannot
 * tell us *where* it failed: "the connection closed after 123 of 349886476 bytes" is a
 * download, "missing espeak-ng-data/" is a verification problem. The panel therefore tracks
 * the stage it is in and pairs it with the error here.
 *
 * The second job is the copyable block. Almost every user report is "the download fails" with
 * no details, so the panel renders this block behind "Copy error details" and the user can
 * paste it into a message.
 */
import type { KokoroStatus } from './kokoroPlugin';
import { formatBytes } from './kokoroDownload';

export type KokoroStage = 'status' | 'download' | 'unpack' | 'load' | 'measure' | 'delete';

const STAGE_TEXT: Record<KokoroStage, string> = {
  status: 'reading the model state',
  download: 'downloading the model',
  unpack: 'unpacking the model archive',
  load: 'loading the model into memory',
  measure: 'measuring speech speed',
  delete: 'deleting the model',
};

/** Gerund phrase for a stage, e.g. used in the progress line. */
export function stageLabel(stage: KokoroStage): string {
  return STAGE_TEXT[stage];
}

export interface KokoroFailure {
  stage: KokoroStage;
  /** One-line message for the panel, e.g. "Unpacking the model archive failed: …". */
  message: string;
  /** Multi-line diagnostic text behind "Copy error details". */
  details: string;
}

/** Capacitor rejections carry a `code`; plain errors do not. */
export function errorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const text = err.message.trim();
    return text.length > 0 ? text : err.name;
  }
  const text = String(err).trim();
  if (text.length > 0 && text !== '[object Object]') return text;
  try {
    return JSON.stringify(err) ?? 'unknown error';
  } catch {
    return 'unknown error';
  }
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}

function stateLines(status: KokoroStatus | null | undefined): string[] {
  if (!status) {
    return ['model state: unknown (the status call itself failed)'];
  }
  return [
    `downloaded: ${status.downloaded ? 'yes' : 'no'}`,
    `loaded: ${status.loaded ? 'yes' : 'no'}`,
    `model: ${status.modelId ?? 'kokoro-multi-lang-v1_0'}`,
    `partial download: ${formatBytes(status.partialBytes)}`,
    `free storage: ${formatBytes(status.freeBytes)}`,
    `archive size: ${formatBytes(status.archiveBytes)}`,
    `required free space: ${formatBytes(status.requiredBytes)}`,
  ];
}

function platformLine(): string {
  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  return agent.length > 0 ? `platform: ${agent}` : 'platform: unknown';
}

/**
 * Build the panel message and the copyable diagnostic block for one failure.
 *
 * `at` is injectable so the test can pin the timestamp.
 */
export function describeKokoroFailure(
  stage: KokoroStage,
  err: unknown,
  status?: KokoroStatus | null,
  at: Date = new Date()
): KokoroFailure {
  const text = errorText(err);
  const code = errorCode(err);
  const message = `${capitalize(STAGE_TEXT[stage])} failed: ${text}`;
  const details = [
    'Kokoro on-device error',
    `stage: ${stage} (${STAGE_TEXT[stage]})`,
    `error: ${text}`,
    `code: ${code ?? 'none'}`,
    `time: ${at.toISOString()}`,
    platformLine(),
    ...stateLines(status),
  ].join('\n');
  return { stage, message, details };
}

/** Clipboard write with a fallback for WebViews without the async clipboard API. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the textarea trick */
  }
  if (typeof document === 'undefined') return false;
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(area);
    return copied;
  } catch {
    return false;
  }
}
