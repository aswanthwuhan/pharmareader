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
  /** 1-based page, set when a paragraph may span a page break (see `stitchPages`). */
  page?: number;
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
  /** Region kind from the layout model or the text heuristics; `p` when unknown. */
  kind?: Block['kind'];
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

/**
 * Type metrics a page needs for paragraph splitting: the typical baseline step
 * between consecutive lines (`pitch`) and the width of a full line (`measure`).
 */
export interface PageMetrics {
  pitch: number;
  measure: number;
}

/**
 * Line pitch is what tells a wrapped line from a new paragraph. Comparing the
 * gap with the *font height* does not work: a page set at 12 pt on a 20 pt step
 * has every line gap at 1.7× the height, which reads as "paragraph end" and
 * splits the text every line. So measure the page's own leading instead.
 */
export function lineMetrics(lines: PdfLine[]): PageMetrics {
  const steps: number[] = [];
  const widths: number[] = [];

  lines.forEach((line, index) => {
    if (line.w > 0) widths.push(line.w);
    const previous = lines[index - 1];
    if (!previous) return;

    const step = line.y - previous.y;
    // Only same-size neighbours in one column (a negative step is a column
    // jump): small type or a stepped heading has its own leading, and a gap
    // wider than three steps is a paragraph break, not the body leading.
    if (step <= 0 || Math.abs(line.h - previous.h) > 2) return;
    if (step > Math.max(line.h, previous.h) * 3) return;
    steps.push(step);
  });

  // The 90th percentile ignores the odd ragged right edge; the median step
  // ignores paragraph gaps, which are in the minority on a full page.
  return { pitch: median(steps), measure: percentile(widths, 0.9) };
}

/**
 * The document's leading. A sparse page (a cover, a figure page, a table) has too
 * few lines to trust its own leading, so it borrows this one.
 */
export function typicalPitch(pages: PdfPage[]): number {
  return median(pages.map((page) => lineMetrics(page.lines).pitch).filter((pitch) => pitch > 0));
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

/** Sentence-ending punctuation, optionally followed by a closing quote/bracket. */
const TERMINAL = /[.!?:;][\u201d\u2019"')]*$/;

/** Group the lines of each page into paragraphs; de-hyphenates split words. */
export function pagesToParagraphs(pages: PdfPage[]): PdfParagraph[] {
  const metrics = pages.map((page) => lineMetrics(page.lines));
  // A sparse page (a cover, a figure, a table) has too few lines to trust its
  // own leading; borrow the document's.
  const documentPitch = median(metrics.map((metric) => metric.pitch).filter((pitch) => pitch > 0));
  const paragraphs: PdfParagraph[] = [];

  pages.forEach((page, index) => {
    const pitch = metrics[index].pitch || documentPitch;
    const measure = metrics[index].measure || page.width;
    paragraphs.push(...linesToParagraphs(index + 1, page.lines, page.width, pitch, measure));
  });

  return paragraphs;
}

/**
 * The same grouping for an arbitrary run of lines: the layout model hands over
 * the lines of one region at a time, so the paragraph rules (leading, indent,
 * size step, hyphenation) have to work without a whole page in hand.
 */
export function linesToParagraphs(
  pageNumber: number,
  lines: PdfLine[],
  pageWidth: number,
  pitch: number,
  measure: number,
): PdfParagraph[] {
  const paragraphs: PdfParagraph[] = [];
  let current: PdfParagraph | null = null;
  let previous: PdfLine | null = null;
  // A paragraph's body edge is its leftmost line: an indented first line has
  // the same edge for every continuation line.
  let bodyLeft = Infinity;
  let lineCount = 0;
  let firstLeft = 0;
  let sameLeft = true;
  let centreMin = Infinity;
  let centreMax = -Infinity;
  let centreSum = 0;

  for (const line of lines) {
    // Font height is only the fallback: on a page with no measurable pitch
    // (one or two lines) there is nothing better to compare the gap with.
    const expected = pitch > 0 ? pitch * 1.4 : Math.max(line.h, previous?.h ?? line.h, 1) * 1.45;
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

    // "…who would provide high quality" / "health care and advance…" is one
    // sentence whatever the leading below it does. A line that stops without
    // terminal punctuation and continues in lower case is mid-sentence.
    const continuation = Boolean(previous) && !TERMINAL.test(previous!.text) && /^\p{Ll}/u.test(line.text);

    // A centred title ("GUIDELINES FOR COMPETENCY BASED" over "POSTGRADUATE
    // TRAINING PROGRAMME") does not share one left edge, yet all its lines
    // share a centre: that, not the width, is what tells it from a justified
    // paragraph, whose lines also share a centre but never move off the edge.
    // It must never be read as an indent or a heading.
    const centred =
      lineCount > 0 &&
      !sameLeft &&
      centreMax - centreMin <= pageWidth * 0.02 &&
      Math.abs(centreSum / lineCount - pageWidth / 2) <= pageWidth * 0.08;
    // An indent or a heading is only readable once the body edge is settled:
    // if the previous line does not sit on that edge, there is nothing to
    // indent relative to.
    const settled = !previous || Math.abs(previous.x - bodyLeft) <= Math.max(2, previous.h * 0.3);

    let breaks = !current || !previous || (newColumn && !splitWord) || (sizeChange && !splitWord);

    if (!breaks && !splitWord && !continuation) {
      // A justified line fills the measure, so a short one ends its paragraph.
      const short = previous!.w < measure * 0.7 && TERMINAL.test(previous!.text);
      // A short single line at the body edge with no full stop, followed by an
      // uppercase line, is a heading ("Preamble", "A. Cognitive domain").
      const heading =
        lineCount === 1 &&
        !centred &&
        settled &&
        previous!.w < measure * 0.6 &&
        previous!.text.trim().split(/\s+/).length <= 6 &&
        !TERMINAL.test(previous!.text) &&
        /^\p{Lu}/u.test(line.text) &&
        line.w > measure * 0.5;
      // First-line indent: the new line starts right of the paragraph's edge.
      const indented = !centred && settled && line.x > bodyLeft + Math.max(4, line.h * 0.7);

      breaks = gap > expected || short || heading || indented;
    }

    if (breaks) {
      if (current) paragraphs.push(current);
      current = { page: pageNumber, text: '', spans: [] };
      bodyLeft = Infinity;
      lineCount = 0;
      sameLeft = true;
      centreMin = Infinity;
      centreMax = -Infinity;
      centreSum = 0;
    } else if (splitWord) {
      // "pharma-" + "cology" is one word, not a hyphen.
      const before = current!.text;
      const joined = before.replace(/-\s*$/, '');
      current!.text = joined;
      const last = current!.spans[current!.spans.length - 1];
      if (last) last.end -= before.length - joined.length;
    } else if (!/\s$/.test(current!.text)) {
      // The previous line may already end in a space ("decrease + ").
      current!.text += ' ';
    }

    appendLine(current!, line);
    previous = line;
    if (lineCount === 0) firstLeft = line.x;
    else if (Math.abs(line.x - firstLeft) > Math.max(2, line.h * 0.3)) sameLeft = false;
    bodyLeft = Math.min(bodyLeft, line.x);
    lineCount += 1;
    const centre = line.x + line.w / 2;
    centreMin = Math.min(centreMin, centre);
    centreMax = Math.max(centreMax, centre);
    centreSum += centre;
  }

  if (current) paragraphs.push(current);

  return paragraphs.filter((paragraph) => paragraph.text.length > 0);
}

/**
 * One paragraph from a run of lines, however many lines there are. A table is
 * read as a single block: splitting it into paragraphs would hand the reader the
 * cells as if they were sentences.
 */
export function linesToParagraph(pageNumber: number, lines: PdfLine[]): PdfParagraph {
  const paragraph: PdfParagraph = { page: pageNumber, text: '', spans: [] };
  for (const line of lines) {
    if (!/\s$/.test(paragraph.text) && paragraph.text) paragraph.text += ' ';
    appendLine(paragraph, line);
  }
  return paragraph;
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

/** Items grouped into rows, top to bottom; a stitched paragraph restarts on each page. */
function groupItemsByRow(items: PdfTextItem[]): PdfTextItem[][] {
  const rows: PdfTextItem[][] = [];
  let group: PdfTextItem[] = [];
  let centre = 0;
  let height = 0;

  const flush = () => {
    if (group.length) rows.push(group);
    group = [];
  };

  for (const item of items) {
    const itemCentre = item.y + item.h / 2;
    const tolerance = Math.max(height, item.h, 1) * 0.6;
    // y coordinates are page-relative, so two items on different pages are never
    // on one row even when their numbers agree.
    const samePage = !group.length || (group[0].page ?? 0) === (item.page ?? 0);
    if (group.length && samePage && Math.abs(itemCentre - centre) <= tolerance) {
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

/** Rects covering the sentence text in `[start, end)`, one merged rect per line. */
export function rectsForRange(paragraph: PdfParagraph, start: number, end: number): PdfRect[] {
  const items = paragraph.spans.filter((span) => span.start < end && span.end > start).map((span) => span.item);

  return groupItemsByRow(items).map((group) => {
    const left = Math.min(...group.map((item) => item.x));
    const top = Math.min(...group.map((item) => item.y));
    const right = Math.max(...group.map((item) => item.x + item.w));
    const bottom = Math.max(...group.map((item) => item.y + item.h));
    return { page: group[0].page ?? paragraph.page, x: left, y: top, w: right - left, h: bottom - top };
  });
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
    blocks.push({ id: `b-${chapterIdx}-${blockIdx}`, kind: paragraph.kind ?? 'p', sentences });
  }

  if (!blocks.length) return null;
  return { id: `ch-${chapterIdx}`, title: normaliseText(title) || `Chapter ${chapterIdx + 1}`, blocks };
}

/** "Fig. 3", "Figure 2.1", "Table 4", "Chart 2", "Plate IV" — the usual caption openers. */
const CAPTION = /^(?:fig(?:ure)?|tab(?:le)?|chart|plate|scheme)\s*\.?\s*(?:\d+|[ivxlc]+)(?:[.\-\u2013]\d+)*\s*[.:\u2014\u2013-]?\s+\p{Lu}/iu;

/** The same opener on a line of its own: many journals set "Figure 1" above the text. */
const CAPTION_NUMBER = /^(?:fig(?:ure)?|tab(?:le)?|chart|plate|scheme)\s*\.?\s*(?:\d+|[ivxlc]+)(?:[.\-\u2013]\d+)*$/iu;

/**
 * The text alone can prove some region kinds, and they are the ones the reader
 * most needs to skip: a table read aloud cell by cell, a caption read as if it
 * were the next paragraph. Used when the layout model is not installed, and for
 * whatever the model left as ordinary text.
 */
export function classifyParagraphs(paragraphs: PdfParagraph[], pages: PdfPage[]): PdfParagraph[] {
  return joinCaptionNumbers(paragraphs).map((paragraph) => {
    if (paragraph.kind && paragraph.kind !== 'p') return paragraph;
    const kind = heuristicKind(paragraph, pages[paragraph.page - 1]);
    return kind ? { ...paragraph, kind } : paragraph;
  });
}

/**
 * "Figure 1" set on its own line, with the caption under it, arrives as two
 * paragraphs (the number is usually a size larger). Join them, or the number is
 * a block of its own and the caption loses the opening that identifies it.
 */
function joinCaptionNumbers(paragraphs: PdfParagraph[]): PdfParagraph[] {
  const out: PdfParagraph[] = [];

  for (let index = 0; index < paragraphs.length; index++) {
    const paragraph = paragraphs[index];
    const next = paragraphs[index + 1];
    if (next && CAPTION_NUMBER.test(paragraph.text) && captionFollows(paragraph, next)) {
      const head = `${paragraph.text} `;
      out.push({
        page: paragraph.page,
        text: head + next.text,
        spans: [...paragraph.spans, ...next.spans.map((span) => shiftSpan(span, head.length))],
      });
      index++;
      continue;
    }
    out.push(paragraph);
  }

  return out;
}

/** Directly underneath on the same page, i.e. the number belongs to that text. */
function captionFollows(number: PdfParagraph, text: PdfParagraph): boolean {
  if (number.page !== text.page) return false;
  const above = groupItemsByRow(number.spans.map((span) => span.item));
  const below = groupItemsByRow(text.spans.map((span) => span.item));
  if (!above.length || !below.length) return false;

  const bottom = Math.max(...above[above.length - 1].map((item) => item.y + item.h));
  const top = Math.min(...below[0].map((item) => item.y));
  return top >= bottom - 2 && top - bottom <= 30;
}

function heuristicKind(paragraph: PdfParagraph, page: PdfPage | undefined): Block['kind'] | null {
  if (CAPTION.test(paragraph.text)) return 'caption';
  if (looksLikeTable(paragraph)) return 'table';
  if (!page) return null;

  // A running head repeats on most pages and `dropPageFurniture` already drops
  // it; what is left in the band is a line that appears once (a date, an imprint,
  // a section marker). Mark those so they are not read out as body text.
  const rows = groupItemsByRow(paragraph.spans.map((span) => span.item));
  if (!rows.length || paragraph.text.length > 90 || TERMINAL.test(paragraph.text)) return null;
  const top = rows[0];
  const last = rows[rows.length - 1];
  // The same band furniture is measured in, so a page number the repeat test did
  // not catch is still not read out as prose.
  if (Math.max(...top.map((item) => item.y + item.h)) <= page.height * 0.08) return 'header';
  if (Math.min(...last.map((item) => item.y)) >= page.height * 0.92) return 'footer';
  return null;
}

/**
 * A table's text arrives as ordinary lines, so recognise the grid: three or more
 * rows of three or more cells whose left edges cluster into shared columns.
 * Prose has wide gaps too (a justified line, a spaced-out title), but never the
 * same three edges on three rows.
 */
function looksLikeTable(paragraph: PdfParagraph): boolean {
  const rows = groupItemsByRow(paragraph.spans.map((span) => span.item))
    .map(cellsOfRow)
    .filter((cells) => cells.length >= 3);
  if (rows.length < 3) return false;

  const edges = rows.flat().map((cell) => cell.left).sort((a, b) => a - b);
  const columns: number[] = [];
  let run = 0;
  edges.forEach((edge, index) => {
    if (index > 0 && edge - edges[index - 1] > 4) {
      columns.push(run);
      run = 0;
    }
    run += 1;
  });
  columns.push(run);

  return columns.filter((size) => size >= 3).length >= 3;
}

interface Cell {
  left: number;
  right: number;
}

/** Split a row where the horizontal gaps are too wide to be word spaces. */
function cellsOfRow(row: PdfTextItem[]): Cell[] {
  const cells: Cell[] = [];
  let cell: Cell | null = null;

  for (const item of [...row].sort((a, b) => a.x - b.x)) {
    // A word space is a fraction of the type size; a table gutter is several.
    const space = Math.max(6, item.h * 1.2);
    if (!cell || item.x - cell.right > space) {
      if (cell) cells.push(cell);
      cell = { left: item.x, right: item.x + item.w };
    } else {
      cell.right = Math.max(cell.right, item.x + item.w);
    }
  }
  if (cell) cells.push(cell);

  return cells;
}

/**
 * Whether a page is worth the model's time. Detection costs seconds a page on a
 * phone, and on a page of plain prose the text layout is already right, so the
 * model is spent where the text alone is likely to be wrong: a page with a table
 * on it, or one whose reading order runs around a picture.
 *
 * Captions are not a signal: prose says "Figure 3 shows" at the start of a line
 * often enough that it would call the model onto most pages of a review, and the
 * caption heuristic already marks the real ones.
 */
export function needsModelLayout(page: PdfPage): boolean {
  const lines = page.lines;
  if (!lines.length) return false;
  const { pitch } = lineMetrics(lines);
  const band = page.height * 0.08;
  const hole = Math.max(pitch * 3, page.height * 0.1);

  const body = lines.filter((line) => line.y + line.h > band && line.y < page.height - band);
  if (!body.length) return false;

  // A picture printed above the first line of text leaves the page's own top
  // margin, which is part of the layout and not a hole.
  if (body[0].y > band + page.height * 0.12) return true;

  let cellRows = 0;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const next = lines[index + 1];

    // A hole in the middle of the text: nothing to read there, but the order has
    // to jump around it and whatever sits beside it is a caption.
    if (next && line.y + line.h > band && next.y - (line.y + line.h) > hole) return true;

    cellRows = cellsOfRow(line.items).length >= 3 ? cellRows + 1 : 0;
    if (cellRows >= 3) return true;
  }

  return false;
}

/**
 * Join the paragraphs a page break cuts in two. A page of a book ends wherever
 * the type runs out, so the last paragraph of one page usually continues at the
 * top of the next: it stops without terminal punctuation and the next page picks
 * up in lower case. Without this the reader gets two sentences that are really
 * halves of one, and a stray sentence id change at every page boundary.
 */
export function stitchPages(paragraphs: PdfParagraph[]): PdfParagraph[] {
  const out: PdfParagraph[] = [];

  for (const paragraph of paragraphs) {
    const previous = out[out.length - 1];
    if (!previous || !continuesAcrossPage(previous, paragraph)) {
      out.push(paragraph);
      continue;
    }

    // The join eats the whitespace the first paragraph ended on, so its spans
    // (and their rects) have to move with the text.
    const head = previous.text.replace(/\s+$/, '');
    const hyphenated = /-$/.test(head) && /^[\p{L}\p{N}(]/u.test(paragraph.text);
    const base = hyphenated ? head.slice(0, -1) : head;
    const prefix = `${base} `;
    for (const span of previous.spans) {
      span.start = Math.min(span.start, base.length);
      span.end = Math.min(span.end, base.length);
    }

    out[out.length - 1] = {
      page: previous.page,
      kind: previous.kind ?? paragraph.kind,
      text: prefix + paragraph.text,
      spans: [...previous.spans, ...paragraph.spans.map((span) => shiftSpan(span, prefix.length))],
    };
  }

  return out;
}

function continuesAcrossPage(previous: PdfParagraph, paragraph: PdfParagraph): boolean {
  if (previous.page >= paragraph.page) return false;
  // A heading ends a page's story; nothing continues out of one.
  if (previous.kind === 'h' || paragraph.kind === 'h') return false;
  if (TERMINAL.test(previous.text)) return false;
  return /^\p{Ll}/u.test(paragraph.text);
}

function shiftSpan(span: PdfSpan, by: number): PdfSpan {
  return { start: span.start + by, end: span.end + by, item: span.item };
}

function defaultStarts(totalPages: number): ChapterStart[] {
  const starts: ChapterStart[] = [];
  for (let page = 1; page <= totalPages; page += 20) {
    starts.push({ page, title: `Pages ${page}\u2013${Math.min(page + 19, totalPages)}` });
  }
  return starts;
}
