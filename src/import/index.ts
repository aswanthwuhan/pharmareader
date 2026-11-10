import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { db, newId } from '../core/db';
import type { BookRecord, DocFormat, ParsedDoc } from '../core/types';
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

export function detectFormat(file: File): DocFormat | null {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
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
  file: File,
  onProgress?: (note: string) => void,
): Promise<{ doc: ParsedDoc; warning?: string }> {
  const format = detectFormat(file);
  if (!format) {
    throw new Error(`Unsupported file type: ${file.name}. Import a PDF, EPUB, DOCX, TXT, Markdown or HTML file.`);
  }

  const fallback = titleFromFileName(file.name);

  switch (format) {
    case 'txt':
      return { doc: parseText(await file.text(), fallback) };

    case 'md':
      return { doc: parseMarkdown(await file.text(), fallback) };

    case 'html': {
      const html = await file.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return {
        doc: parseHtmlDocument(doc, { format: 'html', title: normaliseText(doc.title) || fallback }),
      };
    }

    case 'pdf': {
      // Heavy extractors are loaded only when that file type is imported.
      const { parsePdf } = await import('./pdf');
      const parsed = await parsePdf(await file.arrayBuffer(), fallback, (done, total, phase) => {
        // A 1000-page paper takes a while; a note every 25 pages is enough to
        // prove the app is alive without re-rendering the library 1000 times.
        if (done !== total && done % 25 !== 0) return;
        onProgress?.(phase === 'layout' ? `Analysing layout: page ${done} of ${total}` : `page ${done} of ${total}`);
      });
      // Under ~50 characters per page there is no real text layer: a scan.
      const warning =
        parsed.charsPerPage < 50 ? 'Looks scanned — OCR not supported yet' : undefined;
      return { doc: parsed.doc, warning };
    }

    case 'epub': {
      const { parseEpub } = await import('./epub');
      return { doc: await parseEpub(await file.arrayBuffer(), fallback) };
    }

    case 'docx': {
      const { parseDocx } = await import('./docx');
      return { doc: await parseDocx(await file.arrayBuffer(), fallback) };
    }
  }
}

async function saveRecord(doc: ParsedDoc, fileBlob: Blob): Promise<string> {
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

/** Full result including the scanned-PDF warning the library shows inline. */
export async function importFileDetailed(
  file: File,
  onProgress?: (note: string) => void,
): Promise<ImportResult> {
  const { doc, warning } = await parseFile(file, onProgress);
  const bookId = await saveRecord(doc, file);
  return { bookId, warning };
}

/** Import a user-picked file and return the new book id. */
export async function importFile(file: File): Promise<string> {
  return (await importFileDetailed(file)).bookId;
}

export async function importText(title: string, text: string): Promise<string> {
  const cleanTitle = normaliseText(title) || 'Pasted text';
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
  sentencesBefore: number;
  sentencesAfter: number;
  /** Highlights whose text was found again; the rest are deleted with the text. */
  highlightsKept: number;
  highlightsDropped: number;
  bookmarksKept: number;
  bookmarksMoved: number;
  bookmarksDropped: number;
  /** Whether reading position still points at a sentence that exists. */
  positionKept: boolean;
}

interface FlatSentence {
  id: string;
  chapterId: string;
  text: string;
}

interface SentenceIndex {
  flat: FlatSentence[];
  textOf: Map<string, string>;
  firstOf: Map<string, string>;
}

/**
 * Re-read a PDF already in the library with the current layout settings, and
 * carry the reader's highlights, bookmarks and position across.
 *
 * Sentence ids are positional (`chapter-block-sentence`), so re-analysis renumbers
 * them all. Matching is by text instead: a highlight is kept when the same run of
 * sentences appears again, and is deleted when its text no longer exists rather
 * than pointing at whatever now sits at that index.
 */
export async function reanalyseBook(bookId: string, onProgress?: (note: string) => void): Promise<ReanalyseResult> {
  const book = await db.books.get(bookId);
  if (!book) throw new Error('That book is no longer in the library.');
  if (book.format !== 'pdf') {
    throw new Error('Only PDFs have a layout to detect; other formats are read from their own structure.');
  }

  onProgress?.('Opening the saved file');
  const { parsePdf } = await import('./pdf');
  const parsed = await parsePdf(await book.fileBlob.arrayBuffer(), book.title, (done, total, phase) => {
    if (done !== total && done % 10 !== 0) return;
    onProgress?.(phase === 'layout' ? `Analysing layout: page ${done} of ${total}` : `Reading text: page ${done} of ${total}`);
  });
  if (!parsed.doc.chapters.length) throw new Error('No readable text found in this file.');

  const before = sentenceIndex(book.parsed);
  const after = sentenceIndex(parsed.doc);

  let highlightsKept = 0;
  let highlightsDropped = 0;
  for (const highlight of await db.highlights.where('bookId').equals(bookId).toArray()) {
    const texts = highlight.sentenceIds
      .map((id) => before.textOf.get(id))
      .filter((text): text is string => Boolean(text));
    const ids = matchRun(texts, after);
    if (!ids.length) {
      highlightsDropped += 1;
      await db.highlights.delete(highlight.id);
      continue;
    }
    highlightsKept += 1;
    if (ids.join('\u0000') !== highlight.sentenceIds.join('\u0000')) {
      await db.highlights.update(highlight.id, { sentenceIds: ids });
    }
  }

  let bookmarksKept = 0;
  let bookmarksMoved = 0;
  let bookmarksDropped = 0;
  for (const bookmark of await db.bookmarks.where('bookId').equals(bookId).toArray()) {
    const text = before.textOf.get(bookmark.sentenceId);
    const same = text ? after.firstOf.get(text) : undefined;
    if (same) {
      bookmarksKept += 1;
      if (same !== bookmark.sentenceId) await db.bookmarks.update(bookmark.id, { sentenceId: same });
      continue;
    }

    // The sentence is gone but its chapter may not be: keep the bookmark at the
    // start of that chapter rather than losing the reader's place entirely.
    const oldChapter = book.parsed.chapters.find((chapter) => chapter.id === bookmark.chapterId);
    const newChapter = oldChapter
      ? parsed.doc.chapters.find((chapter) => chapter.title === oldChapter.title)
      : undefined;
    const opening = newChapter?.blocks.flatMap((block) => block.sentences)[0];
    if (!newChapter || !opening) {
      bookmarksDropped += 1;
      await db.bookmarks.delete(bookmark.id);
      continue;
    }
    bookmarksMoved += 1;
    await db.bookmarks.update(bookmark.id, { chapterId: newChapter.id, sentenceId: opening.id });
  }

  let positionKept = true;
  let lastPos = book.lastPos;
  if (lastPos) {
    const text = before.textOf.get(lastPos.sentenceId);
    const same = text ? after.firstOf.get(text) : undefined;
    const oldChapter = book.parsed.chapters.find((chapter) => chapter.id === lastPos!.chapterId);
    const newChapter = oldChapter
      ? parsed.doc.chapters.find((chapter) => chapter.title === oldChapter.title)
      : undefined;
    const opening = newChapter?.blocks.flatMap((block) => block.sentences)[0];
    const target = same ? { chapterId: after.flat.find((s) => s.id === same)?.chapterId, sentenceId: same } : undefined;

    if (target?.chapterId) {
      lastPos = { chapterId: target.chapterId, sentenceId: target.sentenceId };
    } else if (newChapter && opening) {
      lastPos = { chapterId: newChapter.id, sentenceId: opening.id };
    } else {
      lastPos = undefined;
      positionKept = false;
    }
  }

  await db.books.update(bookId, { parsed: parsed.doc, lastPos });

  return {
    layout: parsed.layout,
    sentencesBefore: before.flat.length,
    sentencesAfter: after.flat.length,
    highlightsKept,
    highlightsDropped,
    bookmarksKept,
    bookmarksMoved,
    bookmarksDropped,
    positionKept,
  };
}

function sentenceIndex(doc: ParsedDoc): SentenceIndex {
  const flat: FlatSentence[] = [];
  const textOf = new Map<string, string>();
  const firstOf = new Map<string, string>();

  for (const chapter of doc.chapters) {
    for (const block of chapter.blocks) {
      for (const sentence of block.sentences) {
        flat.push({ id: sentence.id, chapterId: chapter.id, text: sentence.text });
        textOf.set(sentence.id, sentence.text);
        if (!firstOf.has(sentence.text)) firstOf.set(sentence.text, sentence.id);
      }
    }
  }

  return { flat, textOf, firstOf };
}

/**
 * The new ids of a run of sentences, matched as a run so a highlight keeps its
 * extent; failing that, each sentence wherever it now appears.
 */
function matchRun(texts: string[], after: SentenceIndex): string[] {
  if (!texts.length) return [];

  for (let start = 0; start + texts.length <= after.flat.length; start++) {
    const matches = texts.every((text, offset) => after.flat[start + offset].text === text);
    if (matches) return after.flat.slice(start, start + texts.length).map((sentence) => sentence.id);
  }

  return texts
    .map((text) => after.firstOf.get(text))
    .filter((id): id is string => Boolean(id));
}
