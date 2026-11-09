/**
 * What actually gets spoken, versus what is on screen.
 *
 * A sentence keeps its citations and its parenthetical asides when it is
 * displayed, but a reader listening to a pharmacology chapter does not want to
 * hear "[12]" or "(Smith et al., 2019)" after every claim. Removing them
 * shortens the text, so every remaining character is mapped back to its
 * position in the original sentence: word highlighting and selection offsets
 * keep working on the text the reader sees.
 */

export interface SpeakPlan {
  /** The text handed to the voice. */
  text: string;
  /** `charMap[i]` is the index in the original sentence of `text[i]`, or null when unchanged. */
  charMap: number[] | null;
}

export interface SpeakOptions {
  /** Drop "[12]", "[12, 15]", "(Smith et al., 2019)" and similar. */
  citations: boolean;
  /** Drop every "(" … ")" aside. */
  brackets: boolean;
}

/** `[12]`, `[12, 15]`, `[3–5]`. */
const CITATION_BRACKETS = /\[\s*\d+(?:\s*[,;–-]\s*\d+)*\s*\]/g;
/** `(Smith et al., 2019)`, `(Smith, 2019; Jones & Co., 2020)`. */
const CITATION_YEARS = /\([^()]{0,160}?\b(?:19|20)\d{2}[a-z]?(?:\s*[;,]\s*[^()]{0,160}?\b(?:19|20)\d{2}[a-z]?)*\s*\)/g;
const PARENTHESES = /\([^()]{0,300}?\)/g;

interface Span {
  start: number;
  end: number;
}

function overlaps(spans: Span[], span: Span): boolean {
  return spans.some((other) => span.start < other.end && other.start < span.end);
}

const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?']);

export function speakPlan(text: string, options: SpeakOptions): SpeakPlan {
  if (!options.citations && !options.brackets) return { text, charMap: null };

  const spans: Span[] = [];
  if (options.citations) {
    for (const match of text.matchAll(CITATION_BRACKETS)) {
      const at = match.index ?? 0;
      spans.push({ start: at, end: at + match[0].length });
    }
    for (const match of text.matchAll(CITATION_YEARS)) {
      const at = match.index ?? 0;
      const span = { start: at, end: at + match[0].length };
      if (!overlaps(spans, span)) spans.push(span);
    }
  }
  if (options.brackets) {
    for (const match of text.matchAll(PARENTHESES)) {
      const at = match.index ?? 0;
      const span = { start: at, end: at + match[0].length };
      if (!overlaps(spans, span)) spans.push(span);
    }
  }
  if (spans.length === 0) return { text, charMap: null };
  spans.sort((a, b) => a.start - b.start);

  const out: string[] = [];
  const map: number[] = [];
  let cursor = 0;

  const push = (char: string, at: number) => {
    if (/\s/.test(char)) {
      // Collapse the double space a removed aside leaves behind, and never
      // leave a space in front of punctuation.
      if (out.length === 0) return;
      if (/\s/.test(out[out.length - 1]!)) return;
      out.push(' ');
      map.push(at);
      return;
    }
    if (TRAILING_PUNCTUATION.has(char) && out[out.length - 1] === ' ') {
      out.pop();
      map.pop();
    }
    out.push(char);
    map.push(at);
  };

  for (let i = 0; i < text.length; i++) {
    while (cursor < spans.length && i >= spans[cursor]!.end) cursor++;
    const span = spans[cursor];
    if (span && i >= span.start && i < span.end) continue;
    push(text[i]!, i);
  }

  while (out.length > 0 && out[out.length - 1] === ' ') {
    out.pop();
    map.pop();
  }
  const spoken = out.join('');
  if (spoken === '') return { text, charMap: null };
  return { text: spoken, charMap: map };
}

/** Convenience for callers that only need the shortened text. */
export function spokenText(text: string, options: SpeakOptions): string {
  return speakPlan(text, options).text;
}
