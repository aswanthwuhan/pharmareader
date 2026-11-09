import type { Sentence } from '../core/types';

/**
 * Sentence segmentation for English pharma text.
 *
 * `Intl.Segmenter` gets most boundaries right, but it ends a sentence after
 * abbreviations ("i.v.", "Dr.", "approx.") and after dotted initials, which
 * would make TTS speak half-sentences. Those splits are merged back here.
 */

const SEGMENTER = new Intl.Segmenter('en', { granularity: 'sentence' });

/** Lowercase abbreviation tokens (trailing dot stripped) that never end a sentence. */
const ABBREVIATIONS = new Set([
  'dr', 'mr', 'mrs', 'ms', 'prof', 'vs', 'fig', 'figs', 'no', 'nos', 'approx', 'ca', 'cf',
  'eg', 'ie', 'al', 'mg', 'ml', 'kg', 'mcg', 'ug', 'hr', 'hrs', 'min', 'sec', 'vol', 'ch',
  'chap', 'ref', 'eq', 'tab', 'table', 'pp', 'st', 'etc', 'inc', 'ltd', 'co', 'jr', 'sr',
  'dept', 'univ', 'hosp', 'wt', 'temp', 'yr', 'yrs', 'mo',
]);

export interface TextSpan {
  text: string;
  /** Offset of `text` in the source string (leading whitespace excluded). */
  index: number;
}

/** Split `text` into trimmed sentence spans, keeping each sentence's source offset. */
export function segmentText(text: string): TextSpan[] {
  const parts = [...SEGMENTER.segment(text)];
  const spans: TextSpan[] = [];
  let raw = '';
  let start = 0;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!raw) start = part.index;
    raw += part.segment;
    const next = parts[i + 1];
    if (next && continuesAfter(raw, next.segment)) continue;
    pushSpan(spans, raw, start);
    raw = '';
  }

  return spans;
}

export function splitSentences(text: string): string[] {
  return segmentText(text).map((span) => span.text);
}

/** Sentences of one block, with deterministic ids `${chapterIdx}-${blockIdx}-${sentIdx}`. */
export function makeSentences(text: string, chapterIdx: number, blockIdx: number): Sentence[] {
  return splitSentences(text.replace(/\s+/g, ' '))
    .filter((s) => /[\p{L}\p{N}]/u.test(s))
    .map((s, i) => ({ id: `${chapterIdx}-${blockIdx}-${i}`, text: s }));
}

/** True when the boundary between `raw` and `next` is not a real sentence end. */
function continuesAfter(raw: string, next: string): boolean {
  const text = raw.trimEnd();
  if (!text.endsWith('.')) return false;

  // "2." + "5 mg" is the middle of a decimal, not a boundary.
  if (/\d\.$/.test(text) && /^\s*\d/.test(next)) return true;

  const word = lastWord(text);
  // Dotted abbreviations and initials: i.v., p.o., b.i.d., U.S., e.g., i.e.
  if (/^(?:[a-z]{1,2}\.){2,}$/i.test(word)) return true;

  return ABBREVIATIONS.has(word.replace(/\.$/, '').toLowerCase());
}

function lastWord(text: string): string {
  return (/\S+$/.exec(text)?.[0] ?? '').replace(/^[([{"'“‘]+/, '');
}

function pushSpan(out: TextSpan[], raw: string, index: number): void {
  const text = raw.trim();
  if (!text) return;
  out.push({ text, index: index + (raw.length - raw.trimStart().length) });
}
