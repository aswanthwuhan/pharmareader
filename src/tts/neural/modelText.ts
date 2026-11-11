/**
 * Text splitting that keeps a Kokoro synthesis inside the model's input window.
 *
 * `kokoro-js` tokenizes with `truncation: true` (510 phoneme tokens), so handing
 * it a whole sentence means everything past that limit is dropped before the
 * model sees it: the audio simply stops there and the listener hears the voice
 * trail off, mumble, or lose its last words. Measured on the fp32 model, a
 * 110-word sentence rendered 26.45 s while the same text in two halves rendered
 * 31.85 s — 5.4 s (17%) of it was never synthesised.
 *
 * The budgets are measured against the same eSpeak build kokoro-js uses, over
 * every long sentence in the pharmacology books plus the worst cases from the
 * first sweep (17 504 sentences, 19 464 pieces):
 * prose costs ~1.2 tokens per character, but a *digit* becomes a whole number
 * word and a URL is spelled letter by letter, so a character cap alone is not
 * safe. At 380 characters a chunk of OCR'd number columns measured 1 546 tokens
 * and a 378-character line of reference URLs 716, both silently losing their
 * endings — the very bug this file exists to fix. With the budgets below the
 * worst piece measured 594 tokens and only 2 of the 19 464 pieces were over the
 * window; both are the same reference line of URLs, which no character budget
 * separates from prose because every letter of it is spelled out.
 *
 * The native Kokoro engine and Pocket split sentences with `clauseChunk`; the
 * web engine had no splitting at all, which is why only the web build trailed
 * off at the end of long sentences.
 */
import { splitIntoClauses } from './clauseChunk';

/** Phoneme tokens one `generate()` call can hold; kokoro-js truncates at 510. */
export const MODEL_TOKEN_LIMIT = 510;

/**
 * Characters per chunk. 320 characters of prose is ~390 tokens, which leaves
 * room for long drug names and Greek letters; 380 was too long (see above).
 */
export const MAX_CHUNK_CHARS = 320;

/**
 * Digits per chunk. A digit is not one token: espeak reads "11121314" as a string
 * of number words, so eight characters can cost forty tokens. Digit runs are what
 * put the measured 380-character chunks over the window, so they get their own
 * budget instead of being counted as ordinary characters.
 */
export const MAX_CHUNK_DIGITS = 16;

/** Words per chunk. Drug names cost far more tokens per word than prose does. */
export const MAX_CHUNK_WORDS = 40;

/**
 * Words per chunk on WebGPU. The same fp32 model turns breathy partway through a
 * long call on WebGPU but not on WASM or CPU: measured on one 54-word sentence
 * (Intel Gen12, Chrome), voiced share fell from 59% in the first quarter of the
 * clip to 19-31% in the back half, while WASM stayed at 58-67% throughout. The
 * vocoder drives the voice with sin() of a phase that grows through the clip, and
 * GPU sin() loses precision on large arguments. Through the app's own splitter,
 * a second sentence ended at 53% voiced on WASM, 43% with 12-word pieces on
 * WebGPU and 51% with 10-word pieces, so 10 is the largest budget that matches.
 */
export const WEBGPU_MAX_CHUNK_WORDS = 10;

/** Kokoro's own rate; only used when there is nothing to generate (blank text). */
const KOKORO_SAMPLE_RATE = 24000;

function countDigits(text: string): number {
  let count = 0;
  for (const ch of text) if (ch >= '0' && ch <= '9') count++;
  return count;
}

/** Whether the model can hold `chunk` in one call. */
export function fitsModelWindow(chunk: string): boolean {
  return chunk.length <= MAX_CHUNK_CHARS && countDigits(chunk) <= MAX_CHUNK_DIGITS;
}

/**
 * Wrap a chunk whose words alone outrun the budgets, never splitting a word: a
 * cut inside a word is unpronounceable, while a cut between words is a breath.
 * A single word longer than the budget is kept whole (no English word is).
 */
function wrapByBudget(chunk: string): string[] {
  if (fitsModelWindow(chunk)) return [chunk];
  const parts: string[] = [];
  let current = '';
  for (const word of chunk.split(' ')) {
    if (current === '') current = word;
    else if (fitsModelWindow(`${current} ${word}`)) current = `${current} ${word}`;
    else {
      parts.push(current);
      current = word;
    }
  }
  if (current !== '') parts.push(current);
  return parts;
}

/**
 * Split one sentence into pieces the model can hold. A sentence that already
 * fits comes back untouched, so short text costs nothing extra.
 *
 * Chunks are filled towards the word budget rather than shortened: the web
 * engine synthesises a whole sentence before it plays any of it, so a short
 * first chunk wins no latency (unlike the streaming native engine), while every
 * extra chunk is another model call. Half a budget still lets a comma early in
 * a long sentence become the seam instead of a mid-clause wrap.
 */
export function splitForModel(text: string, maxWords: number = MAX_CHUNK_WORDS): string[] {
  const normalised = text.trim().replace(/\s+/g, ' ');
  if (normalised === '') return [];
  const clauses = splitIntoClauses(normalised, { maxWords, minWords: maxWords / 2 });
  return clauses.flatMap(wrapByBudget);
}

/** One generated piece and the sample rate it came back at. */
export interface PieceAudio {
  audio: Float32Array;
  sampleRate: number;
}

/**
 * Generate `text` piece by piece, in order, and hand back the pieces.
 *
 * `cancelled()` is checked between pieces: a stopped utterance must not spend
 * seconds synthesising audio nobody will hear, and the caller must post
 * `stopped` rather than a result — a result for a superseded request plays over
 * the sentence that replaced it. Returns `null` when it was cancelled.
 */
export async function generateInPieces(
  text: string,
  generate: (piece: string) => Promise<PieceAudio>,
  cancelled: () => boolean = () => false,
  maxWords: number = MAX_CHUNK_WORDS
): Promise<{ parts: Float32Array[]; sampleRate: number } | null> {
  const parts: Float32Array[] = [];
  let sampleRate = KOKORO_SAMPLE_RATE;
  for (const piece of splitForModel(text, maxWords)) {
    const generated = await generate(piece);
    parts.push(generated.audio);
    sampleRate = generated.sampleRate;
    if (cancelled()) return null;
  }
  return { parts, sampleRate };
}
