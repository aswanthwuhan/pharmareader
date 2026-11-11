/**
 * Download sizes, in bytes, of the on-device models.
 *
 * Kept in their own module (no imports) because the workers need them for the
 * progress bar, and importing `models.ts` there would pull IndexedDB/dexie into
 * a Worker bundle that only needs a number.
 */

/**
 * Pocket TTS INT8: 4 graphs (16.4 + 76.3 + 10 + 22.7 MB) + bundle/tokenizer +
 * `voices.bin` (52 MB, warmed by `prepare()`), measured from the real download.
 */
export const POCKET_SIZE_MB = 180;

/**
 * Download size of the Kokoro weights, in MB.
 *
 * The fp32 export is the only build the web engine loads (the int8 one played gibberish),
 * so this is one number whatever the caller passes: `kokoro.worker.ts` forwards the dtype
 * it was initialised with and the answer does not depend on it.
 */
export function kokoroSizeMb(_dtype?: string): number {
  return 320;
}
