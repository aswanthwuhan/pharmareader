/**
 * What actually gets spoken, versus what is on screen.
 *
 * A sentence keeps its citations and its parenthetical asides when it is
 * displayed, but a reader listening to a pharmacology chapter does not want to
 * hear "[12]" or "(Smith et al., 2019)" after every claim. Bracketed text is a
 * special case: dropping "(ANS)" loses information, so by default the aside is
 * set off by pauses ("… nervous system, ANS, controls …"): the listener hears it
 * as an aside without the voice saying "bracket" every few seconds.
 *
 * Whatever is changed, every remaining character is mapped back to its position
 * in the original sentence: word highlighting and selection offsets keep
 * working on the text the reader sees.
 */

/** How bracketed asides are spoken. */
export type BracketMode = 'pause' | 'announce' | 'read' | 'skip';

export interface SpeakPlan {
  /** The text handed to the voice. */
  text: string;
  /** `charMap[i]` is the index in the original sentence of `text[i]`, or null when unchanged. */
  charMap: number[] | null;
}

export interface SpeakOptions {
  /** Drop "[12]", "[12, 15]", "(Smith et al., 2019)" and similar. */
  citations: boolean;
  /**
   * What to do with bracketed asides, e.g. "(ANS)" or "(a cardiac glycoside)".
   * `pause` sets them off with commas (a short pause each side, no extra words),
   * `announce` says "in brackets" once before them, `read` leaves them as written
   * and `skip` drops them.
   */
  brackets: BracketMode;
}

/** `[12]`, `[12, 15]`, `[3–5]`. */
const CITATION_BRACKETS = /\[\s*\d+(?:\s*[,;–-]\s*\d+)*\s*\]/g;
/** `(Smith et al., 2019)`, `(Smith, 2019; Jones & Co., 2020)`. */
const CITATION_YEARS = /\([^()]{0,160}?\b(?:19|20)\d{2}[a-z]?(?:\s*[;,]\s*[^()]{0,160}?\b(?:19|20)\d{2}[a-z]?)*\s*\)/g;

interface Span {
  start: number;
  end: number;
}

interface Group extends Span {
  innerStart: number;
  innerEnd: number;
  /** Contains another bracketed aside, or an unclosed opener: read it as is. */
  nested: boolean;
}

function overlaps(spans: Span[], span: Span): boolean {
  return spans.some((other) => span.start < other.end && other.start < span.end);
}

const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?']);

/**
 * Balanced "(" … ")" and "[" … "]" groups, outermost first.
 *
 * A group containing another group, and any unbalanced opener, is marked
 * `nested` and left untouched: mangling "(a (b) c)" would be worse than reading
 * it as written, and a sentence can always be cut mid-bracket by the parser.
 */
function bracketGroups(text: string): Group[] {
  const pairs: Group[] = [];
  const stack: { char: string; at: number }[] = [];

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (char === '(' || char === '[') {
      stack.push({ char, at: i });
      continue;
    }
    if (char !== ')' && char !== ']') continue;
    const want = char === ')' ? '(' : '[';
    let depth = stack.length - 1;
    while (depth >= 0 && stack[depth]!.char !== want) depth -= 1;
    // A closer with no opener of its kind is just a character.
    if (depth < 0) continue;
    const open = stack[depth]!;
    const innerStart = open.at + 1;
    const inner = text.slice(innerStart, i);
    pairs.push({
      start: open.at,
      end: i + 1,
      innerStart,
      innerEnd: i,
      nested: inner.includes('(') || inner.includes('['),
    });
    // The openers still on the stack were never closed: they are unbalanced.
    stack.length = depth;
  }

  pairs.sort((a, b) => a.start - b.start);
  const groups: Group[] = [];
  for (const pair of pairs) {
    const outer = groups[groups.length - 1];
    if (outer && pair.start < outer.end) {
      // Nested aside: the whole outer group is spoken exactly as written.
      outer.nested = true;
      continue;
    }
    groups.push(pair);
  }
  // A group inside an opener that never closed ("(phase 2 (dose)") is left
  // alone as well: the sentence was cut mid-aside, and guessing is worse.
  for (const open of stack) {
    for (const group of groups) {
      if (group.start > open.at) group.nested = true;
    }
  }
  return groups;
}

/** Citation spans. They are governed by `citations` alone, never by `brackets`. */
function citationSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const match of text.matchAll(CITATION_BRACKETS)) {
    const at = match.index ?? 0;
    spans.push({ start: at, end: at + match[0].length });
  }
  for (const match of text.matchAll(CITATION_YEARS)) {
    const at = match.index ?? 0;
    const span = { start: at, end: at + match[0].length };
    if (!overlaps(spans, span)) spans.push(span);
  }
  return spans;
}

/** "ans", "CYP3A4", "β-blocker" is not one (lowercase letters), "5 mg/kg" is not one (space). */
const ACRONYM = /^[\p{Lu}\p{N}βγδαΩµ+\-−·°]{2,8}$/u;

export function speakPlan(text: string, options: SpeakOptions): SpeakPlan {
  const citations = citationSpans(text);
  const mode = options.brackets;
  // Citations are removed only by their own switch; a bracket mode that reads
  // or skips asides must not swallow "(Smith et al., 2019)".
  const groups =
    mode === 'read' ? [] : bracketGroups(text).filter((group) => !overlaps(citations, group));

  type Edit = { start: number; end: number; group?: Group };
  const edits: Edit[] = [];
  if (options.citations) for (const span of citations) edits.push(span);
  for (const group of groups) edits.push({ start: group.start, end: group.end, group });
  if (edits.length === 0) return { text, charMap: null };
  edits.sort((a, b) => a.start - b.start);

  const out: string[] = [];
  const map: number[] = [];
  let lastMapped = 0;

  const push = (char: string, at: number) => {
    if (/\s/.test(char)) {
      // Collapse the double space an aside leaves behind, and never leave a
      // space in front of punctuation.
      if (out.length === 0) return;
      if (/\s/.test(out[out.length - 1]!)) return;
      const anchor = Math.max(at, lastMapped);
      out.push(' ');
      map.push(anchor);
      lastMapped = anchor;
      return;
    }
    if (TRAILING_PUNCTUATION.has(char) && out[out.length - 1] === ' ') {
      out.pop();
      map.pop();
    }
    const anchor = Math.max(at, lastMapped);
    out.push(char);
    map.push(anchor);
    lastMapped = anchor;
  };
  const pushText = (value: string, at: number) => {
    for (const char of value) push(char, at);
  };

  /** Characters from the sentence itself, mapped to their exact positions. */
  const copy = (from: number, to: number) => {
    for (let i = from; i < to; i += 1) push(text[i]!, i);
  };

  let at = 0;
  for (const edit of edits) {
    if (edit.start < at) continue;
    copy(at, edit.start);
    at = edit.end;
    const group = edit.group;
    if (!group) continue; // a removed citation
    if (group.nested) {
      copy(group.start, group.end);
      continue;
    }
    if (mode === 'skip') continue;

    const raw = text.slice(group.innerStart, group.innerEnd);
    const content = raw.trim();
    const bodyStart = group.innerStart + (raw.length - raw.trimStart().length);
    if (content === '') continue;

    let before = group.start - 1;
    while (before >= 0 && /\s/.test(text[before]!)) before -= 1;
    const previous = before >= 0 ? text[before]! : '';
    let after = group.end;
    while (after < text.length && /\s/.test(text[after]!)) after += 1;
    const next = after < text.length ? text[after]! : '';
    const sentenceStart = previous === '' || '.!?:;'.includes(previous);
    // A comma separates the aside from the phrase before it, unless the text
    // already ends the clause there.
    const comma = !sentenceStart && !',;:.!?—–-('.includes(previous);
    const suffix = next === '' || '.,;:!?)]'.includes(next) ? '' : ',';

    if (mode === 'pause') {
      // "system (ANS) controls" → "system, ANS, controls": the commas give the
      // voice a breath on each side, which is what a printed bracket means.
      if (!sentenceStart) pushText(comma ? ', ' : ' ', group.start);
      copy(bodyStart, bodyStart + content.length);
      pushText(suffix, group.end - 1);
      continue;
    }

    if (!sentenceStart && ACRONYM.test(content) && /[\p{L}\p{N})\]]$/u.test(previous)) {
      // "autonomic nervous system (ANS)" → "… system, ANS in brackets,".
      pushText(comma ? ', ' : ' ', group.start);
      copy(bodyStart, bodyStart + content.length);
      pushText(' in brackets', group.end - 1);
      pushText(suffix, group.end - 1);
      continue;
    }

    if (sentenceStart) {
      // "(See Fig. 2) Capsaicin …" → "In brackets, See Fig. 2, …".
      pushText('In brackets, ', group.start);
    } else {
      pushText(comma ? ', in brackets, ' : ' in brackets, ', group.start);
    }
    copy(bodyStart, bodyStart + content.length);
    pushText(suffix, group.end - 1);
  }
  copy(at, text.length);

  while (out.length > 0 && out[out.length - 1] === ' ') {
    out.pop();
    map.pop();
  }
  const spoken = out.join('');
  if (spoken === '') return { text, charMap: null };
  if (spoken === text) return { text, charMap: null };
  return { text: spoken, charMap: map };
}

/** Convenience for callers that only need the shortened text. */
export function spokenText(text: string, options: SpeakOptions): string {
  return speakPlan(text, options).text;
}
