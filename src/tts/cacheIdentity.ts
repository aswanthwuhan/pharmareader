/**
 * The voice identity that goes into an audio-cache key.
 *
 * Separate from `cache.ts` so the pre-render core, which is pure orchestration with
 * injected cache access, can use it without pulling IndexedDB into its module graph.
 */
import type { TtsEngine } from '../core/types';

/**
 * The voice id to hash, with the engine's cache variant (the voice it will really speak
 * with, and the weight build the clip was rendered from) folded in.
 *
 * Web Kokoro loads one build now, fp32, so `@fp32` no longer separates one render from
 * another — but it stays in the key: that is the shape every clip already on disk was
 * saved under, and dropping it would re-render all of them for no change in the audio.
 * The variant only changes when the audio would: `@chunked` was added when long
 * sentences started being split before the model sees them, because every clip cached
 * before that is missing its last words. (When q8 was a choice, the variants differed
 * because the int8 build played the same voice as babble.) The other half of the
 * variant is the engine's own voice choice: the reader passes the phone voice to every
 * engine, which is no Kokoro or Pocket voice at all, so the id in the request is not
 * the identity of the audio.
 * Engines without a variant keep the plain voice id, so their existing entries stay
 * valid.
 */
export async function cacheVoiceId(
  engine: Pick<TtsEngine, 'cacheVariant'>,
  voiceId: string | undefined
): Promise<string | undefined> {
  const variant = await engine.cacheVariant?.(voiceId);
  if (!variant) return voiceId;
  return `${voiceId ?? ''}@${variant}`;
}
