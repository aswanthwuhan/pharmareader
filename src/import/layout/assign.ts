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

  const ordered = orderRegions(
    owned.filter((region) => region.items.length > 0),
    pageWidth,
  );

  const paragraphs: PdfParagraph[] = [];
  const pitch = options.pitch || 0;
  const measure = options.measure || pageWidth;

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
      part.kind = kind;
      paragraphs.push(part);
    }
  }

  if (leftovers.length) {
    // Text no region claimed: a margin note under an image, a watermark, a row
    // the model missed. Drop what cannot be prose rather than inventing a block.
    const lines = itemsToLines(leftovers).filter((line) => hasWords(line.text));
    if (lines.length) {
      const parts = linesToParagraphs(pageNumber, lines, pageWidth, pitch, measure);
      for (const part of parts) part.kind = 'p';
      paragraphs.push(...parts);
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
    const furniture = box.label === 'number' || box.label === 'header' || box.label === 'footer';
    return furniture || box.w * box.h >= pageArea * 0.004;
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
  const spanning = (box: LayoutBox) => box.w >= pageWidth * 0.7;
  const bands = boxes
    .filter(spanning)
    .map((box) => box.y)
    .sort((a, b) => a - b);

  const key = (box: LayoutBox): [number, number, number, number] => {
    // Headers and footers sit outside the flow whatever their geometry says.
    if (box.label === 'page_header' || box.label === 'header') return [-1, 0, box.y, box.x];
    if (box.label === 'page_footer' || box.label === 'footer' || box.label === 'number') {
      return [Number.MAX_SAFE_INTEGER, 0, box.y, box.x];
    }

    const band = bands.filter((top) => top <= box.y + 0.5).length;
    // A region that spans the band is its own band: read it before the columns
    // beside it, which can only be above or below it.
    if (spanning(box)) return [band, -1, box.y, box.x];
    return [band, columnOf(box, boxes.filter((other) => !spanning(other)), pageWidth), box.y, box.x];
  };

  return [...boxes].sort((a, b) => {
    const [bandA, columnA, yA, xA] = key(a);
    const [bandB, columnB, yB, xB] = key(b);
    return bandA - bandB || columnA - columnB || yA - yB || xA - xB;
  });
}

/** Column index of a box, by clustering the left edges of the narrow regions. */
function columnOf(box: LayoutBox, narrow: LayoutBox[], pageWidth: number): number {
  const edges = [...new Set(narrow.map((region) => Math.round(region.x)))].sort((a, b) => a - b);
  const tolerance = Math.max(10, pageWidth * 0.04);
  const columns: number[] = [];
  for (const edge of edges) {
    if (!columns.length || edge - columns[columns.length - 1] > tolerance) columns.push(edge);
  }
  const own = columns.filter((edge) => edge <= box.x + tolerance / 2).length - 1;
  return Math.max(0, own);
}

function hasWords(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}
