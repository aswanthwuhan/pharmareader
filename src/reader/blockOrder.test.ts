import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../core/db';
import type { Block, ParsedDoc } from '../core/types';
import { pageBlocks, pageOrderChanged, reorderPage, saveReorderedPage } from './blockOrder';

/** `[page, x, y, w, h]`, in the order PdfRect is written. */
type RectSpec = [page: number, x: number, y: number, w: number, h: number];

function block(id: string, kind: Block['kind'], sentences: RectSpec[][]): Block {
  return {
    id,
    kind,
    sentences: sentences.map((rects, at) => ({
      id: `${id}-s${at}`,
      text: `${id} sentence ${at}`,
      pdfRects: rects.map(([page, x, y, w, h]) => ({ page, x, y, w, h })),
    })),
  };
}

function paper(...chapters: Array<{ title: string; blocks: Block[] }>): ParsedDoc {
  return {
    title: 'Paper',
    format: 'pdf',
    chapters: chapters.map((chapter, at) => ({ id: `ch-${at}`, title: chapter.title, blocks: chapter.blocks })),
  };
}

const ids = (blocks: Array<{ blockId: string }>): string[] => blocks.map((block) => block.blockId);

/** The document's block ids, chapter by chapter, in the order they read now. */
const layout = (doc: ParsedDoc): string[][] => doc.chapters.map((chapter) => chapter.blocks.map((block) => block.id));

describe('pageBlocks', () => {
  it('lists the blocks that start on the page, numbered in document order', () => {
    const doc = paper(
      {
        title: 'One',
        blocks: [
          block('a', 'p', [[[1, 10, 20, 100, 12]]]),
          block('b', 'h', [[[2, 10, 40, 80, 18]]]),
        ],
      },
      {
        title: 'Two',
        blocks: [
          block('c', 'figure', [[[1, 10, 60, 200, 100]]]),
          block('d', 'p', [[[3, 10, 10, 90, 12]]]),
        ],
      }
    );

    expect(pageBlocks(doc, 1).map((b) => [b.blockId, b.order, b.chapterIndex, b.blockIndex])).toEqual([
      ['a', 1, 0, 0],
      ['c', 2, 1, 0],
    ]);
    expect(ids(pageBlocks(doc, 2))).toEqual(['b']);
    expect(ids(pageBlocks(doc, 3))).toEqual(['d']);
  });

  it('boxes a block with the union of its rectangles on this page only', () => {
    const split = block('a', 'p', [
      [
        [1, 10, 20, 50, 10],
        [1, 70, 20, 30, 10],
      ],
      // A second sentence, and a rectangle from another page that must not
      // stretch the box.
      [
        [1, 10, 40, 90, 10],
        [2, 10, 5, 999, 999],
      ],
    ]);

    const [only] = pageBlocks(paper({ title: 'One', blocks: [split] }), 1);
    expect(only.box).toEqual({ x: 10, y: 20, w: 90, h: 30 });
  });

  it('gives a block to the page it starts on, not to every page it runs onto', () => {
    const running = block('a', 'p', [[[1, 10, 10, 90, 10]], [[2, 10, 10, 90, 10]]]);
    const next = block('b', 'p', [[[2, 10, 30, 90, 10]]]);
    const doc = paper({ title: 'One', blocks: [running, next] });

    expect(ids(pageBlocks(doc, 1))).toEqual(['a']);
    expect(ids(pageBlocks(doc, 2))).toEqual(['b']);
  });

  it('skips a block whose first sentence has no rectangles', () => {
    const bare: Block = { id: 'bare', kind: 'p', sentences: [{ id: 'bare-0', text: 'no rects' }] };
    const startsElsewhere = block('late', 'p', [[[2, 10, 10, 90, 10]], [[1, 10, 30, 90, 10]]]);
    const doc = paper({ title: 'One', blocks: [bare, startsElsewhere] });

    expect(pageBlocks(doc, 1)).toEqual([]);
  });

  it('has nothing to say about a page without blocks', () => {
    const doc = paper({ title: 'One', blocks: [block('a', 'p', [[[1, 10, 10, 90, 10]]])] });
    expect(pageBlocks(doc, 9)).toEqual([]);
  });
});

describe('reorderPage', () => {
  const a = block('a', 'p', [[[1, 10, 10, 90, 10]]]);
  const b = block('b', 'p', [[[1, 10, 30, 90, 10]]]);
  const c = block('c', 'p', [[[1, 10, 50, 90, 10]]]);

  const doc = (): ParsedDoc =>
    paper(
      { title: 'One', blocks: [block('lead', 'h', [[[2, 10, 10, 90, 20]]]), c, a, b] },
      { title: 'Two', blocks: [block('tail', 'p', [[[2, 10, 60, 90, 10]]])] }
    );

  it('fills the slots the blocks already had, in the new order', () => {
    const before = doc();
    const after = reorderPage(before, 1, ['b', 'a']);

    // 'c' was not tapped: it keeps its own order and follows the tapped ones.
    expect(layout(after)).toEqual([
      ['lead', 'b', 'a', 'c'],
      ['tail'],
    ]);
    // The blocks themselves are the same objects: their sentence ids, and so
    // every highlight and note, still point at the same sentences.
    expect(after.chapters[0].blocks[1]).toBe(b);
    expect(after.chapters[0].blocks[2]).toBe(a);
    expect(after.chapters[0].blocks[3]).toBe(c);
    expect(after.chapters[1].blocks[0]).toBe(before.chapters[1].blocks[0]);
  });

  it('does not change the document it was given', () => {
    const before = doc();
    const snapshot = JSON.stringify(before);
    reorderPage(before, 1, ['b', 'a', 'c']);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('ignores ids from another page and repeats of the same id', () => {
    const after = reorderPage(doc(), 1, ['b', 'b', 'not-on-this-page', 'a']);
    expect(layout(after)[0]).toEqual(['lead', 'b', 'a', 'c']);
  });

  it('keeps untapped blocks in their relative order, after the tapped ones', () => {
    const after = reorderPage(doc(), 1, ['a']);
    expect(layout(after)[0]).toEqual(['lead', 'a', 'c', 'b']);
  });

  it('leaves a document whose order did not change alone', () => {
    const before = doc();
    const after = reorderPage(before, 1, ['c', 'a', 'b']);
    expect(after.chapters[0]).toBe(before.chapters[0]);
  });

  it('reorders within each chapter when a page spans two of them', () => {
    const doc = paper(
      { title: 'One', blocks: [a, b] },
      { title: 'Two', blocks: [c, block('d', 'p', [[[1, 10, 70, 90, 10]]])] }
    );

    const after = reorderPage(doc, 1, ['d', 'a', 'c', 'b']);
    // Each chapter fills its own slots: 'a','b' in chapter one, 'c','d' in
    // chapter two — the page order never mixes the two sequences.
    expect(layout(after)).toEqual([
      ['a', 'b'],
      ['d', 'c'],
    ]);
  });

  it('never repeats a block when the same id is given twice', () => {
    const after = reorderPage(doc(), 1, ['b', 'a', 'b', 'a', 'c']);
    expect(layout(after)[0]).toEqual(['lead', 'b', 'a', 'c']);
  });
});

describe('pageOrderChanged', () => {
  const before = (): ParsedDoc =>
    paper({ title: 'One', blocks: [block('a', 'p', [[[1, 10, 10, 90, 10]]]), block('b', 'p', [[[1, 10, 30, 90, 10]]])] });

  it('sees a page whose blocks really changed order', () => {
    const doc = before();
    expect(pageOrderChanged(doc, reorderPage(doc, 1, ['b', 'a']), 1)).toBe(true);
  });

  it('does not take a stored copy of the same order for a change', () => {
    // The saved document comes back from the store as new objects: the reader
    // must not be told the order moved, or playback stops for nothing.
    const doc = before();
    const stored = JSON.parse(JSON.stringify(doc)) as ParsedDoc;
    expect(pageOrderChanged(doc, stored, 1)).toBe(false);
    // Nor does a save that puts the same order back.
    expect(pageOrderChanged(doc, reorderPage(doc, 1, ['a', 'b']), 1)).toBe(false);
  });

  it('ignores a change on another page', () => {
    const doc = paper(
      { title: 'One', blocks: [block('a', 'p', [[[1, 10, 10, 90, 10]]])] },
      {
        title: 'Two',
        blocks: [block('b', 'p', [[[2, 10, 30, 90, 10]]]), block('c', 'p', [[[2, 10, 50, 90, 10]]])],
      }
    );
    const moved = reorderPage(doc, 2, ['c', 'b']);
    expect(pageOrderChanged(doc, moved, 1)).toBe(false);
    expect(pageOrderChanged(doc, moved, 2)).toBe(true);
  });
});

describe('saveReorderedPage', () => {
  afterEach(async () => {
    await db.delete();
    await db.open();
  });

  async function addBook(parsed: ParsedDoc): Promise<void> {
    await db.books.add({
      id: 'book',
      title: 'Paper',
      format: 'pdf',
      addedAt: 1,
      // jsdom's Blob does not survive fake-indexeddb's structured clone; Node's does.
      fileBlob: new NodeBlob(['%PDF-1.4 bytes']) as unknown as Blob,
      parsed,
      topicIds: [],
    });
  }

  it('writes the new order into the book record and returns it', async () => {
    await addBook(
      paper({
        title: 'One',
        blocks: [
          block('a', 'p', [[[1, 10, 10, 90, 10]]]),
          block('b', 'p', [[[1, 10, 30, 90, 10]]]),
        ],
      })
    );

    const saved = await saveReorderedPage('book', 1, ['b', 'a']);
    expect(saved && layout(saved)).toEqual([['b', 'a']]);

    const record = await db.books.get('book');
    expect(record && layout(record.parsed)).toEqual([['b', 'a']]);
  });

  it('returns null for a book that is not there', async () => {
    expect(await saveReorderedPage('missing', 1, ['a'])).toBeNull();
  });
});
