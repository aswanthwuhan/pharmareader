/**
 * Real-time factor: how many seconds of compute one second of audio costs.
 * `rtf < 1` means the engine synthesises faster than the audio plays, which is
 * exactly the condition needed for streaming a sentence before the previous
 * one finishes. Slow phones fail this and must fall back to pre-rendering.
 */
import { setSetting } from '../../core/settings';
import type { TtsEngine } from '../../core/types';
import { audioDurationMs } from './wav';

/** Roughly 20 words of typical pharmacology prose. */
export const BENCHMARK_TEXT =
  'Metformin hydrochloride extended-release tablets should be swallowed whole with a full glass of water, with the evening meal, to reduce gastrointestinal upset.';

export interface RtfResult {
  engineId: string;
  /** Synthesis seconds per audio second. */
  rtf: number;
  synthMs: number;
  audioMs: number;
}

export function rtfSettingKey(engineId: string): string {
  return `tts.rtf.${engineId}`;
}

/**
 * Synthesize the benchmark sentence once as a warm-up (first call pays model
 * init + shader compile), then time a second run and divide by its audio
 * duration. The result is persisted for the settings panel.
 */
export async function measureRtf(
  engine: TtsEngine,
  opts: { voiceId?: string; rate?: number } = {}
): Promise<RtfResult> {
  if (!engine.synthesize) {
    throw new Error(`${engine.label} cannot synthesize audio for measurement`);
  }
  const synth = engine.synthesize.bind(engine);
  const options = { voiceId: opts.voiceId, rate: opts.rate ?? 1 };

  await synth(BENCHMARK_TEXT, options); // warm-up: JIT, shaders, voice styles

  const started = performance.now();
  const blob = await synth(BENCHMARK_TEXT, options);
  const synthMs = performance.now() - started;

  const audioMs = await audioDurationMs(blob);
  if (!(audioMs > 0)) throw new Error('Could not determine the duration of the synthesised audio');

  const result: RtfResult = {
    engineId: engine.id,
    rtf: synthMs / audioMs,
    synthMs: Math.round(synthMs),
    audioMs,
  };
  await setSetting(rtfSettingKey(engine.id), round(result.rtf));
  return result;
}

export function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** The line shown under "Measure speed". */
export function rtfVerdict(rtf: number): string {
  if (!Number.isFinite(rtf) || rtf <= 0) return 'Speed not measured';
  return rtf < 1
    ? 'Faster than real-time ✓'
    : 'Slower than real-time — use pre-render or system voice';
}
