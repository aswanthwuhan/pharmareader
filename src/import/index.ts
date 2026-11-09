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

async function parseFile(file: File): Promise<{ doc: ParsedDoc; warning?: string }> {
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
      const parsed = await parsePdf(await file.arrayBuffer(), fallback);
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

/** Full result including the scanned-PDF warning the library shows inline. */
export async function importFileDetailed(file: File): Promise<ImportResult> {
  const { doc, warning } = await parseFile(file);
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

  let response: Response;
  try {
    response = await fetch(target.toString());
  } catch {
    throw new Error('This site blocks web import; paste the text instead.');
  }
  if (!response.ok) {
    throw new Error(`That page returned ${response.status}; paste the text instead.`);
  }

  const html = await response.text();
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

  return saveRecord(parsed, new Blob([article.content], { type: 'text/html' }));
}
