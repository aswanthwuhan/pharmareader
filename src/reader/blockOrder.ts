/**
 * Reading order of the blocks printed on one PDF page.
 *
 * The importer decides what is read in which order, and on a two-column page or
 * a shaded panel it can get that wrong. Page view shows the order it chose
 * (LayoutOverlay) and the reader fixes it by hand; these functions turn the
 * parsed document into that list, put a new order back into the document, and
 * save it to the book record.
 *
 * Everything here is pure except `saveReorderedPage`, which writes one row.
 */
import { db } from '../core/db';
import type { Block, ParsedDoc } from '../core/types';

/** A page-space rectangle: PDF user-space units at scale 1, like `PdfRect`. */
export interface PageBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One block printed on a page, with the box that covers its part of it. */
export interface PageBlock {
  chapterIndex: number;
  blockIndex: number;
  blockId: string;
  kind: Block['kind'];
  /** 1-based position in the page's current reading order. */
  order: number;
  box: PageBox;
}

/** The page a block starts on: its first sentence's first rectangle. */
function startsOn(block: Block, page: number): boolean {
  return block.sentences[0]?.pdfRects?.[0]?.page === page;
}

/**
 * The box a block covers on this page: the union of every sentence rectangle
 * that lands on it, so a block split around a figure still gets one box. Null
 * when the block prints nothing here.
 */
function boxOnPage(block: Block, page: number): PageBox | null {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const sentence of block.sentences) {
    for (const rect of sentence.pdfRects ?? []) {
      if (rect.page !== page) continue;
      left = Math.min(left, rect.x);
      top = Math.min(top, rect.y);
      right = Math.max(right, rect.x + rect.w);
      bottom = Math.max(bottom, rect.y + rect.h);
    }
  }
  if (!Number.isFinite(left)) return null;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/**
 * The blocks printed on `page`, in the order the document reads them now.
 *
 * A block belongs to the page its first sentence starts on. One that runs over
 * from the page before is not listed again: it was already numbered there, and
 * the reader's page shows the whole block from its first line.
 */
export function pageBlocks(doc: ParsedDoc, page: number): PageBlock[] {
  const blocks: PageBlock[] = [];
  doc.chapters.forEach((chapter, chapterIndex) => {
    chapter.blocks.forEach((block, blockIndex) => {
      if (!startsOn(block, page)) return;
      const box = boxOnPage(block, page);
      if (!box) return;
      blocks.push({
        chapterIndex,
        blockIndex,
        blockId: block.id,
        kind: block.kind,
        order: blocks.length + 1,
        box,
      });
    });
  });
  return blocks;
}

/**
 * A copy of `doc` where this page's blocks are read in `blockIdsInNewOrder`.
 *
 * Only the slots the blocks already occupied move: every other block, every
 * chapter and every sentence id stays where it was, so highlights, notes and
 * the saved reading position keep pointing at the same sentences. Tapped ids
 * that are not on the page are ignored; ids that were not given keep their
 * relative order and follow the given ones.
 */
export function reorderPage(doc: ParsedDoc, page: number, blockIdsInNewOrder: string[]): ParsedDoc {
  const onPage = new Set(pageBlocks(doc, page).map((block) => block.blockId));
  // A repeated id is one block, not two, and an id from another page has no
  // place in this page's order.
  const wanted = blockIdsInNewOrder.filter(
    (id, at) => onPage.has(id) && blockIdsInNewOrder.indexOf(id) === at
  );

  const chapters = doc.chapters.map((chapter) => {
    const slots: number[] = [];
    chapter.blocks.forEach((block, at) => {
      if (onPage.has(block.id)) slots.push(at);
    });
    if (slots.length < 2) return chapter;

    const before = slots.map((at) => chapter.blocks[at].id);
    // A page can start in one chapter and end in the next: each chapter keeps
    // its own slots, so an order for the page never mixes the two sequences.
    const given = wanted.filter((id) => before.includes(id));
    const after = [...given, ...before.filter((id) => !given.includes(id))];
    // The order the reader just confirmed can be the order it already had.
    if (after.every((id, at) => id === before[at])) return chapter;

    const byId = new Map(chapter.blocks.map((block) => [block.id, block]));
    const blocks = [...chapter.blocks];
    slots.forEach((slot, at) => {
      blocks[slot] = byId.get(after[at]) ?? chapter.blocks[slot];
    });
    return { ...chapter, blocks };
  });

  return { ...doc, chapters };
}

/**
 * Whether the blocks printed on `page` read in a different order in `after`.
 *
 * The caller has to know what saving did, not just that it did something: a
 * document read back from the store is a new object graph every time, so
 * comparing chapters or blocks by identity would always say "changed".
 */
export function pageOrderChanged(before: ParsedDoc, after: ParsedDoc, page: number): boolean {
  const order = (doc: ParsedDoc): string[] => pageBlocks(doc, page).map((block) => block.blockId);
  const was = order(before);
  const now = order(after);
  return was.length !== now.length || was.some((id, at) => id !== now[at]);
}

/**
 * Store a manual page order on the book.
 *
 * `books.parsed` is the only copy the reader, the player and page view read, so
 * it is the one that has to change; the file, the position, the topics and
 * every highlight are untouched. Returns the new document so the caller can
 * show it without a second read, or null when the book is gone.
 */
export async function saveReorderedPage(
  bookId: string,
  page: number,
  blockIdsInNewOrder: string[]
): Promise<ParsedDoc | null> {
  const book = await db.books.get(bookId);
  if (!book) return null;
  const parsed = reorderPage(book.parsed, page, blockIdsInNewOrder);
  await db.books.update(bookId, { parsed });
  return parsed;
}
