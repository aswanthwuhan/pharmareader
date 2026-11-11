import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { db, newId } from '../core/db';
import type { BookRecord, ColumnMode, DocFormat, ParsedDoc } from '../core/types';
import { normaliseText } from './blocks';
import { parseHtmlDocument } from './html';
import { parseMarkdown } from './md';
import { parseText } from './txt';

export interface ImportResult {
  bookId: string;
  /** Non-fatal note for the user, e.g. a PDF that looks scanned. */
  warning?: string;
}

const FORMAT_BY_EXT: Record<string, DocFormat> = {
  pdf: 'pdf',
  epub: 'epub',
  docx: 'docx',
  txt: 'txt',
  md: 'md',
  markdown: 'md',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
};

/** What a picked `File` and the stored copy both provide. */
export interface NamedBlob {
  name?: string;
  type: string;
}

export function detectFormat(file: NamedBlob): DocFormat | null {
  const extension = (file.name ?? '').split('.').pop()?.toLowerCase() ?? '';
  const byExtension = FORMAT_BY_EXT[extension];
  if (byExtension) return byExtension;

  const mime = file.type.toLowerCase();
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'application/epub+zip') return 'epub';
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html';
  if (mime === 'text/markdown') return 'md';
  if (mime.startsWith('text/')) return 'txt';
  return null;
}

export function titleFromFileName(name: string): string {
  const base = name.replace(/\.[^.]+$/, '');
  return normaliseText(base.replace(/[_-]+/g, ' ')) || 'Untitled';
}

async function parseFile(
  bytes: ArrayBuffer,
  type: string,
  name: string,
  onProgress?: (note: string) => void,
): Promise<{ doc: ParsedDoc; warning?: string; layout?: BookRecord['layout'] }> {
  const format = detectFormat({ name, type });
  const text = () => new TextDecoder().decode(bytes);
  if (!format) {
    throw new Error(`Unsupported file type: ${name}. Import a PDF, EPUB, DOCX, TXT, Markdown or HTML file.`);
  }

  const fallback = titleFromFileName(name);

  switch (format) {
    case 'txt':
      return { doc: parseText(text(), fallback) };

    case 'md':
      return { doc: parseMarkdown(text(), fallback) };

    case 'html': {
      const html = text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return {
        doc: parseHtmlDocument(doc, { format: 'html', title: normaliseText(doc.title) || fallback }),
      };
    }

    case 'pdf': {
      // Heavy extractors are loaded only when that file type is imported.
      const { parsePdf } = await import('./pdf');
      const parsed = await parsePdf(bytes, fallback, (done, total, phase) => {
        // A 1000-page paper takes a while; a note every 25 pages is enough to
        // prove the app is alive without re-rendering the library 1000 times.
        if (done !== total && done % 25 !== 0) return;
        onProgress?.(phase === 'layout' ? `Analysing layout: page ${done} of ${total}` : `page ${done} of ${total}`);
      });
      // Under ~50 characters per page there is no real text layer: a scan.
      const warning =
        parsed.charsPerPage < 50 ? 'Looks scanned — OCR not supported yet' : parsed.modelNote;
      return { doc: parsed.doc, warning, layout: parsed.layout };
    }

    case 'epub': {
      const { parseEpub } = await import('./epub');
      return { doc: await parseEpub(bytes, fallback) };
    }

    case 'docx': {
      const { parseDocx } = await import('./docx');
      return { doc: await parseDocx(bytes, fallback) };
    }
  }
}

async function saveRecord(doc: ParsedDoc, fileBlob: Blob, layout?: BookRecord['layout']): Promise<string> {
  if (!doc.chapters.length) throw new Error('No readable text found in this file.');

  const record: BookRecord = {
    id: newId(),
    title: doc.title || 'Untitled',
    author: doc.author,
    format: doc.format,
    addedAt: Date.now(),
    fileBlob,
    parsed: doc,
    topicIds: [],
  };
  if (layout) record.layout = layout;

  await db.books.add(record);
  return record.id;
}

/**
 * Remove a book and everything that hangs off it, in one transaction.
 *
 * The review logs are keyed by card, not by book, so deleting the cards alone
 * leaves history behind: it would keep counting in the study stats and in
 * backups, pointing at cards that no longer exist.
 */
export async function deleteBook(bookId: string): Promise<void> {
  await db.transaction('rw', [db.books, db.highlights, db.bookmarks, db.cards, db.reviewLogs], async () => {
    const cardIds = await db.cards.where('bookId').equals(bookId).primaryKeys();
    if (cardIds.length) await db.reviewLogs.where('cardId').anyOf(cardIds).delete();
    await db.highlights.where('bookId').equals(bookId).delete();
    await db.bookmarks.where('bookId').equals(bookId).delete();
    await db.cards.where('bookId').equals(bookId).delete();
    await db.books.delete(bookId);
  });
}

/**
 * The bytes of `file`, owned by the page rather than by whatever produced it.
 *
 * A `File` handed over by the Android document picker is only a handle into the
 * picker's provider: after an app update or a reboot the same `File` reads back
 * as zero bytes ("The PDF file is empty"), even though IndexedDB happily stored
 * the record. Copying the bytes into a fresh `Blob` gives the book a file that
 * survives everything the store survives.
 */
export async function ownedCopy(file: Blob & { name?: string }): Promise<Blob> {
  return new Blob([await file.arrayBuffer()], { type: file.type || 'application/octet-stream' });
}

/**
 * Shown wherever a book needs its original file but the stored one is empty —
 * the text view and every parsed sentence still work, page view does not.
 */
export const MISSING_FILE_MESSAGE =
  'The original file is no longer available — re-import it to use Page view and Re-analyse';

/** A book whose stored file did not survive an app update, a reboot or a picker. */
export function fileMissing(book: Pick<BookRecord, 'fileBlob'>): boolean {
  const blob = book.fileBlob as Blob | undefined;
  // A real Blob always reports a numeric size; anything else (a clone that lost
  // its payload, a file the picker no longer serves) counts as gone.
  return !blob || typeof blob.size !== 'number' || blob.size === 0;
}

/** Full result including the scanned-PDF warning the library shows inline. */
export async function importFileDetailed(
  file: File,
  onProgress?: (note: string) => void,
): Promise<ImportResult> {
  // Read the picked file exactly once, and keep the bytes that were parsed: the
  // picker's File handle is not a durable store (see ownedCopy). The Blob is
  // built first because pdf.js takes the buffer away for its worker; reading the
  // Blob back for the parser would be a second full copy of a 150 MB textbook.
  const bytes = await file.arrayBuffer();
  const owned = new Blob([bytes], { type: file.type || 'application/octet-stream' });
  const { doc, warning, layout } = await parseFile(bytes, file.type, file.name, onProgress);
  const bookId = await saveRecord(doc, owned, layout);
  return { bookId, warning };
}

/** Import a user-picked file and return the new book id. */
export async function importFile(file: File): Promise<string> {
  return (await importFileDetailed(file)).bookId;
}

export async function importText(title: string, text: string): Promise<string> {
  // No title typed: the first line usually is one ("Chapter 1: Pharmacokinetics").
  const firstLine = normaliseText(text.trim().split(/\r?\n/, 1)[0] ?? '').slice(0, 80);
  // A one-line paste is the text itself, not a heading.
  const heading = text.trim().includes('\n') ? firstLine : '';
  const cleanTitle = normaliseText(title) || heading || 'Pasted text';
  const doc = parseText(text, cleanTitle);
  if (!doc.chapters.length) throw new Error('Nothing to import: the pasted text is empty.');
  return saveRecord(doc, new Blob([text], { type: 'text/plain' }));
}

/**
 * Fetch a page and keep its article text. On native builds Capacitor patches
 * `fetch` so cross-origin requests work; in a plain browser most sites refuse.
 */
export async function importUrl(url: string): Promise<string> {
  let target: URL;
  try {
    target = new URL(url.trim());
  } catch {
    throw new Error('That does not look like a web address.');
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error('Only http and https addresses can be imported.');
  }

  let html: string;
  // A page that hangs would otherwise disable the whole library screen: the
  // import button stays busy until the fetch settles. The timer stays armed
  // through the body read too, because a slow site can stall after the headers.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 20_000);
  try {
    if (Capacitor.isNativePlatform()) {
      // Native HTTP sidesteps CORS for article pages; global fetch patching is off so model downloads stay streamed.
      const response = await CapacitorHttp.get({ url: target.toString(), responseType: 'text', connectTimeout: 20_000, readTimeout: 20_000 });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`That page returned ${response.status}; paste the text instead.`);
      }
      html = String(response.data ?? '');
    } else {
      const response = await fetch(target.toString(), { signal: abort.signal });
      if (!response.ok) {
        throw new Error(`That page returned ${response.status}; paste the text instead.`);
      }
      html = await response.text();
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('That page returned')) throw error;
    throw new Error('This site blocks web import; paste the text instead.');
  } finally {
    clearTimeout(timer);
  }

  const doc = new DOMParser().parseFromString(html, 'text/html');
  const pageTitle = normaliseText(doc.title);

  const { Readability } = await import('@mozilla/readability');
  const article = new Readability(doc, { charThreshold: 200 }).parse();
  if (!article?.content) {
    throw new Error('Could not find an article on that page; paste the text instead.');
  }

  const contentDoc = new DOMParser().parseFromString(article.content, 'text/html');
  const parsed = parseHtmlDocument(contentDoc, {
    format: 'html',
    title: normaliseText(article.title ?? '') || pageTitle || target.hostname,
    author: normaliseText(article.byline ?? '') || undefined,
    chapterLevel: 2,
  });

  if (!parsed.chapters.length) {
    throw new Error('That page had no readable article text; paste the text instead.');
  }

  return saveRecord(parsed, new Blob([article.content], { type: 'text/html' }));
}

export interface ReanalyseResult {
  /** Which layout path ran, so the UI can say whether the model was used. */
  layout: 'model' | 'heuristic';
  /** Pages the model actually laid out; the rest were plain enough for the text rules. */
  modelPages: number;
  /** Why the model did not lay out every page it was asked for, when it did not. */
  modelNote?: string;
  sentencesBefore: number;
  sentencesAfter: number;
  /** Highlights whose text was found again. */
  highlightsKept: number;
  /** Highlights whose text is gone: kept with their text and note, linked to no sentence. */
  highlightsUnlinked: number;
  bookmarksKept: number;
  /** Bookmarks whose sentence is gone, now on the nearest text that survived. */
  bookmarksMoved: number;
  /** Whether the reading position is still on the very sentence it was on. */
  positionKept: boolean;
}

interface FlatSentence {
  id: string;
  chapterId: string;
  text: string;
}

interface SentenceIndex {
  flat: FlatSentence[];
  /** Position in `flat` of each sentence id. */
  indexOf: Map<string, number>;
  /** Every position a text appears at: headings and stock phrases repeat. */
  placesOf: Map<string, number[]>;
}

type Position = { chapterId: string; sentenceId: string };

/** Where ReaderView keeps the position it opens a book at (it prefers this over `books.lastPos`). */
const readerPosKey = (bookId: string) => `reader.lastPos.${bookId}`;

/** A PDF book, with the checks every re-read shares. */
async function pdfBook(bookId: string): Promise<BookRecord> {
  const book = await db.books.get(bookId);
  if (!book) throw new Error('That book is no longer in the library.');
  if (book.format !== 'pdf') {
    throw new Error('Only PDFs have a layout to detect; other formats are read from their own structure.');
  }
  if (fileMissing(book)) throw new Error(MISSING_FILE_MESSAGE);
  return book;
}

/**
 * Re-read a PDF already in the library with the current layout settings, and
 * carry the reader's highlights, bookmarks and position across.
 *
 * Sentence ids are positional (`chapter-block-sentence`), so re-analysis renumbers
 * them all. Matching is by text instead: a highlight is kept when the same run of
 * sentences appears again. One whose text no longer exists is kept too, linked to
 * no sentence rather than to whatever now sits at that index; nothing the reader
 * made is deleted. The parsing is done first and every write happens in one
 * transaction, so a killed app leaves either the old book or the new one.
 */
export async function reanalyseBook(bookId: string, onProgress?: (note: string) => void): Promise<ReanalyseResult> {
  const book = await pdfBook(bookId);
  // A book the reader fixed the columns of keeps that choice when the whole
  // library is re-analysed (Settings → Re-analyse).
  return reparseBook(book, book.columns ?? 'auto', undefined, onProgress);
}

/**
 * Read one book again with the reader's own column layout, and remember the
 * choice on the book so every later read keeps it.
 *
 * `'auto'` puts the book back to detection; `1` and `2` override it. The setting
 * is written in the same transaction as the new text, so a failed re-read leaves
 * the book — and its column setting — exactly as they were.
 */
export async function setBookColumns(
  bookId: string,
  columns: ColumnMode,
  onProgress?: (note: string) => void,
): Promise<void> {
  const book = await pdfBook(bookId);
  await reparseBook(book, columns, columns, onProgress);
}

/**
 * The one re-read path. `saveColumns` is written on the book when set;
 * Re-analyse leaves it out because the stored value is what it just read with.
 */
async function reparseBook(
  book: BookRecord,
  columns: ColumnMode,
  saveColumns: ColumnMode | undefined,
  onProgress?: (note: string) => void,
): Promise<ReanalyseResult> {
  onProgress?.('Opening the saved file');
  const { parsePdf } = await import('./pdf');
  const parsed = await parsePdf(
    await book.fileBlob.arrayBuffer(),
    book.title,
    (done, total, phase) => {
      if (done !== total && done % 10 !== 0) return;
      onProgress?.(phase === 'layout' ? `Analysing layout: page ${done} of ${total}` : `Reading text: page ${done} of ${total}`);
    },
    { columns },
  );
  if (!parsed.doc.chapters.length) throw new Error('No readable text found in this file.');

  const before = sentenceIndex(book.parsed);
  const after = sentenceIndex(parsed.doc);
  const result: ReanalyseResult = {
    layout: parsed.layout,
    modelPages: parsed.modelPages,
    modelNote: parsed.modelNote,
    sentencesBefore: before.flat.length,
    sentencesAfter: after.flat.length,
    highlightsKept: 0,
    highlightsUnlinked: 0,
    bookmarksKept: 0,
    bookmarksMoved: 0,
    positionKept: true,
  };

  const moved = (position: Position | undefined): Position | undefined => {
    if (!position) return undefined;
    const place = relocate(position.sentenceId, before, after);
    if (!place.exact) result.positionKept = false;
    return { chapterId: place.sentence.chapterId, sentenceId: place.sentence.id };
  };

  await db.transaction('rw', [db.books, db.highlights, db.bookmarks, db.settings], async () => {
    for (const highlight of await db.highlights.where('bookId').equals(book.id).toArray()) {
      const ids = matchRun(highlight.sentenceIds, before, after);
      if (ids.length) result.highlightsKept += 1;
      else result.highlightsUnlinked += 1;
      if (ids.join('\u0000') !== highlight.sentenceIds.join('\u0000')) {
        await db.highlights.update(highlight.id, { sentenceIds: ids });
      }
    }

    for (const bookmark of await db.bookmarks.where('bookId').equals(book.id).toArray()) {
      const place = relocate(bookmark.sentenceId, before, after);
      if (place.exact) result.bookmarksKept += 1;
      else result.bookmarksMoved += 1;
      await db.bookmarks.update(bookmark.id, { chapterId: place.sentence.chapterId, sentenceId: place.sentence.id });
    }

    const saved = (await db.settings.get(readerPosKey(book.id)))?.value as Partial<Position> | undefined;
    if (typeof saved?.chapterId === 'string' && typeof saved.sentenceId === 'string') {
      await db.settings.put({ key: readerPosKey(book.id), value: moved(saved as Position) });
    }

    await db.books.update(book.id, {
      parsed: parsed.doc,
      lastPos: moved(book.lastPos),
      layout: parsed.layout,
      ...(saveColumns === undefined ? {} : { columns: saveColumns }),
    });
  });

  return result;
}

function sentenceIndex(doc: ParsedDoc): SentenceIndex {
  const flat: FlatSentence[] = [];
  const indexOf = new Map<string, number>();
  const placesOf = new Map<string, number[]>();

  for (const chapter of doc.chapters) {
    for (const block of chapter.blocks) {
      for (const sentence of block.sentences) {
        indexOf.set(sentence.id, flat.length);
        const places = placesOf.get(sentence.text);
        if (places) places.push(flat.length);
        else placesOf.set(sentence.text, [flat.length]);
        flat.push({ id: sentence.id, chapterId: chapter.id, text: sentence.text });
      }
    }
  }

  return { flat, indexOf, placesOf };
}

/**
 * Where the run of texts that started at old position `from` now starts. A text
 * that appears more than once ("Mechanism of action" in every chapter) is taken
 * at the occurrence closest to where it was, not at the first one in the book.
 */
function findRun(texts: string[], from: number, before: SentenceIndex, after: SentenceIndex): number | undefined {
  const expected = (from / Math.max(1, before.flat.length)) * after.flat.length;
  let best: number | undefined;
  for (const start of after.placesOf.get(texts[0]) ?? []) {
    if (!texts.every((text, offset) => after.flat[start + offset]?.text === text)) continue;
    if (best === undefined || Math.abs(start - expected) < Math.abs(best - expected)) best = start;
  }
  return best;
}

/**
 * The new ids of a run of sentences, matched as a run so a highlight keeps its
 * extent; failing that, each sentence wherever it now appears.
 */
function matchRun(sentenceIds: string[], before: SentenceIndex, after: SentenceIndex): string[] {
  const places = sentenceIds
    .map((id) => before.indexOf.get(id))
    .filter((place): place is number => place !== undefined);
  if (!places.length) return [];

  const texts = places.map((place) => before.flat[place].text);
  const start = findRun(texts, places[0], before, after);
  if (start !== undefined) return after.flat.slice(start, start + texts.length).map((sentence) => sentence.id);

  return places
    .map((place) => findRun([before.flat[place].text], place, before, after))
    .filter((place): place is number => place !== undefined)
    .map((place) => after.flat[place].id);
}

/**
 * The sentence a bookmark or a reading position belongs on now: the same text,
 * else the nearest earlier text that survived, else the nearest later one, else
 * the start of the book. Never nothing — the reader's place is not ours to drop.
 */
function relocate(
  sentenceId: string,
  before: SentenceIndex,
  after: SentenceIndex,
): { sentence: FlatSentence; exact: boolean } {
  const from = before.indexOf.get(sentenceId);
  if (from !== undefined) {
    const at = (place: number) => findRun([before.flat[place].text], place, before, after);
    for (let place = from; place >= 0; place--) {
      const found = at(place);
      if (found !== undefined) return { sentence: after.flat[found], exact: place === from };
    }
    for (let place = from + 1; place < before.flat.length; place++) {
      const found = at(place);
      if (found !== undefined) return { sentence: after.flat[found], exact: false };
    }
  }
  return { sentence: after.flat[0], exact: false };
}
