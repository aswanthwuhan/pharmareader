import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../core/db';
import type { Block, Highlight, ParsedDoc } from '../core/types';
import { importFileDetailed, reanalyseBook, setBookColumns } from './index';
import type { PdfParseResult } from './pdf';

// The parser is replaced so each case decides what "the new layout" looks like.
const next = vi.hoisted(() => ({ result: null as unknown, bytes: 0, options: null as unknown }));
vi.mock('./pdf', () => ({
  parsePdf: async (data: ArrayBuffer, _title: string, _onProgress?: unknown, options?: unknown) => {
    next.bytes = data.byteLength;
    next.options = options;
    return next.result;
  },
}));

/** Chapters of blocks of sentences; ids are positional, exactly as `pdfLayout` numbers them. */
function doc(chapters: Record<string, string[][]>): ParsedDoc {
  return {
    title: 'Paper',
    format: 'pdf',
    chapters: Object.entries(chapters).map(([title, blocks], c) => ({
      id: `ch-${c}`,
      title,
      blocks: blocks.map(
        (sentences, b): Block => ({
          id: `b-${c}-${b}`,
          kind: 'p',
          sentences: sentences.map((text, s) => ({ id: `${c}-${b}-${s}`, text })),
        }),
      ),
    })),
  };
}

function parsesTo(parsed: ParsedDoc, layout: PdfParseResult['layout'] = 'heuristic'): void {
  next.result = { doc: parsed, charsPerPage: 900, pageCount: 2, layout, modelPages: layout === 'model' ? 1 : 0 };
  next.options = null;
}

async function addBook(parsed: ParsedDoc, extra: Record<string, unknown> = {}): Promise<void> {
  await db.books.add({
    id: 'book',
    title: 'Paper',
    format: 'pdf',
    addedAt: 1,
    // jsdom's Blob does not survive fake-indexeddb's structured clone; Node's does.
    fileBlob: new NodeBlob(['%PDF-1.4 bytes']) as unknown as Blob,
    parsed,
    topicIds: [],
    ...extra,
  });
}

const highlight = (id: string, sentenceIds: string[], text: string): Highlight => ({
  id,
  bookId: 'book',
  sentenceIds,
  text,
  color: 'yellow',
  topicIds: [],
  createdAt: 1,
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.delete();
  await db.open();
});

describe('reanalyseBook', () => {
  it('keeps a highlight whose text the new layout no longer has, unlinked, and counts it', async () => {
    await addBook(doc({ Intro: [['Thiazides act on the tubule.', 'They lower pressure.']] }));
    await db.highlights.bulkAdd([
      highlight('h-moved', ['0-0-1'], 'They lower pressure.'),
      highlight('h-gone', ['0-0-0'], 'Thiazides act on the tubule.'),
    ]);
    // The new layout splits the first sentence differently and pushes the second down.
    parsesTo(doc({ Intro: [['Thiazides act'], ['on the tubule.'], ['They lower pressure.']] }));

    const result = await reanalyseBook('book');

    expect(result.highlightsKept).toBe(1);
    expect(result.highlightsUnlinked).toBe(1);
    expect((await db.highlights.get('h-moved'))?.sentenceIds).toEqual(['0-2-0']);
    // Still there with its text and colour; it must not point at whatever now has id 0-0-0.
    const gone = await db.highlights.get('h-gone');
    expect(gone?.text).toBe('Thiazides act on the tubule.');
    expect(gone?.sentenceIds).toEqual([]);
  });

  it('never deletes a bookmark: one whose sentence and chapter are gone moves to the nearest surviving text', async () => {
    await addBook(doc({ 'Pages 1–20': [['Alpha stays.', 'Beta is re-split here.', 'Gamma stays.']] }));
    await db.bookmarks.add({ id: 'bm', bookId: 'book', chapterId: 'ch-0', sentenceId: '0-0-1', createdAt: 1 });
    parsesTo(doc({ Introduction: [['Lead-in.'], ['Alpha stays.', 'Beta is', 're-split here.', 'Gamma stays.']] }));

    const result = await reanalyseBook('book');

    expect(result.bookmarksMoved).toBe(1);
    const bookmark = await db.bookmarks.get('bm');
    expect(bookmark).toMatchObject({ chapterId: 'ch-0', sentenceId: '0-1-0' }); // "Alpha stays."
  });

  it('remaps the saved position the reader opens at, not only books.lastPos', async () => {
    await addBook(doc({ Intro: [['One.', 'Two.', 'Three.']] }), { lastPos: { chapterId: 'ch-0', sentenceId: '0-0-0' } });
    // ReaderView prefers this row over books.lastPos when it opens the book.
    await db.settings.put({ key: 'reader.lastPos.book', value: { chapterId: 'ch-0', sentenceId: '0-0-2' } });
    parsesTo(doc({ Cover: [['Title page.']], Intro: [['One.'], ['Two.', 'Three.']] }));

    const result = await reanalyseBook('book');

    expect(result.positionKept).toBe(true);
    expect((await db.settings.get('reader.lastPos.book'))?.value).toEqual({ chapterId: 'ch-1', sentenceId: '1-1-1' });
    expect((await db.books.get('book'))?.lastPos).toEqual({ chapterId: 'ch-1', sentenceId: '1-0-0' });
  });

  it('keeps a mark on a repeated sentence at its own occurrence, not the first one in the book', async () => {
    const repeated = doc({
      Diuretics: [['Mechanism of action', 'Blocks the NCC.']],
      Statins: [['Mechanism of action', 'Blocks HMG-CoA reductase.']],
    });
    await addBook(repeated, { lastPos: { chapterId: 'ch-1', sentenceId: '1-0-0' } });
    await db.bookmarks.add({ id: 'bm', bookId: 'book', chapterId: 'ch-1', sentenceId: '1-0-0', createdAt: 1 });
    await db.highlights.add(highlight('h', ['1-0-0'], 'Mechanism of action'));
    parsesTo(repeated);

    await reanalyseBook('book');

    expect(await db.bookmarks.get('bm')).toMatchObject({ chapterId: 'ch-1', sentenceId: '1-0-0' });
    expect((await db.highlights.get('h'))?.sentenceIds).toEqual(['1-0-0']);
    expect((await db.books.get('book'))?.lastPos).toEqual({ chapterId: 'ch-1', sentenceId: '1-0-0' });
  });

  it('changes nothing when the book record cannot be written', async () => {
    const before = doc({ Intro: [['One.', 'Two.']] });
    await addBook(before);
    await db.highlights.add(highlight('h', ['0-0-1'], 'Two.'));
    await db.bookmarks.add({ id: 'bm', bookId: 'book', chapterId: 'ch-0', sentenceId: '0-0-1', createdAt: 1 });
    parsesTo(doc({ Intro: [['Zero.'], ['One.'], ['Two.']] }));
    vi.spyOn(db.books, 'update').mockRejectedValue(new Error('QuotaExceededError'));

    await expect(reanalyseBook('book')).rejects.toThrow(/Quota/);

    // Old document, old ids: a half-applied remap would leave the highlight on the wrong sentence.
    expect((await db.books.get('book'))?.parsed).toEqual(before);
    expect((await db.highlights.get('h'))?.sentenceIds).toEqual(['0-0-1']);
    expect((await db.bookmarks.get('bm'))?.sentenceId).toBe('0-0-1');
  });

  it('records on the book which layout read it', async () => {
    await addBook(doc({ Intro: [['One.']] }));
    parsesTo(doc({ Intro: [['One.']] }), 'model');

    const result = await reanalyseBook('book');

    expect(result.layout).toBe('model');
    expect((await db.books.get('book'))?.layout).toBe('model');
  });

  it('re-reads a book whose columns the reader chose with that choice', async () => {
    await addBook(doc({ Intro: [['One.']] }), { columns: 1 });
    parsesTo(doc({ Intro: [['One.']] }));

    await reanalyseBook('book');

    expect(next.options).toEqual({ columns: 1 });
    // The choice is the reader's and stays theirs; re-analysis does not clear it.
    expect((await db.books.get('book'))?.columns).toBe(1);
  });

  it('lets the parser detect the columns of a book that has no choice stored', async () => {
    await addBook(doc({ Intro: [['One.']] }));
    parsesTo(doc({ Intro: [['One.']] }));

    await reanalyseBook('book');

    expect(next.options).toEqual({ columns: 'auto' });
    // Nothing was chosen, so nothing is stored: the book keeps detecting.
    expect((await db.books.get('book'))?.columns).toBeUndefined();
  });
});

describe('setBookColumns', () => {
  it('stores the choice and re-reads the book with it', async () => {
    await addBook(doc({ Intro: [['One.', 'Two.']] }));
    parsesTo(doc({ Intro: [['One.'], ['Two.']] }));

    await setBookColumns('book', 2);

    expect(next.options).toEqual({ columns: 2 });
    expect((await db.books.get('book'))?.columns).toBe(2);
    // And the book itself was replaced, not only the setting around it.
    expect((await db.books.get('book'))?.parsed.chapters[0]?.blocks).toHaveLength(2);
  });

  it("carries the reader's marks and position across the new columns", async () => {
    await addBook(doc({ Intro: [['One.', 'Two.', 'Three.']] }), {
      lastPos: { chapterId: 'ch-0', sentenceId: '0-0-2' },
    });
    await db.highlights.add(highlight('h', ['0-0-1'], 'Two.'));
    parsesTo(doc({ Intro: [['One.', 'Two.'], ['Three.']] }));

    await setBookColumns('book', 1);

    // "Two." keeps its place in the first block; "Three." moved to the second one.
    expect((await db.highlights.get('h'))?.sentenceIds).toEqual(['0-0-1']);
    expect((await db.books.get('book'))?.lastPos).toEqual({ chapterId: 'ch-0', sentenceId: '0-1-0' });
  });

  it('refuses a format that has no columns', async () => {
    await db.books.add({
      id: 'notes',
      title: 'Notes',
      format: 'txt',
      addedAt: 1,
      fileBlob: new NodeBlob(['notes']) as unknown as Blob,
      parsed: { ...doc({ Notes: [['One.']] }), format: 'txt' },
      topicIds: [],
    });

    await expect(setBookColumns('notes', 2)).rejects.toThrow(/Only PDFs/);

    expect((await db.books.get('notes'))?.columns).toBeUndefined();
  });

  it('leaves the stored choice alone when the book cannot be re-read', async () => {
    await addBook(doc({ Intro: [['One.']] }), { columns: 1 });
    // A parse that finds no text: the column setting must not change either.
    next.result = {
      doc: { title: 'Paper', format: 'pdf', chapters: [] },
      charsPerPage: 0,
      pageCount: 0,
      layout: 'heuristic',
      modelPages: 0,
    };
    next.options = null;

    await expect(setBookColumns('book', 2)).rejects.toThrow(/No readable text/);

    expect((await db.books.get('book'))?.columns).toBe(1);
  });

  it('says so when the book is gone', async () => {
    await expect(setBookColumns('gone', 2)).rejects.toThrow(/no longer in the library/);
  });
});

describe('importFileDetailed (PDF)', () => {
  it('reads the picked file once and stores the layout that read it', async () => {
    parsesTo(doc({ Intro: [['One.']] }), 'model');
    const file = new File(['%PDF-1.4 a page of a paper'], 'paper.pdf', { type: 'application/pdf' });
    const reads = vi.spyOn(Blob.prototype, 'arrayBuffer');
    const add = vi.spyOn(db.books, 'add');

    await importFileDetailed(file);

    expect(reads).toHaveBeenCalledTimes(1);
    expect(next.bytes).toBe(file.size);
    const record = add.mock.calls[0]?.[0];
    expect(record?.layout).toBe('model');
    expect(record?.fileBlob.size).toBe(file.size);
  });
});
