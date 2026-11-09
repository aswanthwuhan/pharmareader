import type { Block, Chapter, PdfRect, Sentence } from '../core/types';
import { normaliseText } from './blocks';
import { segmentText } from './segment';

/**
 * Pure PDF text-grouping logic: no pdfjs import, so it is unit-testable with
 * mock text items. pdf.ts only converts pdfjs items into `PdfTextItem`s (scale 1,
 * top-left origin) and feeds them here.
 */

export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PdfLine {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  items: PdfTextItem[];
}

export interface PdfPage {
  width: number;
  height: number;
  lines: PdfLine[];
}

export interface PdfSpan {
  start: number;
  end: number;
  item: PdfTextItem;
}

export interface PdfParagraph {
  /** 1-based page number the paragraph starts on. */
  page: number;
  text: string;
  spans: PdfSpan[];
}

export interface ChapterStart {
  /** 1-based page number where the chapter begins. */
  page: number;
  title: string;
}

/** Group text items into visual lines (items sorted by y, then x). */
export function itemsToLines(items: PdfTextItem[]): PdfLine[] {
  const sorted = items.filter((item) => item.str.trim()).sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: PdfLine[] = [];
  let group: PdfTextItem[] = [];
  let centre = 0;
  let height = 0;

  const flush = () => {
    if (group.length) lines.push(makeLine(group));
    group = [];
  };

  for (const item of sorted) {
    const itemCentre = item.y + item.h / 2;
    const tolerance = Math.max(height, item.h, 1) * 0.5;
    if (group.length && Math.abs(itemCentre - centre) <= tolerance) {
      group.push(item);
      centre = (centre * (group.length - 1) + itemCentre) / group.length;
      height = Math.max(height, item.h);
    } else {
      flush();
      group = [item];
      centre = itemCentre;
      height = item.h;
    }
  }
  flush();

  return lines;
}

function makeLine(items: PdfTextItem[]): PdfLine {
  const ordered = items.slice().sort((a, b) => a.x - b.x);
  return {
    text: lineText(ordered),
    x: Math.min(...ordered.map((item) => item.x)),
    y: Math.min(...ordered.map((item) => item.y)),
    w: Math.max(...ordered.map((item) => item.x + item.w)) - Math.min(...ordered.map((item) => item.x)),
    h: Math.max(...ordered.map((item) => item.h)),
    items: ordered,
  };
}

function lineText(items: PdfTextItem[]): string {
  let text = '';
  let endX = -Infinity;

  for (const item of items) {
    let chunk = item.str;
    if (endX === -Infinity || /\s$/.test(text)) chunk = chunk.replace(/^\s+/, '');
    if (!chunk) continue;

    if (/^\s/.test(text)) text = text.replace(/\s+$/, '');
    const gapSpace = endX > -Infinity && item.x - endX > Math.max(item.h, 1) * 0.25 && !/\s$/.test(text) && !/^\s/.test(chunk);
    if (gapSpace) text += ' ';
    text += chunk;
    endX = Math.max(endX, item.x + item.w);
  }

  return normaliseText(text);
}

/** Drop running headers/footers and page numbers in the top/bottom 8% of a page. */
export function dropPageFurniture(pages: PdfPage[]): PdfPage[] {
  const counts = new Map<string, number>();

  for (const page of pages) {
    for (const line of page.lines) {
      if (!inFurnitureZone(page, line)) continue;
      const key = furnitureKey(line.text);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const repeated = new Set(
    [...counts].filter(([, count]) => count > pages.length * 0.5).map(([key]) => key),
  );

  return pages.map((page) => ({
    ...page,
    lines: page.lines.filter((line) => {
      if (!inFurnitureZone(page, line)) return true;
      return !repeated.has(furnitureKey(line.text)) && !PAGE_NUMBER.test(line.text);
    }),
  }));
}

const PAGE_NUMBER = /^(?:page\s*)?[-\u2013\u2014]?\s*(?:\d{1,4}|[ivxlcdm]{1,7})\s*[-\u2013\u2014]?$/i;

function inFurnitureZone(page: PdfPage, line: PdfLine): boolean {
  return line.y + line.h <= page.height * 0.08 || line.y >= page.height * 0.92;
}

function furnitureKey(text: string): string {
  return text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

/** Group page lines into paragraphs; de-hyphenates words broken across lines. */
export function pagesToParagraphs(pages: PdfPage[]): PdfParagraph[] {
  const paragraphs: PdfParagraph[] = [];

  pages.forEach((page, index) => {
    const pageNumber = index + 1;
    let current: PdfParagraph | null = null;
    let previous: PdfLine | null = null;

    for (const line of page.lines) {
      const expected = Math.max(line.h, previous?.h ?? line.h, 1);
      const gap = previous ? line.y - previous.y : 0;

      if (!current || !previous || gap > expected * 1.45) {
        if (current) paragraphs.push(current);
        current = { page: pageNumber, text: '', spans: [] };
      } else if (/-$/.test(current.text) && /^[a-z]/.test(line.text)) {
        // "pharma-" + "cology" is one word, not a hyphen.
        current.text = current.text.slice(0, -1);
        const last = current.spans[current.spans.length - 1];
        if (last) last.end -= 1;
      } else {
        current.text += ' ';
      }

      appendLine(current, line);
      previous = line;
    }

    if (current) paragraphs.push(current);
  });

  return paragraphs.filter((paragraph) => paragraph.text.length > 0);
}

function appendLine(paragraph: PdfParagraph, line: PdfLine): void {
  let endX = -Infinity;

  for (const item of line.items) {
    let chunk = item.str;
    if (endX === -Infinity || /\s$/.test(paragraph.text)) chunk = chunk.replace(/^\s+/, '');
    if (!chunk) continue;

    const gapSpace =
      endX > -Infinity && item.x - endX > Math.max(item.h, 1) * 0.25 && !/\s$/.test(paragraph.text) && !/^\s/.test(chunk);
    if (gapSpace) chunk = ` ${chunk}`;

    const start = paragraph.text.length;
    paragraph.text += chunk;
    paragraph.spans.push({ start, end: paragraph.text.length, item });
    endX = Math.max(endX, item.x + item.w);
  }
}

/** Rects covering the sentence text in `[start, end)`, one merged rect per line. */
export function rectsForRange(paragraph: PdfParagraph, start: number, end: number): PdfRect[] {
  const items = paragraph.spans.filter((span) => span.start < end && span.end > start).map((span) => span.item);
  const rects: PdfRect[] = [];
  let group: PdfTextItem[] = [];
  let centre = 0;
  let height = 0;

  const flush = () => {
    if (!group.length) return;
    const left = Math.min(...group.map((item) => item.x));
    const top = Math.min(...group.map((item) => item.y));
    const right = Math.max(...group.map((item) => item.x + item.w));
    const bottom = Math.max(...group.map((item) => item.y + item.h));
    rects.push({ page: paragraph.page, x: left, y: top, w: right - left, h: bottom - top });
    group = [];
  };

  for (const item of items) {
    const itemCentre = item.y + item.h / 2;
    const tolerance = Math.max(height, item.h, 1) * 0.6;
    if (group.length && Math.abs(itemCentre - centre) <= tolerance) {
      group.push(item);
      centre = (centre * (group.length - 1) + itemCentre) / group.length;
      height = Math.max(height, item.h);
    } else {
      flush();
      group = [item];
      centre = itemCentre;
      height = item.h;
    }
  }
  flush();

  return rects;
}

/** Assemble chapters from paragraphs, splitting at outline starts (or every 20 pages). */
export function chaptersFromPages(
  paragraphs: PdfParagraph[],
  starts: ChapterStart[],
  totalPages: number,
): Chapter[] {
  const ranges = starts.length ? withFrontMatter(starts) : defaultStarts(totalPages);
  const chapters: Chapter[] = [];

  for (let index = 0; index < ranges.length; index++) {
    const from = ranges[index].page;
    const to = index + 1 < ranges.length ? ranges[index + 1].page : Infinity;
    const seeds = paragraphs.filter((paragraph) => paragraph.page >= from && paragraph.page < to);

    const chapter = buildChapter(ranges[index].title, chapters.length, seeds);
    if (chapter) chapters.push(chapter);
  }

  return chapters;
}

/** Outline often skips the front matter; keep those pages instead of dropping them. */
function withFrontMatter(starts: ChapterStart[]): ChapterStart[] {
  const first = starts[0];
  if (first.page <= 1) return starts;
  return [{ page: 1, title: `Pages 1\u2013${first.page - 1}` }, ...starts];
}

function buildChapter(title: string, chapterIdx: number, paragraphs: PdfParagraph[]): Chapter | null {
  const blocks: Block[] = [];

  for (const paragraph of paragraphs) {
    const text = paragraph.text;
    if (!normaliseText(text)) continue;

    const blockIdx = blocks.length;
    const sentences: Sentence[] = segmentText(text)
      .filter((span) => /[\p{L}\p{N}]/u.test(span.text))
      .map((span, sentIdx) => ({
        id: `${chapterIdx}-${blockIdx}-${sentIdx}`,
        text: span.text,
        pdfRects: rectsForRange(paragraph, span.index, span.index + span.text.length),
      }));

    if (!sentences.length) continue;
    blocks.push({ id: `b-${chapterIdx}-${blockIdx}`, kind: 'p', sentences });
  }

  if (!blocks.length) return null;
  return { id: `ch-${chapterIdx}`, title: normaliseText(title) || `Chapter ${chapterIdx + 1}`, blocks };
}

function defaultStarts(totalPages: number): ChapterStart[] {
  const starts: ChapterStart[] = [];
  for (let page = 1; page <= totalPages; page += 20) {
    starts.push({ page, title: `Pages ${page}\u2013${Math.min(page + 19, totalPages)}` });
  }
  return starts;
}
