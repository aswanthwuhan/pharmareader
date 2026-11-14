import type { PdfRect } from '../core/types';

/**
 * Rough advance width of a character in a book face, in ems. Equal widths put
 * the mark several letters off by the end of a line: "illicit" is half as wide
 * as "common".
 */
function charWidth(ch: string): number {
  if (ch === ' ') return 0.25;
  if ("iIjl.,;:'!|".includes(ch)) return 0.28;
  if ('ftr()[]-/'.includes(ch)) return 0.34;
  if ('mwMW'.includes(ch)) return 0.82;
  if (ch >= 'A' && ch <= 'Z') return 0.68;
  return 0.5;
}

export function textWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += charWidth(ch);
  return width;
}

/**
 * Where the spoken word sits on the drawn page.
 *
 * The import keeps one rectangle per printed line of a sentence, not one per
 * word. Each word is given to the line its middle falls on (lines share the
 * sentence in proportion to their width), and the words of a line are then
 * spread over exactly that line's rectangle — so the error cannot build up
 * from one line to the next, and a word is never drawn across a line break.
 *
 * shortcut: glyph widths are a table, not the PDF's font metrics, so the mark
 * can be off by a letter and a word at a line break can land on the wrong
 * line; store per-word boxes at import to make it exact.
 */
export function wordRects(rects: PdfRect[], text: string, charIndex: number): PdfRect[] {
  if (rects.length === 0 || text.length === 0 || charIndex < 0 || charIndex >= text.length) return [];
  const total = rects.reduce((sum, rect) => sum + rect.w, 0);
  if (total <= 0) return [];

  const space = charWidth(' ');
  const tokens = [...text.matchAll(/\S+/g)].map((m) => ({ end: m.index + m[0].length, w: textWidth(m[0]), line: 0 }));
  const target = tokens.findIndex((t) => t.end > charIndex);
  if (target < 0) return [];

  // Line of each word: where its middle falls among the lines' shares.
  const length = tokens.reduce((sum, t) => sum + t.w, 0) + space * (tokens.length - 1);
  let at = 0;
  let line = 0;
  let lineEnd = (rects[0]!.w / total) * length;
  for (const token of tokens) {
    const middle = at + token.w / 2;
    while (line < rects.length - 1 && middle >= lineEnd) {
      line++;
      lineEnd += (rects[line]!.w / total) * length;
    }
    token.line = line;
    at += token.w + space;
  }

  // Spread that line's words over its rectangle.
  const rect = rects[tokens[target]!.line]!;
  let before = 0;
  let width = 0;
  tokens.forEach((token, i) => {
    if (token.line !== tokens[target]!.line) return;
    if (width > 0) width += space;
    if (i === target) before = width;
    width += token.w;
  });
  const scale = rect.w / width;
  return [{ ...rect, x: rect.x + before * scale, w: tokens[target]!.w * scale }];
}
