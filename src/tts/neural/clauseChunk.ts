/**
 * Clause chunking for speech engines.
 *
 * A 40-word sentence is synthesised as one piece of audio, so the listener waits
 * for all of it before hearing anything. Textbook prose is full of long
 * sentences; splitting them at clause boundaries (`, ; : —` and coordinating
 * conjunctions) means the first clause can start playing while the rest is still
 * being synthesised. Only the first chunk is aimed at the short target, so
 * latency drops without multiplying the number of model calls more than needed.
 *
 * Chunks never lose a character: `chunks.join(' ')` equals the input with
 * whitespace collapsed, so the spoken text is unchanged.
 */

/** Sentence length (in words) above which a sentence is split. */
export const DEFAULT_MAX_CHUNK_WORDS = 25;

/** Target length of the first chunk; later chunks grow towards the maximum. */
export const DEFAULT_MIN_CHUNK_WORDS = 7;

export interface ClauseChunkOptions {
  maxWords?: number;
  minWords?: number;
}

/** A cut point after clause punctuation, keeping the punctuation in the chunk. */
const PUNCTUATION_BOUNDARY = /[;:,—–]\s+/g;

/** A cut point before a coordinating/subordinating conjunction. */
const CONJUNCTION_BOUNDARY = /\s+(?=(?:and|but|or|so|because|while|which|although|though|whereas|unless|since)\b)/gi;

export interface PlannedChunk {
  /** Id of the sentence this chunk belongs to. */
  itemId: string;
  text: string;
  /** Playback of the sentence starts with this chunk. */
  first: boolean;
  /** Playback of the sentence ends with this chunk. */
  last: boolean;
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function boundaryCuts(text: string): number[] {
  const cuts = new Set<number>();
  for (const match of text.matchAll(PUNCTUATION_BOUNDARY)) {
    if (match.index !== undefined) cuts.add(match.index + match[0].length);
  }
  for (const match of text.matchAll(CONJUNCTION_BOUNDARY)) {
    if (match.index !== undefined) cuts.add(match.index);
  }
  return [...cuts].filter((cut) => cut > 0 && cut < text.length).sort((a, b) => a - b);
}

function hardWrap(text: string, maxWords: number): string[] {
  const words = text.split(' ');
  // Even pieces: filling to the cap leaves a stub (20 words at 18 -> 18 + 2) that the
  // engine voices as a sentence of its own.
  const size = Math.ceil(words.length / Math.ceil(words.length / maxWords));
  const out: string[] = [];
  for (let start = 0; start < words.length; start += size) {
    out.push(words.slice(start, start + size).join(' '));
  }
  return out;
}

/**
 * Split one sentence into speakable chunks. Sentences at or below `maxWords`
 * come back untouched (as a single chunk), so short text costs nothing extra.
 */
export function splitIntoClauses(text: string, options: ClauseChunkOptions = {}): string[] {
  const maxWords = Math.max(2, Math.round(options.maxWords ?? DEFAULT_MAX_CHUNK_WORDS));
  const minWords = Math.max(1, Math.min(Math.round(options.minWords ?? DEFAULT_MIN_CHUNK_WORDS), maxWords));
  const normalised = text.trim().replace(/\s+/g, ' ');
  if (!normalised) return [];
  if (countWords(normalised) <= maxWords) return [normalised];

  const chunks: string[] = [];
  let start = 0;
  for (const cut of boundaryCuts(normalised)) {
    // The first chunk is kept short so audio can start early; later chunks are
    // allowed to grow, which keeps the number of synthesis calls down.
    const target = chunks.length === 0 ? minWords : maxWords;
    const candidate = normalised.slice(start, cut).trim();
    if (countWords(candidate) >= target) {
      chunks.push(candidate);
      start = cut;
    }
  }

  const tail = normalised.slice(start).trim();
  if (tail) {
    const previous = chunks[chunks.length - 1];
    if (previous !== undefined && countWords(previous) + countWords(tail) <= maxWords) {
      chunks[chunks.length - 1] = `${previous} ${tail}`;
    } else {
      chunks.push(tail);
    }
  }

  return chunks.flatMap((chunk) => (countWords(chunk) > maxWords ? hardWrap(chunk, maxWords) : [chunk]));
}

/**
 * Flatten sentences into the chunk sequence a `speak` loop should follow.
 * Blank sentences are dropped; each chunk remembers whether it opens or closes
 * its sentence so `onStart`/`onEnd` still fire once per sentence.
 */
export function planChunks(
  items: readonly { id: string; text: string }[],
  options: ClauseChunkOptions = {}
): PlannedChunk[] {
  const plan: PlannedChunk[] = [];
  for (const item of items) {
    if (!item.text.trim()) continue;
    const chunks = splitIntoClauses(item.text, options);
    chunks.forEach((text, index) => {
      plan.push({ itemId: item.id, text, first: index === 0, last: index === chunks.length - 1 });
    });
  }
  return plan;
}
