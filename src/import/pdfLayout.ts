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
  return groupRows(items).map(makeLine);
}

/**
 * Lines in reading order. Most PDFs are a single column, and `itemsToLines`
 * is already right for them. A journal page holds two columns side by side:
 * reading its rows in y order splices the columns into each other sentence by
 * sentence. Detect the vertical gutter and read each column to its bottom
 * before starting the next one.
 */
export function itemsToPageLines(items: PdfTextItem[], pageWidth: number): PdfLine[] {
  const rows = groupRows(items);
  const gutter = detectGutter(rows, pageWidth);
  if (!gutter) return rows.map(makeLine);

  const lines: PdfLine[] = [];
  let left: PdfLine[] = [];
  let right: PdfLine[] = [];
  const middle = (gutter.start + gutter.end) / 2;

  const flushBand = () => {
    lines.push(...left, ...right);
    left = [];
    right = [];
  };

  for (const row of rows) {
    // A title or figure caption spanning the gutter splits the page into bands:
    // columns above it, then the wide line, then columns below it. Testing only
    // "reaches into the gutter" would also catch a left-column line whose last
    // word overhangs a point or two, and splicing that with the right column is
    // exactly the interleaving this function exists to avoid.
    if (row.some((item) => item.x < middle && item.x + item.w > gutter.end)) {
      flushBand();
      lines.push(makeLine(row));
      continue;
    }

    const leftItems = row.filter((item) => item.x + item.w / 2 < middle);
    const rightItems = row.filter((item) => item.x + item.w / 2 >= middle);
    if (leftItems.length) left.push(makeLine(leftItems));
    if (rightItems.length) right.push(makeLine(rightItems));
  }
  flushBand();

  return lines;
}

interface Gutter {
  start: number;
  end: number;
}

/**
 * Find the vertical whitespace corridor between two columns.
 *
 * Only rows that themselves break in the middle are evidence: a justified
 * single-column line has no wide internal gap, and a full-width title or figure
 * caption has none either, so those rows neither create nor veto a corridor.
 * Pages covered by a full-page figure therefore still get their body text in
 * reading order.
 */
function detectGutter(rows: PdfTextItem[][], width: number): Gutter | null {
  if (rows.length < 12 || width <= 0) return null;

  const minRun = Math.max(10, width * 0.015);
  const clear = Math.max(10, width * 0.015);
  const columnar = rows
    .map((row) => ({ row, gaps: middleGaps(row, width, clear) }))
    .filter((entry) => entry.gaps.length > 0);
  if (columnar.length < Math.max(5, rows.length * 0.2)) return null;

  const bins = Math.ceil(width);
  const covered = new Uint16Array(bins);
  for (const { row } of columnar) {
    const touched = new Uint8Array(bins);
    for (const item of row) {
      const from = Math.max(0, Math.floor(item.x));
      const to = Math.min(bins - 1, Math.ceil(item.x + item.w) - 1);
      for (let bin = from; bin <= to; bin++) touched[bin] = 1;
    }
    for (let bin = 0; bin < bins; bin++) covered[bin] += touched[bin];
  }

  const sparse = Math.max(1, Math.floor(columnar.length * 0.15));
  let best: Gutter | null = null;
  let runStart = -1;

  for (let bin = 0; bin <= bins; bin++) {
    const empty = bin < bins && covered[bin] <= sparse;
    if (empty && runStart < 0) runStart = bin;
    if (!empty && runStart >= 0) {
      const start = runStart;
      const end = bin;
      runStart = -1;
      const centre = (start + end) / 2;
      const wideEnough = end - start >= minRun;
      const centred = centre >= width * 0.25 && centre <= width * 0.75;
      if (wideEnough && centred && (!best || end - start > best.end - best.start)) best = { start, end };
    }
  }
  const gutter: Gutter | null = best;
  if (!gutter) return null;

  // The corridor has to be the gap most of those rows actually break at,
  // otherwise loose justification in one column can fake one.
  const support = columnar.filter(({ gaps }) =>
    gaps.some(([from, to]) => from <= gutter.start + 2 && to >= gutter.end - 2),
  ).length;
  if (support < columnar.length * 0.5) return null;

  // Require real text on both sides, otherwise a figure's white space looks like
  // a gutter. A two-column row usually holds items from both columns, so count
  // items rather than rows, and require them to run right up to the corridor.
  const items = rows.flat();
  const near = Math.max(8, width * 0.02);
  const leftItems = items.filter((item) => item.x + item.w <= gutter.start + 2);
  const rightItems = items.filter((item) => item.x >= gutter.end - 2);
  const leftAbuts = leftItems.some((item) => item.x + item.w >= gutter.start - near);
  const rightAbuts = rightItems.some((item) => item.x <= gutter.end + near);
  const enough = Math.max(3, Math.floor(rows.length * 0.1));
  return leftItems.length >= enough && rightItems.length >= enough && leftAbuts && rightAbuts ? gutter : null;
}

/** Gaps between neighbouring items that sit in the middle half of the page. */
function middleGaps(row: PdfTextItem[], width: number, minimum: number): [number, number][] {
  const sorted = [...row].sort((a, b) => a.x - b.x);
  const gaps: [number, number][] = [];
  for (let i = 1; i < sorted.length; i++) {
    const from = sorted[i - 1].x + sorted[i - 1].w;
    const to = sorted[i].x;
    if (to - from < minimum) continue;
    const centre = (from + to) / 2;
    if (centre >= width * 0.25 && centre <= width * 0.75) gaps.push([from, to]);
  }
  return gaps;
}

/** Items grouped into rows by baselines, ordered top to bottom. */
function groupRows(items: PdfTextItem[]): PdfTextItem[][] {
  const sorted = items.filter((item) => item.str.trim()).sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: PdfTextItem[][] = [];
  let group: PdfTextItem[] = [];
  let centre = 0;
  let height = 0;

  const flush = () => {
    if (group.length) rows.push(group);
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

  return rows;
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
      // Reading order jumps back to the top of the page at a column break, so a
      // negative gap is a new column, not a continuation.
      const newColumn = Boolean(previous && line.y < previous.y - 1);
      // A word hyphenated across that break still belongs to the same sentence.
      // Compound names break on capital letters and digits too ("Sang-" + "Mi",
      // "IL-" + "4", "1-chloro-" + "2,4-dinitrobenzene").
      // The continuation can start with any letter, not just ASCII: "IFN-" + "γ".
      const splitWord =
        Boolean(previous) && /-\s*$/.test(current?.text ?? '') && /^[\p{L}\p{N}(]/u.test(line.text);

      // Fig. 3 Effects of ... — a caption set in a smaller size runs straight on
      // into the body text below it, and gluing the two makes one nonsense
      // sentence. A real size step means a new block.
      const sizeChange = Boolean(previous) && Math.abs(line.h - previous!.h) > 2;

      if (
        !current ||
        !previous ||
        (gap > expected * 1.45 && !splitWord) ||
        (newColumn && !splitWord) ||
        (sizeChange && !splitWord)
      ) {
        if (current) paragraphs.push(current);
        current = { page: pageNumber, text: '', spans: [] };
      } else if (splitWord) {
        // "pharma-" + "cology" is one word, not a hyphen.
        const before = current!.text;
        const joined = before.replace(/-\s*$/, '');
        current!.text = joined;
        const last = current!.spans[current!.spans.length - 1];
        if (last) last.end -= before.length - joined.length;
      } else if (!/\s$/.test(current.text)) {
        // The previous line may already end in a space ("decrease + ").
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
    // A PDF often emits runs that are only a space; the gap rule below already
    // inserts one, so keeping them doubles the space ("decrease  +  of").
    if (!item.str.trim()) continue;

    const gapSpace = endX > -Infinity && item.x - endX > Math.max(item.h, 1) * 0.25;
    let chunk = item.str;
    // Never leave two spaces: drop the run's own whitespace when the gap rule
    // inserts a space, or when the paragraph already ends in one.
    if (endX === -Infinity || gapSpace || /\s$/.test(paragraph.text)) chunk = chunk.replace(/^\s+/, '');
    if (!chunk) continue;

    // A PDF run can end at the break of a hyphenated compound ("anti-" + "JAK2")
    // even inside one line; the space the gap rule would add is not real there,
    // and the run often carries one of its own anyway.
    const hyphenJoin = /-[\s]*$/.test(paragraph.text) && /^[\p{L}\p{N}(]/u.test(chunk);
    if (hyphenJoin) {
      paragraph.text = paragraph.text.replace(/\s+$/, '');
      const lastSpan = paragraph.spans[paragraph.spans.length - 1];
      if (lastSpan) lastSpan.end = paragraph.text.length;
    }
    if (gapSpace && !hyphenJoin && !/\s$/.test(paragraph.text)) chunk = ` ${chunk}`;

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
