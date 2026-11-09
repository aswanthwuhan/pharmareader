import { GlobalWorkerOptions, Util, getDocument } from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { ParsedDoc } from '../core/types';
import { normaliseText } from './blocks';
import {
  chaptersFromPages,
  dropPageFurniture,
  itemsToLines,
  pagesToParagraphs,
  type ChapterStart,
  type PdfPage,
  type PdfTextItem,
} from './pdfLayout';

GlobalWorkerOptions.workerSrc ||= workerUrl;

export interface PdfParseResult {
  doc: ParsedDoc;
  /** Text extracted per page — under ~50 means the PDF is probably a scan. */
  charsPerPage: number;
  pageCount: number;
}

export async function parsePdf(data: ArrayBuffer, fallbackTitle: string): Promise<PdfParseResult> {
  const loadingTask = getDocument({ data: new Uint8Array(data) });

  try {
    const pdf = await loadingTask.promise;
    const { title, author } = await metadata(pdf, fallbackTitle);
    const pages: PdfPage[] = [];

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items: PdfTextItem[] = [];

      for (const raw of content.items) {
        if (!('str' in raw) || !raw.str.trim()) continue;
        // Viewport transform maps PDF user space to scale-1, top-left-origin space.
        const matrix = Util.transform(viewport.transform, raw.transform) as number[];
        const height = Math.hypot(matrix[2], matrix[3]) || raw.height || 10;
        items.push({
          str: raw.str,
          x: matrix[4],
          y: matrix[5] - height,
          w: raw.width ?? 0,
          h: height,
        });
      }

      pages.push({ width: viewport.width, height: viewport.height, lines: itemsToLines(items) });
      page.cleanup();
    }

    const paragraphs = pagesToParagraphs(dropPageFurniture(pages));
    const charCount = paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0);
    const chapters = chaptersFromPages(paragraphs, await outlineStarts(pdf), pdf.numPages);

    return {
      doc: { title, author, format: 'pdf', chapters },
      charsPerPage: pdf.numPages ? charCount / pdf.numPages : 0,
      pageCount: pdf.numPages,
    };
  } finally {
    await loadingTask.destroy();
  }
}

async function metadata(pdf: PDFDocumentProxy, fallbackTitle: string): Promise<{ title: string; author?: string }> {
  let title = normaliseText(fallbackTitle);
  let author: string | undefined;

  try {
    const info = (await pdf.getMetadata()).info as Record<string, unknown>;
    if (typeof info.Title === 'string' && info.Title.trim()) title = normaliseText(info.Title);
    if (typeof info.Author === 'string' && info.Author.trim()) author = normaliseText(info.Author) || undefined;
  } catch {
    // Metadata is optional; the file name is a fine title.
  }

  return { title: title || 'Untitled PDF', author };
}

/** Top-level outline entries only: sub-headings would fragment chapters. */
async function outlineStarts(pdf: PDFDocumentProxy): Promise<ChapterStart[]> {
  let outline: Awaited<ReturnType<PDFDocumentProxy['getOutline']>>;
  try {
    outline = await pdf.getOutline();
  } catch {
    return [];
  }
  if (!outline?.length) return [];

  const starts: ChapterStart[] = [];
  for (const node of outline) {
    const page = await destinationPage(pdf, node.dest);
    if (page !== null) starts.push({ page: page + 1, title: normaliseText(node.title) });
  }

  starts.sort((a, b) => a.page - b.page);
  return starts.filter((start, index) => index === 0 || start.page > starts[index - 1].page);
}

async function destinationPage(pdf: PDFDocumentProxy, dest: unknown): Promise<number | null> {
  try {
    const resolved = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
    if (!Array.isArray(resolved) || !resolved.length) return null;

    const target = resolved[0];
    if (typeof target === 'number') return target;
    if (target && typeof target === 'object') {
      return await pdf.getPageIndex(target as Parameters<PDFDocumentProxy['getPageIndex']>[0]);
    }
  } catch {
    // Broken destination: fall back to the 20-page chapters.
  }
  return null;
}
