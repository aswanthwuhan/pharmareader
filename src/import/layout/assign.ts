import type { PdfParagraph, PdfTextItem } from '../pdfLayout';
import { itemsToLines, linesToParagraph, linesToParagraphs } from '../pdfLayout';
import { type LayoutBox, regionKind } from './engine';

/**
 * Turn the model's page regions back into text. Pure: no pdfjs, no ONNX, so the
 * mapping from boxes to blocks is unit-testable with mock items.
 */

/** A region that owns text: its box, its kind, and the items inside it. */
interface OwnedRegion extends LayoutBox {
  items: PdfTextItem[];
}

export interface AssignOptions {
  /** Body leading of the page (pt); 0 means "too sparse to measure". */
  pitch: number;
  /** Full-width line of the page (pt); 0 means "use the page width". */
  measure: number;
}

/**
 * Group the page's text items by the region that contains them, then read those
 * regions in reading order.
 */
export function layoutParagraphs(
  pageNumber: number,
  pageWidth: number,
  pageHeight: number,
  items: PdfTextItem[],
  boxes: LayoutBox[],
  options: AssignOptions,
): PdfParagraph[] {
  const regions = usableRegions(boxes, pageWidth, pageHeight);
  const owned: OwnedRegion[] = regions.map((box) => ({ ...box, items: [] }));
  const leftovers: PdfTextItem[] = [];

  for (const item of items) {
    const owner = nearestRegion(owned, item, pageWidth);
    if (owner) owner.items.push(item);
    else leftovers.push(item);
  }

  const pitch = options.pitch || 0;
  const measure = options.measure || pageWidth;

  // Text no region claimed: a margin note under an image, a watermark, a row
  // the model missed. Drop what cannot be prose rather than inventing a block,
  // and give the rest a box of its own so it is read where it is printed — tacked
  // on after the footer, a paragraph the model scored too low lands a page late.
  const strayLines = itemsToLines(leftovers).filter((line) => hasWords(line.text));
  for (const stray of linesToParagraphs(pageNumber, strayLines, pageWidth, pitch, measure)) {
    const box = bounds(stray);
    if (!box) continue;
    owned.push({
      x: box.left,
      y: box.top,
      w: box.right - box.left,
      h: box.bottom - box.top,
      label: 'text',
      score: 0,
      items: stray.spans.map((span) => span.item),
    });
  }

  const ordered = orderRegions(
    owned.filter((region) => region.items.length > 0),
    pageWidth,
  );

  const paragraphs: PdfParagraph[] = [];

  for (const region of ordered) {
    const kind = regionKind(region.label);
    if (!kind) continue;
    const lines = itemsToLines(region.items);
    // A table holds cells, not prose: keep the whole region as one block so the
    // reader can skip it as a unit instead of reading rows as sentences.
    const parts =
      kind === 'table' || kind === 'code'
        ? [linesToParagraph(pageNumber, lines)]
        : linesToParagraphs(pageNumber, lines, pageWidth, pitch, measure);
    for (const part of parts) {
      // A picture box drawn too large takes the paragraph beside it with it, and
      // the voice then skips that paragraph as part of the figure. Labels inside
      // a diagram are short; running text that fills the measure is prose.
      // On a page that is mostly picture the measure is a caption's width, which
      // a chart legend would fill; half the sheet is the least a text line spans.
      part.kind = kind === 'figure' && isProse(part, Math.max(measure, pageWidth * 0.5)) ? 'p' : kind;
      paragraphs.push(part);
    }
  }

  return joinStacked(paragraphs.filter((paragraph) => hasWords(paragraph.text)));
}

/**
 * The model often cuts one region into a stack of boxes: "Figure 2" above the
 * caption it belongs to, a heading that wrapped onto two lines, a table split by
 * a row rule. Those are one block for the reader, so join them back.
 */
function joinStacked(paragraphs: PdfParagraph[]): PdfParagraph[] {
  const out: PdfParagraph[] = [];

  for (const paragraph of paragraphs) {
    const previous = out[out.length - 1];
    if (previous && previous.kind === paragraph.kind && paragraph.kind !== 'p' && stacks(previous, paragraph)) {
      const head = `${previous.text} `;
      out[out.length - 1] = {
        page: previous.page,
        kind: previous.kind,
        text: head + paragraph.text,
        spans: [
          ...previous.spans,
          ...paragraph.spans.map((span) => ({ ...span, start: span.start + head.length, end: span.end + head.length })),
        ],
      };
      continue;
    }
    out.push(paragraph);
  }

  return out;
}

/** Directly underneath, overlapping horizontally: one region the model split. */
function stacks(upper: PdfParagraph, lower: PdfParagraph): boolean {
  const a = bounds(upper);
  const b = bounds(lower);
  if (!a || !b) return false;

  const gap = b.top - a.bottom;
  const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  return gap >= -4 && gap <= 8 && overlap > 0;
}

function bounds(paragraph: PdfParagraph) {
  if (!paragraph.spans.length) return null;
  const items = paragraph.spans.map((span) => span.item);
  return {
    left: Math.min(...items.map((item) => item.x)),
    right: Math.max(...items.map((item) => item.x + item.w)),
    top: Math.min(...items.map((item) => item.y)),
    bottom: Math.max(...items.map((item) => item.y + item.h)),
  };
}

/** Boxes worth reading in reading order: known kinds only, no hairline noise. */
export function usableRegions(boxes: LayoutBox[], pageWidth: number, pageHeight: number): LayoutBox[] {
  const pageArea = pageWidth * pageHeight;

  return boxes.filter((box) => {
    if (!regionKind(box.label)) return false;
    if (box.w <= 0 || box.h <= 0) return false;
    // A page number or a running head is tiny by nature; anything else this small
    // is an inline formula fragment or a rule, and claiming text for it would
    // tear a sentence in half.
    // Only a picture or a formula can be that kind of noise: a one-line heading
    // or a short paragraph is 0.2% of the page and is exactly what the model is for.
    const kind = regionKind(box.label);
    const noisy = kind === 'figure' || kind === 'formula';
    return !noisy || box.w * box.h >= pageArea * 0.004;
  });
}

/**
 * The region an item belongs to: the innermost box whose centre holds the item's
 * centre, else the closest box that is near enough to have lost it.
 */
function nearestRegion(regions: OwnedRegion[], item: PdfTextItem, pageWidth: number): OwnedRegion | null {
  const centreX = item.x + item.w / 2;
  const centreY = item.y + item.h / 2;
  let inside: OwnedRegion | null = null;
  let nearest: OwnedRegion | null = null;
  let nearestDistance = Infinity;

  for (const region of regions) {
    const holds =
      centreX >= region.x && centreX <= region.x + region.w && centreY >= region.y && centreY <= region.y + region.h;
    if (holds && (!inside || region.w * region.h < inside.w * inside.h)) inside = region;
    if (holds) continue;

    const dx = Math.max(region.x - centreX, 0, centreX - (region.x + region.w));
    const dy = Math.max(region.y - centreY, 0, centreY - (region.y + region.h));
    const distance = Math.hypot(dx, dy);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = region;
    }
  }

  if (inside) return inside;
  // A box's bounds sit a point or two inside the glyphs it was drawn around, so
  // accept a near miss; far away, the item is simply outside every region.
  return nearestDistance <= Math.max(12, pageWidth * 0.02) ? nearest : null;
}

/**
 * Reading order of regions. The model we ship gives boxes and classes but no
 * order, and sorting by y splices a two-column page into alternating columns, so
 * order by band first: full-width regions (a title, a figure legend) cut the page
 * into bands, and each band is read column by column.
 */
export function orderRegions<T extends LayoutBox>(boxes: T[], pageWidth: number): T[] {
  // Measured against the text block, not the sheet: a single column with wide
  // margins is under 70% of the page, and treating its paragraphs as columns
  // sends a centred heading to the end of the page.
  const flow = boxes.filter((box) => !FURNITURE.has(box.label));
  const extent = flow.length
    ? Math.max(...flow.map((box) => box.x + box.w)) - Math.min(...flow.map((box) => box.x))
    : pageWidth;
  const spanning = (box: LayoutBox) => box.w >= Math.min(pageWidth, extent) * 0.7;
  const bands = boxes
    .filter(spanning)
    .map((box) => box.y)
    .sort((a, b) => a - b);

  const key = (box: LayoutBox): [number, number, number, number] => {
    // Headers and footers sit outside the flow whatever their geometry says.
    if (box.label === 'page_header' || box.label === 'header') return [-1, 0, box.y, box.x];
    if (FURNITURE.has(box.label)) return [Number.MAX_SAFE_INTEGER, 0, box.y, box.x];

    const band = bands.filter((top) => top <= box.y + 0.5).length;
    // A region that spans the band is its own band: read it before the columns
    // beside it, which can only be above or below it.
    if (spanning(box)) return [band, -1, box.y, box.x];
    return [band, columnOf(box, flow.filter((other) => !spanning(other)), pageWidth), box.y, box.x];
  };

  return [...boxes].sort((a, b) => {
    const [bandA, columnA, yA, xA] = key(a);
    const [bandB, columnB, yB, xB] = key(b);
    // Within a column a row reads left to right, whichever box starts a hair higher.
    return bandA - bandB || columnA - columnB || (sameRow(a, b, pageWidth) ? xA - xB : yA - yB || xA - xB);
  });
}

/**
 * Side by side on a single line: tops and bottoms agree to within half a line.
 * Both have to *be* one line (up to 21 pt on a 600 pt page, a large heading):
 * two paragraphs that start and end together are columns, however alike.
 */
function sameRow(a: LayoutBox, b: LayoutBox, pageWidth: number): boolean {
  if (Math.max(a.h, b.h) > pageWidth * 0.035) return false;
  const slack = Math.min(a.h, b.h) / 2;
  return Math.abs(a.y - b.y) <= slack && Math.abs(a.y + a.h - (b.y + b.h)) <= slack;
}

const FURNITURE = new Set(['page_header', 'header', 'page_footer', 'footer', 'number']);

/**
 * Column index of a box, by clustering the left edges of the narrow regions. A
 * left edge only starts a column when something stands beside it: a centred
 * heading or an indented line has an edge of its own but nothing to its left on
 * the same rows, and it belongs to the column it sits in.
 */
function columnOf(box: LayoutBox, narrow: LayoutBox[], pageWidth: number): number {
  const tolerance = Math.max(10, pageWidth * 0.04);
  // Two boxes on one line of type are a row (a form field and its value, a
  // number and its heading), not two columns: only stacked text proves a column.
  const standing = (region: LayoutBox) =>
    narrow.filter(
      (other) =>
        other.x + other.w <= region.x + tolerance / 2 &&
        other.y < region.y + region.h &&
        region.y < other.y + other.h,
    );
  const beside = (region: LayoutBox) => standing(region).some((other) => !sameRow(other, region, pageWidth));
  // How many rows sit on one left edge. A column of one-line items (a two-column
  // list, a glossary) can line up row for row with the text beside it, so `beside`
  // finds nothing that is not on a row. A stack of its own rows still makes it a
  // column — but a form has that shape too (a label, then its value, three times
  // over), so only when the gutter between it and the text on its left is a
  // gutter: a narrow fraction of the columns, not half the sheet.
  const rowsAt = (edge: number) => {
    const tops = narrow
      .filter((region) => Math.abs(region.x - edge) <= tolerance / 2)
      .map((region) => region.y)
      .sort((a, b) => a - b);
    return tops.filter((top, index) => index === 0 || top - tops[index - 1] > 4).length;
  };
  const columnOfRows = (region: LayoutBox) =>
    rowsAt(Math.round(region.x)) >= 3 &&
    standing(region).some(
      (other) =>
        region.x - (other.x + other.w) <= Math.max(tolerance, Math.min(other.w, region.w) / 4),
    );
  const columns: number[] = [];
  let last = -Infinity;
  for (const region of [...narrow].sort((a, b) => a.x - b.x)) {
    const edge = Math.round(region.x);
    if (edge - last <= tolerance) continue;
    if (columns.length && !beside(region) && !columnOfRows(region)) continue;
    columns.push(edge);
    last = edge;
  }
  const own = columns.filter((edge) => edge <= box.x + tolerance / 2).length - 1;
  return Math.max(0, own);
}

/** Two or more lines that fill most of the measure, and a paragraph's worth of text. */
function isProse(paragraph: PdfParagraph, measure: number): boolean {
  if (paragraph.text.length < 150) return false;
  const wide = itemsToLines(paragraph.spans.map((span) => span.item)).filter((line) => line.w >= measure * 0.6);
  return wide.length >= 2;
}

function hasWords(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}
