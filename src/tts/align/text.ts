/**
 * Tokenising a sentence and comparing words the way a recogniser hears them.
 *
 * The aligner matches the words of the sentence on screen against the words
 * Whisper transcribed. The two are never identical: the TTS reads the
 * lexicon-expanded text ("t½" → "half-life", "CYP3A4" → "C Y P three A four"),
 * the recogniser writes numbers as digits, drops punctuation and mangles long
 * drug names. So each word is reduced to a key made of letters only, in two
 * numeric forms — digits spelled one by one and digits read as a number — and
 * two keys count as the same word when they are close enough.
 */
import type { WordTiming } from './types';

export interface WordRange {
  charStart: number;
  charEnd: number;
}

/** Words of `text` with their character ranges. */
export function words(text: string): WordRange[] {
  const out: WordRange[] = [];
  for (const m of text.matchAll(/\S+/g)) out.push({ charStart: m.index, charEnd: m.index + m[0].length });
  return out;
}

/**
 * Timing proportional to word length.
 *
 * This is what the reader highlights with when the Whisper model is not
 * installed (and what the aligner falls back to when it cannot hear the clip).
 * It is wrong in the same way for every sentence — it cannot know where a pause
 * or a long drug name sits — but it covers every word inside `durationMs`.
 */
export function estimateTimings(text: string, durationMs: number): WordTiming[] {
  const ws = words(text);
  const total = ws.reduce((n, w) => n + (w.charEnd - w.charStart) + 1, 0);
  const duration = Math.max(0, durationMs);
  let t = 0;
  return ws.map((w) => {
    const share = total > 0 ? ((w.charEnd - w.charStart + 1) / total) * duration : 0;
    const timing = { ...w, startMs: t, endMs: t + share };
    t += share;
    return timing;
  });
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

const ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];

const TENS = ['', 'ten', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** A number as it is read aloud: 42 → "fortytwo", 1005 → "onethousandfive". */
function numberWords(n: number): string {
  if (n < 20) return ONES[n] ?? '';
  if (n < 100) return (TENS[Math.floor(n / 10)] ?? '') + (n % 10 ? ONES[n % 10] : '');
  if (n < 1000) {
    return (ONES[Math.floor(n / 100)] ?? '') + 'hundred' + (n % 100 ? numberWords(n % 100) : '');
  }
  if (n < 1_000_000) {
    return numberWords(Math.floor(n / 1000)) + 'thousand' + (n % 1000 ? numberWords(n % 1000) : '');
  }
  return digitWords(String(n));
}

/** Digits one by one: 42 → "fourtwo", 3.5 → "threepointfive". */
function digitWords(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch >= '0' && ch <= '9') out += ONES[ch.charCodeAt(0) - 48];
    else if (ch === '.' || ch === ',') out += 'point';
  }
  return out;
}

/**
 * Symbols the recogniser may write as a word (or the other way round). Applied
 * before digits so "½" and "0.5" can both reach "half" and "zeropointfive".
 */
const SYMBOLS: [RegExp, string][] = [
  [/½/g, ' half '],
  [/¼/g, ' quarter '],
  [/¾/g, ' threequarters '],
  [/æ/g, 'ae'],
  [/œ/g, 'oe'],
  [/ß/g, 'ss'],
  [/ø/g, 'o'],
  [/ł/g, 'l'],
  [/&/g, ' and '],
  [/%/g, ' percent '],
  [/\+/g, ' plus '],
  [/=/g, ' equals '],
  [/@/g, ' at '],
  [/§/g, ' section '],
];

/**
 * Units the text abbreviates and the voice reads out in full — and the reverse,
 * when the recogniser writes what it heard. Applied as whole tokens, so "mg" in
 * "5 mg" becomes "milligram" but "mg" inside another word is left alone.
 */
const ABBREVIATIONS: [string, string][] = [
  ['mcg', 'microgram'],
  ['mg', 'milligram'],
  ['ml', 'millilitre'],
  ['mmol', 'millimole'],
  ['kg', 'kilogram'],
  ['iu', 'unit'],
  ['hr', 'hour'],
  ['min', 'minute'],
];

function base(text: string): string {
  let s = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  for (const [re, replacement] of SYMBOLS) s = s.replace(re, replacement);
  for (const [short, full] of ABBREVIATIONS) s = s.replace(new RegExp(`\\b${short}\\b`, 'g'), full);
  // "1,000" is one thousand, not a decimal: drop the grouping comma.
  return s.replace(/(\d),(\d{3})\b/g, '$1$2');
}

/**
 * The two comparable keys of a word: digits spelled out one by one, and digits
 * read as a number. "10" is "onezero" in one and "ten" in the other, so a
 * transcript that wrote "10" matches a text that spelled "ten" and the reverse.
 */
export function keyForms(text: string): [string, string] {
  const s = base(text);
  const spelled = s.replace(/(\d+)(?:\.(\d+))?/g, (whole) => digitWords(whole));
  const valued = s.replace(/(\d+)(?:\.(\d+))?/g, (whole) => {
    if (whole.includes('.')) return digitWords(whole);
    const n = Number(whole);
    return Number.isSafeInteger(n) ? numberWords(n) : digitWords(whole);
  });
  return [spelled.replace(/[^a-z]/g, ''), valued.replace(/[^a-z]/g, '')];
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const sub = (prev[j - 1] ?? 0) + (ca === b.charCodeAt(j - 1) ? 0 : 1);
      const del = (prev[j] ?? 0) + 1;
      const ins = (cur[j - 1] ?? 0) + 1;
      cur[j] = Math.min(sub, del, ins);
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return prev[b.length] ?? 0;
}

/** 0..1 similarity of two keys, best pairing of their numeric forms. */
export function similarity(a: readonly string[], b: readonly string[]): number {
  let best = 0;
  for (const x of a) {
    for (const y of b) {
      if (!x || !y) continue;
      if (x === y) return 1;
      const score = 1 - levenshtein(x, y) / Math.max(x.length, y.length);
      if (score > best) best = score;
    }
  }
  return best;
}

/** Concat of keys: "CYP3A4" against the group "C Y P three A four" is compared as one word. */
export function joinKeys(keys: readonly (readonly string[])[]): string[] {
  const out = keys.length > 0 ? keys[0].map(() => '') : [];
  for (const key of keys) for (let f = 0; f < out.length; f++) out[f] += key[f] ?? '';
  return out;
}
