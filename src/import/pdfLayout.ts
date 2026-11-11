import type { Block, Chapter, PdfRect, Sentence } from '../core/types';
import { normaliseText } from './blocks';
// Type-only: `assign.ts` reads pdf.js boxes, and this module must stay
// importable (and testable) without pdf.js.
import type { ColumnMode, PanelRect } from './layout/assign';
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
 * How a page's columns are read: `auto` splits when the text shows a gutter,
 * `1` never splits, `2` always does (at the page middle when nothing better is
 * known). Pages are read one way per document, so pdf.ts decides this.
 */

/** The vertical whitespace corridor between two columns of text. */
export interface Gutter {
  start: number;
  end: number;
}

export interface LineOptions {
  /** Boxes painted across both columns; each becomes a band of its own. */
  panels?: readonly PanelRect[];
  /** Corridor to split at. Omitted: detect one on this page. */
  gutter?: Gutter | null;
  columns?: ColumnMode;
}

/** The corridor this page's text is laid out around, if it shows one. */
export function pageGutter(items: PdfTextItem[], pageWidth: number): Gutter | null {
  return detectGutter(groupRows(items), pageWidth);
}

/**
 * Lines in reading order. Most PDFs are a single column, and `itemsToLines`
 * is already right for them. A journal page holds two columns side by side:
 * reading its rows in y order splices the columns into each other sentence by
 * sentence. Detect the vertical gutter and read each column to its bottom
 * before starting the next one.
 *
 * A boxed panel (a shaded sidebar, a case-study box, a figure in a frame) has
 * its own two columns, so nothing above it may be spliced with anything inside
 * or below it: its top and bottom edges end the band.
 */
export function itemsToPageLines(items: PdfTextItem[], pageWidth: number, options: LineOptions = {}): PdfLine[] {
  const rows = groupRows(items);
  const columns = options.columns ?? 'auto';
  if (columns === 1) return rows.map(makeLine);

  // A gutter found for the whole document beats this page's own: a page whose
  // first lines are too short to break in the middle still sits in the same two
  // columns as its neighbours (see `documentGutter`).
  const gutter =
    options.gutter ??
    detectGutter(rows, pageWidth) ??
    (columns === 2 ? { start: pageWidth / 2 - 1, end: pageWidth / 2 + 1 } : null);
  if (!gutter) return rows.map(makeLine);

  const rules: ColumnRules = {
    middle: (gutter.start + gutter.end) / 2,
    // A row is a band of its own only when its line reaches a quarter into the
    // right column. A left-column line whose last word overhangs the corridor
    // by a point or two is still a left-column line, and splicing it with the
    // right column is exactly the interleaving this function exists to avoid.
    reach: gutter.end + Math.max(0, pageWidth - gutter.end) * 0.25,
    gap: Math.max(6, (gutter.end - gutter.start) * 0.6),
    corridor: gutter,
  };

  const lines: PdfLine[] = [];
  for (const chunk of panelChunks(rows, options.panels ?? [])) {
    // A table's cells line up in more than two columns, so the widest space in it
    // is the gap between two cells, not a corridor between columns of text.
    // Splitting there would read every row as its left cells and then its right
    // ones; a table is read row by row, as it is printed.
    if (rowsLookLikeTable(chunk.rows, pageWidth)) {
      lines.push(...chunk.rows.map(makeLine));
      continue;
    }
    // Inside a panel the two halves are the panel's own columns, so a wide row
    // there cannot be a sentence the panel interrupted.
    readColumns(chunk.rows, lines, rules, chunk.panel === null);
  }
  return lines;
}

/**
 * True when these rows are a table: three or more left edges carry at least half
 * of them. A two-column page has two such edges however its paragraphs indent,
 * and a figure's labels repeat no edge down every row, so neither passes for a
 * table however many short pieces of text they scatter.
 */
function rowsLookLikeTable(rows: readonly PdfTextItem[][], pageWidth: number): boolean {
  if (rows.length < 4) return false;

  // One vote per row: a cell and a superscript beside it mark the same column.
  const tolerance = Math.max(6, pageWidth * 0.01);
  const edges: { x: number; rows: Set<number> }[] = [];
  rows.forEach((row, index) => {
    for (const item of row) {
      let edge = edges.find((candidate) => Math.abs(candidate.x - item.x) <= tolerance / 2);
      if (!edge) {
        edge = { x: item.x, rows: new Set<number>() };
        edges.push(edge);
      }
      edge.rows.add(index);
    }
  });

  const strong = edges.filter((edge) => edge.rows.size * 2 >= rows.length);
  return strong.length > 2;
}

interface ColumnRules {
  /** Where a row's items are split into left and right. */
  middle: number;
  /** A row has to reach this far right to be a full-width line. */
  reach: number;
  /** Items closer than this belong to the same run of the line. */
  gap: number;
  /** The empty corridor between the columns. */
  corridor: Gutter;
}

/**
 * The runs of a row's items, joined where the gap is no wider than a word
 * space. A line's words often arrive as separate items; the two columns' lines
 * at the same height stay separate because the corridor between them is wider.
 * An item starting well inside the previous one is not its continuation either
 * (kerning overlaps a run by a point or two at most).
 */
function mergedRuns(row: readonly PdfTextItem[], gap: number): [number, number][] {
  const spans = row.map((item) => [item.x, item.x + item.w] as [number, number]).sort((a, b) => a[0] - b[0]);
  const runs: [number, number][] = [];
  for (const [start, end] of spans) {
    const last = runs[runs.length - 1];
    const join = last ? start - last[1] : Infinity;
    if (last && join <= gap && join >= -1) last[1] = Math.max(last[1], end);
    else runs.push([start, end]);
  }
  return runs;
}

/**
 * True when a row is one full-width line: a run of it starts left of the
 * corridor and reaches a quarter into the right column. Splitting at a single
 * item would miss the line whose first words are separate items and whose long
 * run begins right of the corridor's middle.
 *
 * A row also ends in a run that crosses the corridor when the page only looks
 * two-column: a one-column list leaves a corridor between its number and its
 * text, and the text run then starts left of that corridor and runs past it. In
 * a real two-column row the rightmost run is the right column's line, which
 * starts at the far edge of the corridor instead.
 */
function rowCrosses(row: readonly PdfTextItem[], rules: ColumnRules): boolean {
  const runs = mergedRuns(row, rules.gap);
  if (runs.some(([start, end]) => start < rules.middle && end > rules.reach)) return true;
  if (runs.length < 2) return false;
  const [start, end] = runs[runs.length - 1];
  return start < rules.corridor.start && end > rules.corridor.end;
}

/** True when the row's first run starts left of the corridor and ends past it. */
function rowStartsWide(row: readonly PdfTextItem[], rules: ColumnRules): boolean {
  const [start, end] = mergedRuns(row, rules.gap)[0];
  return start < rules.middle && end > rules.corridor.end;
}

interface PanelChunk {
  /** The panel these rows sit inside, or null for the page body. */
  panel: PanelRect | null;
  rows: PdfTextItem[][];
}

/** Rows cut into runs that belong to the same panel (or to none). */
function panelChunks(rows: PdfTextItem[][], panels: readonly PanelRect[]): PanelChunk[] {
  if (!panels.length) return [{ panel: null, rows }];

  const chunks: PanelChunk[] = [];
  for (const row of rows) {
    const y = row.reduce((sum, item) => sum + item.y + item.h / 2, 0) / row.length;
    const panel = panels.find((rect) => y >= rect.y && y <= rect.y + rect.h) ?? null;
    const last = chunks[chunks.length - 1];
    if (last && last.panel === panel) last.rows.push(row);
    else chunks.push({ panel, rows: [row] });
  }
  return chunks;
}

/** One band of rows: the left column down to its bottom, then the right one. */
function readColumns(rows: PdfTextItem[][], out: PdfLine[], rules: ColumnRules, sentencesContinue: boolean): void {
  const { middle } = rules;
  let left: PdfLine[] = [];
  let right: PdfLine[] = [];

  const flushBand = () => {
    out.push(...left, ...right);
    left = [];
    right = [];
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    // A row whose first run already runs past the corridor may still be a
    // full-width line that stops short of a quarter into the right column (a
    // caption's last, short line). With no left-column line above it there is no
    // column for it to overhang, so it is a band line. Two columns never do
    // this: their left line stops at the corridor.
    const crossing = rowCrosses(row, rules) || (left.length === 0 && rowStartsWide(row, rules));

    if (crossing && !(sentencesContinue && splitsSentence(rows, i, left, rules))) {
      flushBand();
      out.push(makeLine(row));
      continue;
    }

    const leftItems = row.filter((item) => item.x + item.w / 2 < middle);
    const rightItems = row.filter((item) => item.x + item.w / 2 >= middle);
    if (leftItems.length) left.push(makeLine(leftItems));
    if (rightItems.length) right.push(makeLine(rightItems));
  }

  flushBand();
}

/**
 * True when flushing this wide row would cut a sentence in two: the left column
 * stops mid-sentence above it and resumes with a lower-case word below it.
 * Justified lines occasionally push a word past the corridor, and such a row is
 * still part of its column — a title never resumes a sentence.
 */
function splitsSentence(rows: PdfTextItem[][], index: number, left: PdfLine[], rules: ColumnRules): boolean {
  const last = left[left.length - 1];
  if (!last || SENTENCE_END.test(last.text.trimEnd())) return false;

  for (let i = index + 1; i < rows.length; i++) {
    const row = rows[i];
    // Another full-width line under this one means the wide row belongs to a
    // full-width block (a caption, a heading), and no column resumes under it.
    if (rowCrosses(row, rules) || rowStartsWide(row, rules)) return false;
    const leftItems = row.filter((item) => item.x + item.w / 2 < rules.middle);
    if (!leftItems.length) continue;
    return /^[a-z]/.test(makeLine(leftItems).text.trimStart());
  }
  return false;
}

/** A line that a reader would see end (a stop, a colon, a bracket, a quote). */
const SENTENCE_END = /[.!?:;)\u201d"]$/;

/**
 * The gutter a book's pages mostly share. A page whose own text is too thin to
 * show a corridor is still read in the book's two columns, so long as a real
 * majority of the text pages showed it — a handful of pages cannot speak for
 * the file.
 */
export function documentGutter(gutters: readonly (Gutter | null)[], textPages: number): Gutter | null {
  const found = gutters.filter((gutter): gutter is Gutter => gutter !== null);
  if (!found.length) return null;
  if (found.length < 3 && found.length < textPages / 2) return null;
  return {
    start: median(found.map((gutter) => gutter.start)),
    end: median(found.map((gutter) => gutter.end)),
  };
}

/**
 * True when the page's rows mostly run down the corridor's columns instead of
 * across it. Text running up to both edges of a corridor cannot tell a
 * two-column page from a one-column page whose lines happen to be cut by it:
 * a full-width line also abuts both sides. The shape of the rows can.
 */
export function pageRunsInColumns(items: readonly PdfTextItem[], gutter: Gutter): boolean {
  const rows = groupRows(items);
  if (!rows.length) return false;

  const gap = Math.max(6, (gutter.end - gutter.start) * 0.6);
  let across = 0;
  for (const row of rows) {
    if (mergedRuns(row, gap).some(([start, end]) => start < gutter.start && end > gutter.end)) across++;
  }
  return across * 2 < rows.length;
}

/**
 * Text runs right up to both edges of `gutter` — the test that keeps a figure's
 * white space from passing as a corridor. Used page by page, and by pdf.ts to
 * decide whether an otherwise gutterless page can take the book's gutter.
 */
export function gutterHasTextOnBothSides(
  items: readonly PdfTextItem[],
  gutter: Gutter,
  width: number,
  minimum = 3,
): boolean {
  const near = Math.max(8, width * 0.02);
  const leftItems = items.filter((item) => item.x + item.w <= gutter.start + 2);
  const rightItems = items.filter((item) => item.x >= gutter.end - 2);
  // A corridor between two columns has a column's measure on each side of it. A
  // bullet is 6 pt wide and its line starts just right of it: that gap is between
  // a marker and its text, and splitting there reads every bullet of the page
  // before any of its lines (the NMC one-column guidelines do exactly this).
  // The whole run has to be that wide, not one item: a justified line's last item
  // is often a short word, and its page is still two columns.
  const measure = width * 0.15;
  const gap = Math.max(6, (gutter.end - gutter.start) * 0.6);
  const runs = groupRows(items).flatMap((row) => mergedRuns(row, gap));
  const leftAbuts = runs.some(
    ([start, end]) => end <= gutter.start + 2 && end >= gutter.start - near && end - start >= measure,
  );
  const rightAbuts = runs.some(
    ([start, end]) => start >= gutter.end - 2 && start <= gutter.end + near && end - start >= measure,
  );
  return leftItems.length >= minimum && rightItems.length >= minimum && leftAbuts && rightAbuts;
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
  const enough = Math.max(3, Math.floor(rows.length * 0.1));
  return gutterHasTextOnBothSides(rows.flat(), gutter, width, enough) ? gutter : null;
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
function groupRows(items: readonly PdfTextItem[]): PdfTextItem[][] {
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

    // A sentence that runs out at the foot of one column carries on at the head
    // of the next ("…gene have been" / "identified as…"): that is not a new block.
    let breaks =
      !current || !previous || (newColumn && !splitWord && !continuation) || (sizeChange && !splitWord);

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
    const hyphenJoin = /-[\s]*$/.test(paragraph.text) && /^[\p{L}\p{N}(]/u.test(chunk.trimStart());
    if (hyphenJoin) {
      chunk = chunk.trimStart();
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
// No `i` flag on the capital that follows: under `iu`, `\p{Lu}` matches lower
// case too, and "Figure 3 shows that\u2026" \u2014 a sentence of the body \u2014 was marked a
// caption and passed over by the voice.
const CAPTION = /^(?:[Ff]ig(?:ure)?|FIG(?:URE)?|[Tt]ab(?:le)?|TAB(?:LE)?|[Cc]hart|CHART|[Pp]late|PLATE|[Ss]cheme|SCHEME)\s*\.?\s*(?:\d+|[ivxlcIVXLC]+)(?:[.\-\u2013]\d+)*\s*[.:\u2014\u2013-]?\s+\p{Lu}/u;

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
  // A running head is one row however long ("CHAPTER 3 Pharmacokinetics & … 43");
  // the length cap only keeps a wrapped paragraph of body text out.
  if (!rows.length || (rows.length > 1 && paragraph.text.length > 90) || TERMINAL.test(paragraph.text)) return null;
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
 *
 * Only prose continues. The footer, the next page's running head, a figure and
 * its caption sit between the two halves without being part of the sentence, so
 * the join looks past them — and never glues body text onto one of them, which
 * would make the reader skip that text as furniture.
 */
export function stitchPages(paragraphs: PdfParagraph[]): PdfParagraph[] {
  const out: PdfParagraph[] = [];
  const prose = (paragraph: PdfParagraph) => !paragraph.kind || paragraph.kind === 'p';

  for (const paragraph of paragraphs) {
    let at = out.length - 1;
    if (prose(paragraph)) while (at >= 0 && !prose(out[at]) && out[at].kind !== 'h') at--;
    const previous = out[at];
    if (!previous || !prose(previous) || !prose(paragraph) || !continuesAcrossPage(previous, paragraph)) {
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

    out[at] = {
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
