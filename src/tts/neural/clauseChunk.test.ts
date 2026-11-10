import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_CHUNK_WORDS,
  countWords,
  planChunks,
  splitIntoClauses,
} from './clauseChunk';

const words = (n: number, word = 'word'): string => Array.from({ length: n }, () => word).join(' ');

/** Joining the chunks must reproduce the sentence with whitespace collapsed. */
const flatten = (text: string): string => text.trim().replace(/\s+/g, ' ');

describe('splitIntoClauses', () => {
  it('returns nothing for blank text', () => {
    expect(splitIntoClauses('')).toEqual([]);
    expect(splitIntoClauses('   \n ')).toEqual([]);
  });

  it('leaves a short sentence alone', () => {
    const text = 'The heart pumps blood.';
    expect(splitIntoClauses(text)).toEqual([text]);
  });

  it('leaves a sentence at the limit alone', () => {
    const text = `${words(DEFAULT_MAX_CHUNK_WORDS - 1)} ending.`;
    expect(splitIntoClauses(text)).toEqual([text]);
  });

  it('splits a long sentence at a comma, keeping the comma', () => {
    const text =
      'The heart pumps blood through the body without resting, and the lungs add oxygen to that blood before it returns to the heart again, so the cycle can start over.';
    const chunks = splitIntoClauses(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toBe('The heart pumps blood through the body without resting,');
    expect(chunks.join(' ')).toBe(flatten(text));
  });

  it('never loses or reorders characters', () => {
    const text =
      'During systole the ventricles contract; during diastole they relax: the cycle then repeats — because pressure gradients, not the heart alone, keep blood moving through the circulation.';
    const chunks = splitIntoClauses(text, { maxWords: 10, minWords: 4 });
    expect(chunks.join(' ')).toBe(flatten(text));
    expect(chunks.every((chunk) => countWords(chunk) <= 10)).toBe(true);
  });

  it('splits at a conjunction when there is no punctuation', () => {
    const text = `${words(9, 'alpha')} and ${words(9, 'beta')} but ${words(9, 'gamma')} so ${words(9, 'delta')}`;
    const chunks = splitIntoClauses(text, { maxWords: 12, minWords: 6 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(' ')).toBe(flatten(text));
    expect(chunks[0].startsWith('alpha')).toBe(true);
  });

  it('has a short first chunk and larger later chunks', () => {
    const clauses = [
      words(6, 'one'),
      words(10, 'two'),
      words(10, 'three'),
      words(10, 'four'),
      words(10, 'five'),
    ];
    const text = clauses.join(', ') + '.';
    const chunks = splitIntoClauses(text, { maxWords: 20, minWords: 6 });
    expect(countWords(chunks[0])).toBeLessThanOrEqual(6);
    expect(chunks.slice(1).every((chunk) => countWords(chunk) <= 20)).toBe(true);
    expect(chunks.join(' ')).toBe(flatten(text));
  });

  it('hard-wraps a sentence with no boundaries at all', () => {
    const text = `${words(30)} end`;
    const chunks = splitIntoClauses(text, { maxWords: 10, minWords: 5 });
    expect(chunks).toHaveLength(4);
    expect(chunks.every((chunk) => countWords(chunk) <= 10)).toBe(true);
    expect(chunks.join(' ')).toBe(flatten(text));
  });

  it('merges a short tail instead of leaving a stub', () => {
    const text = `${words(20, 'lead')}, ${words(20, 'mid')}, ok`;
    const chunks = splitIntoClauses(text, { maxWords: 25, minWords: 5 });
    expect(chunks[chunks.length - 1].endsWith('ok')).toBe(true);
    expect(countWords(chunks[chunks.length - 1])).toBeGreaterThan(2);
    expect(chunks.join(' ')).toBe(flatten(text));
  });
});

describe('planChunks', () => {
  it('drops blank sentences and marks the first and last chunk of each', () => {
    const items = [
      { id: 'a', text: '' },
      { id: 'b', text: 'Short one.' },
      {
        id: 'c',
        text: 'The atria fill while the ventricles relax, and then the valves snap shut: this is the first heart sound that a stethoscope picks up.',
      },
    ];
    const plan = planChunks(items, { maxWords: 12, minWords: 6 });
    expect(plan.some((chunk) => chunk.itemId === 'a')).toBe(false);

    const b = plan.filter((chunk) => chunk.itemId === 'b');
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ text: 'Short one.', first: true, last: true });

    const c = plan.filter((chunk) => chunk.itemId === 'c');
    expect(c.length).toBeGreaterThan(1);
    expect(c[0].first).toBe(true);
    expect(c[0].last).toBe(false);
    expect(c[c.length - 1].last).toBe(true);
    expect(c.filter((chunk) => chunk.first)).toHaveLength(1);
    expect(c.filter((chunk) => chunk.last)).toHaveLength(1);
  });

  it('returns an empty plan for empty input', () => {
    expect(planChunks([])).toEqual([]);
    expect(planChunks([{ id: 'a', text: '   ' }])).toEqual([]);
  });
});
