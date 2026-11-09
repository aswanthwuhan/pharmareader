/**
 * Failures of the read-along aligner, with the step they happened in.
 *
 * The reader can carry on with the estimate when alignment fails, so the only
 * place the detail surfaces is the settings panel — where "Failed to fetch" and
 * "no available backend found" must not look the same.
 */
export type AlignStage =
  | 'worker'
  | 'files'
  | 'decode'
  | 'transcribe';

export const ALIGN_STAGES: Record<AlignStage, string> = {
  worker: 'starting the aligner worker',
  files: 'downloading the aligner model',
  decode: 'decoding the clip',
  transcribe: 'listening to the clip',
};

export function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

export class AlignError extends Error {
  readonly stage: AlignStage;
  readonly cause?: unknown;

  constructor(stage: AlignStage, cause: unknown) {
    super(messageOf(cause), { cause });
    this.name = 'AlignError';
    this.stage = stage;
    this.cause = cause;
  }
}

/** Wrap `cause` unless it already carries a stage. */
export function alignError(stage: AlignStage, cause: unknown): AlignError {
  if (cause instanceof AlignError) return cause;
  return new AlignError(stage, cause);
}

function causeChain(err: unknown): string[] {
  const out: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    if (current instanceof Error) {
      out.push(current.stack ?? `${current.name}: ${current.message}`);
      current = (current as { cause?: unknown }).cause;
    } else {
      out.push(String(current));
      break;
    }
  }
  return out;
}

export interface AlignErrorInfo {
  stage: string;
  message: string;
  details: string;
}

export function describeAlignError(err: unknown): AlignErrorInfo {
  const stage = err instanceof AlignError ? ALIGN_STAGES[err.stage] : 'unknown stage';
  const message = messageOf(err);
  const lines = [
    'engine: whisper (on-device aligner)',
    `stage: ${stage}`,
    `message: ${message}`,
    `when: ${new Date().toISOString()}`,
  ];
  if (typeof navigator !== 'undefined' && navigator.userAgent) lines.push(`user agent: ${navigator.userAgent}`);
  const chain = causeChain(err);
  if (chain.length > 0) lines.push('', '--- stack ---', ...chain);
  return { stage, message, details: lines.join('\n') };
}
