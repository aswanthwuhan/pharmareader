/**
 * The voice identity that goes into an audio-cache key.
 *
 * Separate from `cache.ts` so the pre-render core, which is pure orchestration with
 * injected cache access, can use it without pulling IndexedDB into its module graph.
 */
import type { TtsEngine } from '../core/types';

/**
 * The voice id to hash, with the engine's cache variant (Kokoro: the weight
 * precision) folded in.
 *
 * The q8 build and the fp32 build render the same voice differently — the int8 one
 * babbles — so a clip made with one precision must not be replayed after switching
 * to the other. Engines without a variant keep the plain voice id, so their existing
 * entries stay valid.
 */
export async function cacheVoiceId(
  engine: Pick<TtsEngine, 'cacheVariant'>,
  voiceId: string | undefined
): Promise<string | undefined> {
  const variant = await engine.cacheVariant?.();
  if (!variant) return voiceId;
  return `${voiceId ?? ''}@${variant}`;
}
