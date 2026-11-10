import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../core/db';
import {
  MISSING_FILE_MESSAGE,
  deleteBook,
  detectFormat,
  fileMissing,
  importFile,
  importText,
  importUrl,
  ownedCopy,
  reanalyseBook,
  titleFromFileName,
} from './index';
import { parseText } from './txt';

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await db.delete();
  await db.open();
});

describe('detectFormat', () => {
  it('detects by extension', () => {
    const named = (name: string) => new File(['x'], name);

    expect(detectFormat(named('book.pdf'))).toBe('pdf');
    expect(detectFormat(named('book.EPUB'))).toBe('epub');
    expect(detectFormat(named('notes.markdown'))).toBe('md');
    expect(detectFormat(named('page.htm'))).toBe('html');
    expect(detectFormat(named('paper.docx'))).toBe('docx');
  });

  it('falls back to the MIME type', () => {
    expect(detectFormat(new File(['x'], 'no-extension', { type: 'application/epub+zip' }))).toBe('epub');
    expect(detectFormat(new File(['x'], 'no-extension', { type: 'text/plain' }))).toBe('txt');
  });

  it('returns null for slides and unknown types', () => {
    expect(detectFormat(new File(['x'], 'deck.pptx'))).toBeNull();
    expect(detectFormat(new File(['x'], 'blob', { type: 'application/zip' }))).toBeNull();
  });
});

describe('titleFromFileName', () => {
  it('drops the extension and turns separators into spaces', () => {
    expect(titleFromFileName('basic-clinical_pharmacology.pdf')).toBe('basic clinical pharmacology');
    expect(titleFromFileName('notes.md')).toBe('notes');
  });
});

describe('importText', () => {
  it('parses the text and stores a book that reads back', async () => {
    const bookId = await importText('Pasted notes', 'First sentence. Second sentence.\n\nAnother paragraph.');

    const book = await db.books.get(bookId);
    expect(book?.title).toBe('Pasted notes');
    expect(book?.format).toBe('txt');
    expect(book?.topicIds).toEqual([]);
    // fake-indexeddb's clone drops Blob contents (real IndexedDB keeps them), so
    // only presence is asserted — same caveat as src/core/db.test.ts.
    expect(book?.fileBlob).toBeTruthy();

    const blocks = book?.parsed.chapters[0]?.blocks ?? [];
    expect(blocks.map((block) => block.id)).toEqual(['b-0-0', 'b-0-1']);
    expect(blocks[0]?.sentences.map((sentence) => sentence.id)).toEqual(['0-0-0', '0-0-1']);
    expect(blocks[1]?.sentences[0]?.text).toBe('Another paragraph.');
  });

  it('uses a fallback title when none is given', async () => {
    const bookId = await importText('   ', 'Some text.');
    expect((await db.books.get(bookId))?.title).toBe('Pasted text');
  });

  it('refuses empty text', async () => {
    await expect(importText('Title', '   \n\n ')).rejects.toThrow(/empty/i);
  });
});

describe('importFile', () => {
  it('imports a plain text file and titles it from the file name', async () => {
    const file = new File(['Renal clearance matters. It drives dosing.'], 'renal-notes.txt', { type: 'text/plain' });
    const bookId = await importFile(file);

    const book = await db.books.get(bookId);
    expect(book?.title).toBe('renal notes');
    expect(book?.parsed.chapters[0]?.blocks[0]?.sentences).toHaveLength(2);
    expect(book?.fileBlob).toBeTruthy();
  });

  it('drops a UTF-8 BOM from a text file now the bytes are decoded instead of Blob.text()', async () => {
    const body = new TextEncoder().encode('First sentence. Second sentence.');
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...body]);
    const file = new File([bytes], 'bom-notes.txt', { type: 'text/plain' });

    const bookId = await importFile(file);
    const book = await db.books.get(bookId);
    const text = book?.parsed.chapters.flatMap((chapter) =>
      chapter.blocks.flatMap((block) => block.sentences.map((sentence) => sentence.text)),
    );

    // TextDecoder strips the BOM like Blob.text() did; no U+FEFF reaches a sentence.
    expect(text?.join(' ')).not.toContain('\uFEFF');
    expect(text?.[0]).toBe('First sentence.');
  });

  it('rejects an unsupported file type with a clear message', async () => {
    const file = new File(['x'], 'deck.pptx');

    await expect(importFile(file)).rejects.toThrow(/Unsupported file type/);
  });

  it('rejects a file with no readable text', async () => {
    const file = new File([' \n\n '], 'blank.txt', { type: 'text/plain' });

    await expect(importFile(file)).rejects.toThrow(/No readable text/);
  });

  it('gives every import a fresh id', async () => {
    const first = await importText('One', 'First book.');
    const second = await importText('Two', 'Second book.');

    expect(first).not.toBe(second);
    expect(await db.books.count()).toBe(2);
  });
});

describe('the imported file is owned by the app, not by the picker', () => {
  it('stores the bytes in a Blob of its own, not the picked File', async () => {
    const file = new File(['Renal clearance matters. It drives dosing.'], 'renal-notes.txt', { type: 'text/plain' });
    const add = vi.spyOn(db.books, 'add');

    await importFile(file);

    const record = add.mock.calls[0]?.[0];
    expect(record?.fileBlob).not.toBe(file);
    expect(record?.fileBlob.constructor.name).toBe('Blob');
    expect(record?.fileBlob.size).toBe(file.size);
    expect(record?.fileBlob.type).toBe('text/plain');
    add.mockRestore();
  });

  it('keeps every byte even when the picked file stops reading (the reinstall bug)', async () => {
    const file = new File(['%PDF-1.4 a page of a paper'], 'paper.pdf', { type: 'application/pdf' });

    const owned = await ownedCopy(file);
    // After an app update the picker's File reads back empty ("size zero bytes");
    // the copy has to be whole on its own.
    vi.spyOn(file, 'arrayBuffer').mockRejectedValue(new Error('the handle is gone'));

    const bytes = new Uint8Array(await owned.arrayBuffer());
    expect(bytes.byteLength).toBe(file.size);
    expect(new TextDecoder().decode(bytes)).toContain('a page of a paper');
  });

  it('recognises a book whose stored file did not survive', () => {
    expect(fileMissing({ fileBlob: new Blob([]) })).toBe(true);
    expect(fileMissing({ fileBlob: new Blob(['x']) })).toBe(false);
  });

  it('tells the reader to re-import instead of asking pdf.js to parse nothing', async () => {
    const doc = parseText('Thiazides act on the distal convoluted tubule.', 'Gone paper');
    await db.books.add({
      id: 'gone',
      title: doc.title,
      format: 'pdf',
      addedAt: 1,
      fileBlob: new Blob([]),
      parsed: doc,
      topicIds: [],
    });

    await expect(reanalyseBook('gone')).rejects.toThrow(MISSING_FILE_MESSAGE);
    expect(MISSING_FILE_MESSAGE).toContain('re-import it to use Page view and Re-analyse');
  });
});

describe('deleteBook', () => {
  it('removes the book with its annotations, cards and their review history', async () => {
    const keep = await importText('Keep', 'Kept book text.');
    const drop = await importText('Drop', 'Dropped book text.');

    await db.highlights.bulkAdd([
      { id: 'h-drop', bookId: drop, sentenceIds: ['0-0-0'], text: 'Dropped', color: 'yellow', topicIds: [], createdAt: 1 },
      { id: 'h-keep', bookId: keep, sentenceIds: ['0-0-0'], text: 'Kept', color: 'blue', topicIds: [], createdAt: 1 },
    ]);
    await db.bookmarks.bulkAdd([
      { id: 'bm-drop', bookId: drop, chapterId: 'ch-0', sentenceId: '0-0-0', createdAt: 1 },
      { id: 'bm-keep', bookId: keep, chapterId: 'ch-0', sentenceId: '0-0-0', createdAt: 1 },
    ]);
    await db.cards.bulkAdd([
      { id: 'c-drop', bookId: drop, kind: 'qa', front: 'q', back: 'a', topicIds: [], fsrs: {}, createdAt: 1 },
      { id: 'c-keep', bookId: keep, kind: 'qa', front: 'q', back: 'a', topicIds: [], fsrs: {}, createdAt: 1 },
    ]);
    await db.reviewLogs.bulkAdd([
      { id: 'r-drop', cardId: 'c-drop', rating: 3, reviewedAt: 1, log: {} },
      { id: 'r-keep', cardId: 'c-keep', rating: 3, reviewedAt: 1, log: {} },
    ]);

    await deleteBook(drop);

    expect(await db.books.get(drop)).toBeUndefined();
    expect(await db.books.get(keep)).toBeTruthy();
    expect(await db.highlights.where('bookId').equals(drop).count()).toBe(0);
    expect(await db.bookmarks.where('bookId').equals(drop).count()).toBe(0);
    expect(await db.cards.where('bookId').equals(drop).count()).toBe(0);
    // Review history is keyed by card, so it has to be swept explicitly.
    expect((await db.reviewLogs.toArray()).map((log) => log.id)).toEqual(['r-keep']);
    expect(await db.highlights.where('bookId').equals(keep).count()).toBe(1);
    expect(await db.cards.where('bookId').equals(keep).count()).toBe(1);
  });
});

describe('importUrl', () => {
  it('rejects addresses that are not http(s)', async () => {
    await expect(importUrl('file:///etc/passwd')).rejects.toThrow(/http/i);
    await expect(importUrl('not a url')).rejects.toThrow(/web address/i);
  });

  it('explains that a blocked fetch means CORS, not a broken app', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );

    await expect(importUrl('https://example.com/article')).rejects.toThrow(
      /blocks web import; paste the text instead/,
    );
  });

  it('reports an HTTP error instead of pretending to import', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('not found', { status: 404 }))),
    );

    await expect(importUrl('https://example.com/missing')).rejects.toThrow(/404/);
  });

  it('gives up on a site that never answers instead of hanging the library', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
          }),
      ),
    );

    const pending = expect(importUrl('https://example.com/slow')).rejects.toThrow(/blocks web import/);
    await vi.advanceTimersByTimeAsync(20_100);
    await pending;
  });

  it('gives up when the site sends headers and then stalls the body', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          Promise.resolve({
            ok: true,
            status: 200,
            text: () =>
              new Promise((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
              }),
          } as unknown as Response),
      ),
    );

    const pending = expect(importUrl('https://example.com/drip')).rejects.toThrow(/blocks web import/);
    await vi.advanceTimersByTimeAsync(20_100);
    await pending;
  });
});

describe('importText title', () => {
  it('uses the first line when no title is typed', async () => {
    const { importText } = await import('./index');
    const { db } = await import('../core/db');
    const id = await importText('', ['Chapter 1: Pharmacokinetics', 'Drugs are absorbed.'].join(String.fromCharCode(10)));
    expect((await db.books.get(id))?.title).toBe('Chapter 1: Pharmacokinetics');
  });
});
