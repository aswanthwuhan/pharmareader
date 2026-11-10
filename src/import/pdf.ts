// The polyfills go in before pdf.js evaluates, and the legacy build is the one
// pdf.js ships for engines older than the newest Chromium (see pdfPolyfill.ts).
import './pdfPolyfill';
import { GlobalWorkerOptions, Util, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import workerUrl from './pdfWorker?worker&url';
import type { ParsedDoc } from '../core/types';
import { getSetting } from '../core/settings';
import { normaliseText } from './blocks';
import { layoutParagraphs } from './layout/assign';
import { createLayoutDetector, type PageLayoutDetector } from './layout/detector';
import { LAYOUT_MODEL } from './layout/model';
import type { LayoutBox } from './layout/engine';
import {
  chaptersFromPages,
  classifyParagraphs,
  dropPageFurniture,
  itemsToPageLines,
  lineMetrics,
  linesToParagraphs,
  needsModelLayout,
  stitchPages,
  typicalPitch,
  type ChapterStart,
  type PdfPage,
  type PdfParagraph,
  type PdfTextItem,
} from './pdfLayout';

GlobalWorkerOptions.workerSrc ||= workerUrl;

/**
 * How a book's layout is worked out. `auto` uses the model when it is downloaded
 * and the text heuristics otherwise; `heuristic` never touches the model, for a
 * book where the text layout reads better.
 */
export type LayoutMode = 'auto' | 'heuristic';

export interface PdfParseResult {
  doc: ParsedDoc;
  /** Text extracted per page — under ~50 means the PDF is probably a scan. */
  charsPerPage: number;
  pageCount: number;
  /** How the layout was decided, so the importer can tell the user what ran. */
  layout: 'model' | 'heuristic';
}

export async function parsePdf(
  data: ArrayBuffer,
  fallbackTitle: string,
  onProgress?: (done: number, total: number, phase?: 'text' | 'layout') => void,
): Promise<PdfParseResult> {
  const loadingTask = getDocument({ data: new Uint8Array(data) });

  try {
    const pdf = await loadingTask.promise;
    const { title, author } = await metadata(pdf, fallbackTitle);
    const pages: PdfPage[] = [];
    const pageItems: PdfTextItem[][] = [];
    const pageBoxes: LayoutBox[][] = [];
    let detector = await layoutDetector();

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
          page: pageNumber,
        });
      }

      const pageLines = itemsToPageLines(items, viewport.width);
      const sheet: PdfPage = { width: viewport.width, height: viewport.height, lines: pageLines };

      if (detector && needsModelLayout(sheet)) {
        // The page has to be rasterised before `cleanup` drops its operators.
        const boxes = await detectBoxes(detector, page, viewport, pageNumber);
        if (!boxes) detector = null;
        pageBoxes.push(boxes ?? []);
      } else {
        pageBoxes.push([]);
      }

      pages.push(sheet);
      pageItems.push(items);
      page.cleanup();
      // One page at a time, so a long paper never blocks the caller for the whole
      // run and the UI can show where it has got to.
      onProgress?.(pageNumber, pdf.numPages, detector ? 'layout' : 'text');
    }

    detector?.dispose();

    const clean = dropPageFurniture(pages);
    const metrics = clean.map((page) => lineMetrics(page.lines));
    const documentPitch = typicalPitch(clean);

    const paragraphs: PdfParagraph[] = [];
    clean.forEach((page, index) => {
      const pageNumber = index + 1;
      const pitch = metrics[index].pitch || documentPitch;
      const measure = metrics[index].measure || page.width;
      const boxes = pageBoxes[index];

      // Running heads that repeat on most pages are already gone; what the model
      // calls a header or a footer is a one-off, and it becomes a skippable block.
      const kept = new Set(page.lines.flatMap((line) => line.items));
      const items = pageItems[index].filter((item) => kept.has(item));

      const laidOut = boxes.length
        ? layoutParagraphs(pageNumber, page.width, page.height, items, boxes, { pitch, measure })
        : [];

      paragraphs.push(
        ...(laidOut.length ? laidOut : linesToParagraphs(pageNumber, page.lines, page.width, pitch, measure)),
      );
    });

    const finalParagraphs = stitchPages(classifyParagraphs(paragraphs, clean));
    const charCount = finalParagraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0);
    const chapters = chaptersFromPages(finalParagraphs, await outlineStarts(pdf), pdf.numPages);
    const usedModel = pageBoxes.some((boxes) => boxes.length > 0);

    return {
      doc: { title, author, format: 'pdf', chapters },
      charsPerPage: pdf.numPages ? charCount / pdf.numPages : 0,
      pageCount: pdf.numPages,
      layout: usedModel ? 'model' : 'heuristic',
    };
  } finally {
    await loadingTask.destroy();
  }
}

/** The detector, when the setting allows it and the model is installed. */
async function layoutDetector(): Promise<PageLayoutDetector | null> {
  const mode = await getSetting<LayoutMode>('import.layout', 'auto');
  if (mode === 'heuristic') return null;
  try {
    return await createLayoutDetector();
  } catch {
    // A machine without WebAssembly, or a corrupt download: read the text as
    // before rather than failing the whole import.
    return null;
  }
}

/**
 * Render one page into the model's square input and read its regions.
 * Returns null when rendering is impossible, so the caller can stop trying.
 */
async function detectBoxes(
  detector: PageLayoutDetector,
  page: PDFPageProxy,
  viewport: ReturnType<PDFPageProxy['getViewport']>,
  pageNumber: number,
): Promise<LayoutBox[] | null> {
  const size = LAYOUT_MODEL.inputSize;
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  if (!canvas) return null;

  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;

  try {
    // The model was trained on pages stretched to a square, so the page is
    // squashed into it; scale_factor stays 1 and the boxes are mapped back by
    // dividing by the input size.
    await page.render({
      canvas,
      canvasContext: context,
      viewport,
      transform: [size / viewport.width, 0, 0, size / viewport.height, 0, 0],
    }).promise;
    const pixels = context.getImageData(0, 0, size, size).data;
    return await detector.detect(pixels, viewport.width, viewport.height);
  } catch (error) {
    console.warn(`Layout detection failed on page ${pageNumber}; using text heuristics.`, error);
    return null;
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

