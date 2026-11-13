import type { PdfRect } from '../core/types';

/**
 * Where the spoken word sits on the drawn page.
 *
 * The import keeps one rectangle per printed line of a sentence, not one per
 * word, so the word is placed by its share of the sentence's characters along
 * those lines.
 *
 * shortcut: assumes every character is equally wide, so the mark can be off by
 * a few letters in proportional type; store per-word boxes at import to make it exact.
 */
export function wordRects(rects: PdfRect[], text: string, charIndex: number): PdfRect[] {
  if (rects.length === 0 || text.length === 0 || charIndex < 0 || charIndex >= text.length) return [];
  const gap = text.slice(charIndex).search(/\s/);
  const end = gap < 0 ? text.length : charIndex + gap;
  const total = rects.reduce((sum, rect) => sum + rect.w, 0);
  if (total <= 0 || end <= charIndex) return [];

  const from = (charIndex / text.length) * total;
  const to = (end / text.length) * total;
  const out: PdfRect[] = [];
  let at = 0;
  for (const rect of rects) {
    const left = Math.max(from, at);
    const right = Math.min(to, at + rect.w);
    if (right > left) out.push({ ...rect, x: rect.x + (left - at), w: right - left });
    at += rect.w;
  }
  return out;
}
