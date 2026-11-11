import { describe, expect, it } from 'vitest';
import {
  fitsModelWindow,
  generateInPieces,
  MAX_CHUNK_CHARS,
  MAX_CHUNK_DIGITS,
  MAX_CHUNK_WORDS,
  MODEL_TOKEN_LIMIT,
  splitForModel,
} from './modelText';

const flatten = (text: string): string => text.trim().replace(/\s+/g, ' ');
const words = (n: number, word = 'word'): string => Array.from({ length: n }, () => word).join(' ');

const countWords = (text: string): number => text.split(' ').length;
const countDigits = (text: string): number => (text.match(/[0-9]/g) ?? []).length;

/**
 * A sentence of the length the bug needs. Kokoro counts phoneme tokens, not words,
 * so only text past ~510 tokens is ever cut — and a real 110-word Katzung sentence
 * is already past it: rendered whole it measured 26.45 s against 32.05 s for the
 * same text split into pieces, so 5.6 s of speech was never synthesised. This is
 * the synthetic version of that case.
 */
const LONG_SENTENCE =
  'A drug that is absorbed slowly from the gut, which is common for sustained-release tablets and for ' +
  'compounds that are poorly water soluble, reaches its peak plasma concentration later and often lower ' +
  'than the same dose given as an immediate-release tablet, so the clinician who changes the formulation ' +
  'must also change the dosing interval and recheck the plasma concentration after a week of therapy ' +
  'because the trough concentration that was safe with one tablet may now be subtherapeutic with another.';

describe('splitForModel', () => {
  it('returns nothing for blank text', () => {
    expect(splitForModel('')).toEqual([]);
    expect(splitForModel('   \n ')).toEqual([]);
  });

  it('leaves a short sentence alone so nothing costs an extra model call', () => {
    const text = 'Resistance is mediated by beta-lactamase enzymes.';
    expect(splitForModel(text)).toEqual([text]);
  });

  it('keeps every word of a sentence the model cannot hold at once', () => {
    const chunks = splitForModel(LONG_SENTENCE);
    expect(chunks.length).toBeGreaterThan(1);
    // Nothing may be dropped: the model sounds like it trails off precisely
    // because kokoro-js truncates at 510 tokens instead of the app splitting.
    expect(chunks.join(' ')).toBe(flatten(LONG_SENTENCE));
  });

  it('keeps every chunk inside the model window budgets', () => {
    for (const chunk of splitForModel(LONG_SENTENCE)) {
      expect(countWords(chunk)).toBeLessThanOrEqual(MAX_CHUNK_WORDS);
      expect(chunk.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
      expect(countDigits(chunk)).toBeLessThanOrEqual(MAX_CHUNK_DIGITS);
      expect(fitsModelWindow(chunk)).toBe(true);
    }
  });

  it('splits at a clause boundary when one is available', () => {
    const text = `${words(20)},\n${words(30)}.`;
    const chunks = splitForModel(text);
    expect(chunks.length).toBeGreaterThan(1);
    // The comma stays at the end of the chunk it closes, so the seam is a
    // natural one for espeak instead of a mid-clause wrap.
    expect(chunks[0]!.endsWith(',')).toBe(true);
    expect(chunks.join(' ')).toBe(flatten(text));
  });

  it('wraps by characters when a few long words outrun the character budget', () => {
    const text = Array.from({ length: 30 }, () => 'thrombocytopenia').join(' ');
    expect(text.length).toBeGreaterThan(MAX_CHUNK_CHARS);
    const chunks = splitForModel(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    expect(chunks.join(' ')).toBe(text);
  });

  it('budgets digits on their own, because a digit is a word to espeak', () => {
    // 380 characters of OCR'd number columns measured 1546 phoneme tokens: eight
    // characters ("11121314") can cost forty tokens, so characters alone cannot
    // bound a chunk. Every measured number-heavy chunk was cut by this budget.
    const text = Array.from({ length: 20 }, (_, i) => `0${i}6.25`).join(' ');
    expect(countDigits(text)).toBeGreaterThan(MAX_CHUNK_DIGITS);
    const chunks = splitForModel(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(countDigits(chunk)).toBeLessThanOrEqual(MAX_CHUNK_DIGITS);
      expect(chunk.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    }
    expect(chunks.join(' ')).toBe(flatten(text));
  });

  it('documents the limit it exists to stay under', () => {
    // kokoro-js calls its tokenizer with `truncation: true`; 510 is that window.
    expect(MODEL_TOKEN_LIMIT).toBe(510);
  });
});

describe('generateInPieces', () => {
  it('generates every piece once, in order, and reports the rate of the last one', async () => {
    const seen: string[] = [];
    const result = await generateInPieces(LONG_SENTENCE, async (piece) => {
      seen.push(piece);
      return { audio: new Float32Array([seen.length]), sampleRate: 24000 + seen.length };
    });
    expect(seen).toEqual(splitForModel(LONG_SENTENCE));
    expect(result!.parts).toHaveLength(seen.length);
    expect(result!.sampleRate).toBe(24000 + seen.length);
  });

  it('stops between pieces once cancelled, so a stop costs one model call', async () => {
    let calls = 0;
    const result = await generateInPieces(
      LONG_SENTENCE,
      async () => {
        calls += 1;
        return { audio: new Float32Array(1), sampleRate: 24000 };
      },
      () => calls >= 2
    );
    // A cancelled utterance must post `stopped`, never a result: a late result
    // plays over the sentence that replaced it.
    expect(result).toBeNull();
    expect(calls).toBe(2);
  });

  it('never calls the model for blank text', async () => {
    let calls = 0;
    const result = await generateInPieces('   ', async () => {
      calls += 1;
      return { audio: new Float32Array(1), sampleRate: 24000 };
    });
    expect(result).toEqual({ parts: [], sampleRate: 24000 });
    expect(calls).toBe(0);
  });
});
