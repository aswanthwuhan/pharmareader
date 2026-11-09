/**
 * Download size of the Whisper aligner, in its own module (no imports) because
 * the model worker needs it for the progress bar and importing the model
 * bookkeeping there would pull IndexedDB into the Worker bundle.
 */

/**
 * `whisper-tiny.en_timestamped` q8: encoder 9.6 MB + merged decoder 29.3 MB +
 * tokenizer/config ≈ 42 MB. Measured from the real download.
 */
export const WHISPER_SIZE_MB = 42;

export const WHISPER_SIZE_BYTES = WHISPER_SIZE_MB * 1024 * 1024;
