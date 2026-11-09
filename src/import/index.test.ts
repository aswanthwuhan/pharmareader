import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../core/db';
import { detectFormat, importFile, importText, importUrl, titleFromFileName } from './index';

afterEach(async () => {
  vi.unstubAllGlobals();
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
});
