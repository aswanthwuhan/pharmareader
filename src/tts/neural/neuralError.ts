/**
 * Errors that reach the user from the on-device engines.
 *
 * "Pocket TTS also not working" was the whole bug report we got from a phone:
 * the panel only had a bare `message`, so a failed 127 MB download, a missing
 * WASM runtime and a silent empty generation all looked the same. Every failure
 * the engines raise now carries the stage it happened in, and the panel can show
 * (and copy) the full technical detail.
 */
export type NeuralEngineId = 'pocket' | 'kokoro';

export interface NeuralErrorInfo {
  engine: NeuralEngineId;
  stage: string;
  /** One-line, human readable (what the panel shows first). */
  message: string;
  /** Stage + message + stack/cause chain — what "Copy error details" puts on the clipboard. */
  details: string;
}

export const NEURAL_STAGES = {
  worker: 'starting the model worker',
  files: 'downloading model files',
  voices: 'downloading the built-in voices',
  model: 'loading the model into memory',
  synth: 'synthesising speech',
  play: 'playing audio',
} as const;

export class NeuralError extends Error {
  readonly engine: NeuralEngineId;
  readonly stage: string;
  readonly cause?: unknown;

  constructor(engine: NeuralEngineId, stage: string, cause: unknown) {
    super(messageOf(cause), { cause });
    this.name = 'NeuralError';
    this.engine = engine;
    this.stage = stage;
    this.cause = cause;
  }
}

/** Wrap `cause` (unless it already carries a stage) with the engine + stage it failed in. */
export function neuralError(engine: NeuralEngineId, stage: string, cause: unknown): NeuralError {
  if (cause instanceof NeuralError) return cause;
  return new NeuralError(engine, stage, cause);
}

export function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

function causeChain(err: unknown): string[] {
  const out: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    if (current instanceof Error) {
      if (current.stack) out.push(current.stack);
      else out.push(`${current.name}: ${current.message}`);
      current = (current as { cause?: unknown }).cause;
    } else {
      out.push(String(current));
      break;
    }
  }
  return out;
}

/** Everything the panel (and a bug report) needs about a failure. */
export function describeNeuralError(engine: NeuralEngineId, err: unknown): NeuralErrorInfo {
  const stage = err instanceof NeuralError ? err.stage : 'unknown stage';
  const message = messageOf(err);
  const lines = [
    `engine: ${engine}`,
    `stage: ${stage}`,
    `message: ${message}`,
    `when: ${new Date().toISOString()}`,
  ];
  if (typeof navigator !== 'undefined' && navigator.userAgent) lines.push(`user agent: ${navigator.userAgent}`);
  const chain = causeChain(err);
  if (chain.length > 0) lines.push('', '--- stack ---', ...chain);
  return { engine, stage, message, details: lines.join('\n') };
}
