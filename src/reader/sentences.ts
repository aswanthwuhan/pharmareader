/**
 * Reading-order index of a document.
 *
 * The reader, the player and the highlights all address sentences by id; every
 * one of them needs the sentence's chapter and position, so it is computed once
 * per book instead of being searched for on every tap.
 */
import type { Highlight, ParsedDoc, PdfRect } from '../core/types';

/** A sentence with its place in the document. */
export interface FlatSentence {
  id: string;
  text: string;
  pdfRects?: PdfRect[];
  chapterIndex: number;
  /** Position among the chapter's sentences, i.e. the player's queue index. */
  index: number;
}

export interface Pos {
  chapterIndex: number;
  index: number;
}

export interface BookIndex {
  /** One flat sentence list per chapter, in reading order. */
  chapters: FlatSentence[][];
  byId: Map<string, Pos>;
}

export function indexBook(doc: ParsedDoc): BookIndex {
  const chapters: FlatSentence[][] = [];
  const byId = new Map<string, Pos>();

  doc.chapters.forEach((chapter, chapterIndex) => {
    const flat: FlatSentence[] = [];
    for (const block of chapter.blocks) {
      for (const sentence of block.sentences) {
        const entry: FlatSentence = {
          id: sentence.id,
          text: sentence.text,
          chapterIndex,
          index: flat.length,
        };
        if (sentence.pdfRects?.length) entry.pdfRects = sentence.pdfRects;
        flat.push(entry);
        // First occurrence wins: ids are unique, but an odd import could repeat one.
        if (!byId.has(sentence.id)) byId.set(sentence.id, { chapterIndex, index: flat.length - 1 });
      }
    }
    chapters.push(flat);
  });

  return { chapters, byId };
}

export function sentenceAt(index: BookIndex, pos: Pos | null): FlatSentence | null {
  if (!pos) return null;
  return index.chapters[pos.chapterIndex]?.[pos.index] ?? null;
}

/** Restore a saved reading position, tolerating a re-imported or edited book. */
export function posForSaved(
  doc: ParsedDoc,
  index: BookIndex,
  saved?: { chapterId: string; sentenceId: string }
): Pos {
  if (saved) {
    const direct = index.byId.get(saved.sentenceId);
    if (direct) return direct;
    const chapterIndex = doc.chapters.findIndex((chapter) => chapter.id === saved.chapterId);
    if (chapterIndex >= 0) return { chapterIndex, index: 0 };
  }
  return { chapterIndex: 0, index: 0 };
}

/** sentence id → highlight; `listHighlights` is newest first, so the first wins. */
export function highlightBySentence(highlights: Highlight[]): Map<string, Highlight> {
  const map = new Map<string, Highlight>();
  for (const highlight of highlights) {
    for (const id of highlight.sentenceIds) {
      if (!map.has(id)) map.set(id, highlight);
    }
  }
  return map;
}

/**
 * The sentences to render for one chapter.
 *
 * A PDF fallback chapter can hold ~1500 sentences (20 pages), and a phone has
 * no business laying out that many spans at once. The reader renders a window
 * around the cursor instead and grows it as the reader moves — full render
 * when the chapter fits.
 */
export function windowRange(total: number, focus: number | null, radius: number): { start: number; end: number } {
  const size = radius * 2 + 1;
  if (total <= size) return { start: 0, end: Math.max(0, total) };
  const center = focus === null || focus < 0 ? 0 : Math.min(focus, total - 1);
  let start = Math.max(0, center - radius);
  let end = Math.min(total, center + radius + 1);
  // Keep a full window at the edges so the first page is not half-sized.
  if (start === 0) end = size;
  if (end === total) start = total - size;
  return { start, end };
}

/** Move `delta` sentences, crossing chapter boundaries; null at either end. */
export function stepPos(index: BookIndex, pos: Pos, delta: number): Pos | null {
  let chapterIndex = pos.chapterIndex;
  let at = pos.index + delta;

  if (at < 0) {
    chapterIndex -= 1;
    if (chapterIndex < 0) return null;
    at = (index.chapters[chapterIndex]?.length ?? 0) - 1;
    if (at < 0) return null;
  }
  if (at >= (index.chapters[chapterIndex]?.length ?? 0)) {
    chapterIndex += 1;
    at = 0;
    if (chapterIndex >= index.chapters.length) return null;
  }
  return { chapterIndex, index: at };
}
