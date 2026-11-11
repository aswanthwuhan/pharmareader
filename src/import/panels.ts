import './pdfPolyfill';
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { PanelRect } from './layout/assign';
import type { PdfTextItem } from './pdfLayout';

/**
 * Boxed panels: the shaded sidebars a textbook puts across both columns
 * ("Clinical Significance", "The Target Concentration Strategy", a figure
 * box). They are vector graphics, so the text alone cannot show them: the
 * page then reads a panel's two inner columns as if they were the page's own
 * columns. Finding the painted box lets `itemsToPageLines` treat its top and
 * bottom as band boundaries.
 *
 * The box geometry has to come from the operator list, which means tracking the
 * CTM (save / restore / transform) and reading pdf.js 6's `constructPath` args.
 */

/**
 * The slice of pdf.js `OPS` this module reads. Passing it in keeps
 * `panelRects` pure and testable with a handful of fake operators; the real
 * `OPS` object satisfies it.
 */
export interface VectorOps {
  save: number;
  restore: number;
  transform: number;
  setLineWidth: number;
  constructPath: number;
  paintFormXObjectBegin: number;
  paintFormXObjectEnd: number;
  fill: number;
  eoFill: number;
  stroke: number;
  closeStroke: number;
  fillStroke: number;
  eoFillStroke: number;
  closeFillStroke: number;
  closeEOFillStroke: number;
}

/** Boxes at least this tall are panels; shorter painted bars are title bars. */
const MIN_HEIGHT = 30;
/** A panel spans both columns, so it takes most of the width. */
const MIN_WIDTH_FRACTION = 0.4;
/** A painted path covering nearly the whole page is a background, not a panel. */
const MAX_AREA_FRACTION = 0.9;
/**
 * A title bar painted as a thick rule sits ~6 pt above its box (measured on the
 * sample book); the half point absorbs the float noise in the painted edges.
 */
const MERGE_GAP = 6.5;
/** Title bar and box may differ slightly; 80% is "the same width". */
const MERGE_OVERLAP = 0.8;

/**
 * Panels painted on a page. Pure: reads an operator list, returns geometry.
 *
 * Deliberately forgiving — a malformed operator list must not fail an import,
 * so every unexpected shape is skipped and any throw returns no panels.
 */
export function panelRects(
  fnArray: ArrayLike<number>,
  argsArray: ArrayLike<readonly unknown[]>,
  ops: VectorOps,
  viewportTransform: readonly number[],
  pageWidth: number,
  pageHeight: number,
  items: readonly PdfTextItem[],
): PanelRect[] {
  try {
    return collect(fnArray, argsArray, ops, viewportTransform, pageWidth, pageHeight, items);
  } catch {
    return [];
  }
}

function collect(
  fnArray: ArrayLike<number>,
  argsArray: ArrayLike<readonly unknown[]>,
  ops: VectorOps,
  viewportTransform: readonly number[],
  pageWidth: number,
  pageHeight: number,
  items: readonly PdfTextItem[],
): PanelRect[] {
  if (!(pageWidth > 0) || !(pageHeight > 0)) return [];

  const painted = paintedRects(fnArray, argsArray, ops, viewportTransform, pageWidth, pageHeight);
  const middle = pageWidth / 2;

  return mergeRects(painted)
    .filter(
      (rect) =>
        rect.h >= MIN_HEIGHT &&
        rect.w >= pageWidth * MIN_WIDTH_FRACTION &&
        rect.x < middle &&
        rect.x + rect.w > middle &&
        rect.w * rect.h < pageWidth * pageHeight * MAX_AREA_FRACTION &&
        hasTextOnBothSides(rect, middle, items),
    )
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

/** Painted paths wide enough to be a panel, in page units. */
function paintedRects(
  fnArray: ArrayLike<number>,
  argsArray: ArrayLike<readonly unknown[]>,
  ops: VectorOps,
  viewportTransform: readonly number[],
  pageWidth: number,
  pageHeight: number,
): PanelRect[] {
  const fills = new Set([ops.fill, ops.eoFill]);
  const strokes = new Set([
    ops.stroke,
    ops.closeStroke,
    ops.fillStroke,
    ops.eoFillStroke,
    ops.closeFillStroke,
    ops.closeEOFillStroke,
  ]);
  const paints = new Set([...fills, ...strokes]);

  const rects: PanelRect[] = [];
  const middle = pageWidth / 2;
  const maxArea = pageWidth * pageHeight * MAX_AREA_FRACTION;

  // Graphics state: the CTM starts at the viewport's PDF→page transform, and the
  // line width matters because a title bar is painted as a thick stroked line
  // whose bounding box has no height at all.
  let ctm = readNumbers(viewportTransform, 6) ?? [1, 0, 0, 1, 0, 0];
  let lineWidth = 1;
  const stack: { ctm: number[]; lineWidth: number }[] = [];

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];

    if (fn === ops.save) {
      stack.push({ ctm, lineWidth });
      continue;
    }
    if (fn === ops.restore) {
      const state = stack.pop();
      if (state) ({ ctm, lineWidth } = state);
      continue;
    }
    if (fn === ops.transform) {
      const matrix = readNumbers(args, 6);
      if (matrix) ctm = multiply(ctm, matrix);
      continue;
    }
    // A form XObject paints its own save/transform in one operator (pdf.js
    // `paintFormXObjectBegin`) and restores it in `paintFormXObjectEnd`.
    if (fn === ops.paintFormXObjectBegin) {
      stack.push({ ctm, lineWidth });
      const matrix = readNumbers(args?.[0], 6);
      if (matrix) ctm = multiply(ctm, matrix);
      continue;
    }
    if (fn === ops.paintFormXObjectEnd) {
      const state = stack.pop();
      if (state) ({ ctm, lineWidth } = state);
      continue;
    }
    if (fn === ops.setLineWidth) {
      const width = Number(args?.[0]);
      if (Number.isFinite(width) && width > 0) lineWidth = width;
      continue;
    }
    if (fn !== ops.constructPath) continue;

    // pdf.js 6: `constructPath` args are [paintOp, pathData, minMax], where
    // minMax is [minX, minY, maxX, maxY] in PDF user space, NOT pre-transformed
    // (the operator list only folds a pure translation into it).
    const paint = Number(args?.[0]);
    if (!paints.has(paint)) continue;
    const minMax = readNumbers(args?.[2], 4);
    if (!minMax) continue;

    const [minX, minY, maxX, maxY] = minMax;
    const corners = [apply(ctm, minX, minY), apply(ctm, minX, maxY), apply(ctm, maxX, minY), apply(ctm, maxX, maxY)];
    const xs = corners.map((point) => point[0]);
    const ys = corners.map((point) => point[1]);
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    // A stroke paints half its width on either side of the path.
    const pad = strokes.has(paint) ? lineWidth / 2 : 0;
    const rect: PanelRect = {
      x: left - pad,
      y: top - pad,
      w: Math.max(...xs) - left + 2 * pad,
      h: Math.max(...ys) - top + 2 * pad,
    };

    // Filter before merging: the page frame is a huge stroked rectangle that
    // overlaps every panel, and merging it in would swallow the panel whole.
    if (!(rect.w >= pageWidth * MIN_WIDTH_FRACTION)) continue;
    if (rect.w * rect.h >= maxArea) continue;
    if (!(rect.x < middle && rect.x + rect.w > middle)) continue;
    if (!(rect.h >= 2)) continue;
    rects.push(rect);
  }

  return rects;
}

/** Union of rects that are stacked on each other (a title bar on its box). */
function mergeRects(rects: PanelRect[]): PanelRect[] {
  const merged: PanelRect[] = [];

  for (const rect of rects) {
    let current = rect;
    let touched = true;
    // A merged rect may reach the next one, so rescan until nothing joins.
    while (touched) {
      touched = false;
      for (let i = 0; i < merged.length; i++) {
        if (!touches(current, merged[i])) continue;
        current = union(current, merged[i]);
        merged.splice(i, 1);
        touched = true;
        break;
      }
    }
    merged.push(current);
  }

  return merged;
}

function touches(a: PanelRect, b: PanelRect): boolean {
  const overlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  if (!(overlap >= Math.min(a.w, b.w) * MERGE_OVERLAP)) return false;
  const gap = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
  return gap <= MERGE_GAP;
}

function union(a: PanelRect, b: PanelRect): PanelRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

/** A real panel holds text in both of the page's columns. */
function hasTextOnBothSides(rect: PanelRect, middle: number, items: readonly PdfTextItem[]): boolean {
  let left = false;
  let right = false;

  for (const item of items) {
    if (!item.str.trim()) continue;
    const centreX = item.x + item.w / 2;
    const centreY = item.y + item.h / 2;
    if (centreX < rect.x || centreX > rect.x + rect.w) continue;
    if (centreY < rect.y || centreY > rect.y + rect.h) continue;
    if (centreX < middle) left = true;
    else if (centreX > middle) right = true;
    if (left && right) return true;
  }

  return false;
}

/** `count` finite numbers of `value`, or null when it is not a numeric list. */
function readNumbers(value: unknown, count: number): number[] | null {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return null;
  const numbers = value as ArrayLike<unknown>;
  if (numbers.length < count) return null;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const entry = Number(numbers[i]);
    if (!Number.isFinite(entry)) return null;
    out.push(entry);
  }
  return out;
}

/** Canvas-style matrix product: `first` then `second` (as `ctx.transform` composes). */
function multiply(first: number[], second: number[]): number[] {
  return [
    first[0] * second[0] + first[2] * second[1],
    first[1] * second[0] + first[3] * second[1],
    first[0] * second[2] + first[2] * second[3],
    first[1] * second[2] + first[3] * second[3],
    first[0] * second[4] + first[2] * second[5] + first[4],
    first[1] * second[4] + first[3] * second[5] + first[5],
  ];
}

function apply(matrix: number[], x: number, y: number): [number, number] {
  return [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
}

/**
 * Panels for one page, read from its operator list. Never throws: a page whose
 * graphics cannot be read simply has no panels.
 */
export async function pagePanels(
  page: Pick<PDFPageProxy, 'getOperatorList'>,
  viewport: { transform: number[]; width: number; height: number },
  items: readonly PdfTextItem[],
): Promise<PanelRect[]> {
  try {
    const list = await page.getOperatorList();
    return panelRects(
      list.fnArray,
      list.argsArray,
      OPS,
      viewport.transform,
      viewport.width,
      viewport.height,
      items,
    );
  } catch {
    return [];
  }
}
