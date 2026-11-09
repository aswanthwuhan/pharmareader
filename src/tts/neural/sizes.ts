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

/** Approximate download size of the Kokoro weights per dtype. */
export function kokoroSizeMb(dtype: string): number {
  if (dtype === 'fp32') return 320;
  if (dtype === 'fp16') return 170;
  return 90; // q8 / q4
}
