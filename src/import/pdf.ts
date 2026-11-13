// The polyfills go in before pdf.js evaluates, and the legacy build is the one
// pdf.js ships for engines older than the newest Chromium (see pdfPolyfill.ts).
import './pdfPolyfill';
import { GlobalWorkerOptions, Util, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import workerUrl from './pdfWorker?worker&url';
import type { ParsedDoc } from '../core/types';
import { getSetting } from '../core/settings';
import { normaliseText } from './blocks';
import { layoutParagraphs, type AssignOptions } from './layout/assign';
import { createLayoutDetector, type PageLayoutDetector } from './layout/detector';
import { LAYOUT_MODEL } from './layout/model';
import type { LayoutBox } from './layout/engine';
import {
  chaptersFromPages,
  classifyParagraphs,
  documentGutter,
  dropPageFurniture,
  gutterHasTextOnBothSides,
  itemsToPageLines,
  lineMetrics,
  linesToParagraphs,
  needsModelLayout,
  pageGutter,
  pageRunsInColumns,
  stitchPages,
  typicalPitch,
  type ChapterStart,
  type Gutter,
  type PdfPage,
  type PdfParagraph,
  type PdfTextItem,
} from './pdfLayout';
import type { ColumnMode, PanelRect } from './layout/assign';
import { pagePanels } from './panels';
import { PDF_ASSETS } from './pdfAssets';

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
  /**
   * How the layout was decided, so the importer can tell the user what ran:
   * `model` when the detector was there for every page that asked for it.
   */
  layout: 'model' | 'heuristic';
  /** Pages the model laid out; 0 with `model` means no page needed it. */
  modelPages: number;
  /**
   * Set when the model was installed and wanted but did not lay out every page
   * that asked for it, in words the reader can be shown. A silent fall back to
   * the text layout looks exactly like a model that does not work.
   */
  modelNote?: string;
}

export interface PdfParseOptions {
  /**
   * How many columns the pages have. Left alone, a gutter is looked for and
   * used when the text shows one.
   */
  columns?: ColumnMode;
}

export async function parsePdf(
  data: ArrayBuffer,
  fallbackTitle: string,
  onProgress?: (done: number, total: number, phase?: 'text' | 'layout') => void,
  options: PdfParseOptions = {},
): Promise<PdfParseResult> {
  const columns = options.columns ?? 'auto';
  const loadingTask = getDocument({ data: new Uint8Array(data), ...PDF_ASSETS });
  let detector: PageLayoutDetector | null = null;

  try {
    const pdf = await loadingTask.promise;
    const { title, author } = await metadata(pdf, fallbackTitle);
    const pages: PdfPage[] = [];
    const pageItems: PdfTextItem[][] = [];
    const pageBoxes: LayoutBox[][] = [];
    const pagePanelList: PanelRect[][] = [];
    const pageGutters: (Gutter | null)[] = [];
    let modelNote: string | undefined;
    try {
      detector = await layoutDetector();
    } catch (error) {
      // A machine without WebAssembly, or a corrupt download: read the text as
      // before rather than failing the whole import — and say so.
      modelNote = `The layout model could not start, so this PDF was read with the text layout only (${reason(error)}).`;
    }
    let misses = 0;
    let failed = 0;

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items: PdfTextItem[] = [];
      let spaceBefore = false;

      for (const raw of content.items) {
        if (!('str' in raw)) continue;
        if (!raw.str.trim()) {
          // pdf.js reports the space between two runs (roman → italic → roman) as
          // a run of its own. The gap it stands for is often narrower than the
          // gap rule accepts, so dropping it reads "studied in vivo induced" as
          // "studiedin vivoinduced": hand the space to the run that follows.
          spaceBefore = raw.str.length > 0;
          continue;
        }
        // Viewport transform maps PDF user space to scale-1, top-left-origin space.
        const matrix = Util.transform(viewport.transform, raw.transform) as number[];
        const height = Math.hypot(matrix[2], matrix[3]) || raw.height || 10;
        const str = spaceBefore && !/^\s/.test(raw.str) ? ` ${raw.str}` : raw.str;
        spaceBefore = false;
        items.push({
          str,
          x: matrix[4],
          y: matrix[5] - height,
          w: raw.width ?? 0,
          h: height,
          page: pageNumber,
        });
      }

      // Boxed panels are painted graphics, so they have to be read before
      // `cleanup` drops the page's operator list.
      const panels = await pagePanels(page, viewport, items);
      const gutter = columns === 1 ? null : pageGutter(items, viewport.width);
      const pageLines = itemsToPageLines(items, viewport.width, { panels, gutter, columns });
      const sheet: PdfPage = { width: viewport.width, height: viewport.height, lines: pageLines };

      if (detector && needsModelLayout(sheet)) {
        // The page has to be rasterised before `cleanup` drops its operators.
        const boxes = await detectBoxes(detector, page, viewport, pageNumber);
        // One page that will not render must not cost the rest of the book its
        // layout; three in a row means the model itself is gone.
        misses = boxes ? 0 : misses + 1;
        if (!boxes) failed += 1;
        if (misses >= 3) {
          // Dropping the handle alone would leave the worker and its ~200 MB alive.
          detector.dispose();
          detector = null;
        }
        pageBoxes.push(boxes ?? []);
      } else {
        pageBoxes.push([]);
      }

      pages.push(sheet);
      pageItems.push(items);
      pagePanelList.push(panels);
      pageGutters.push(gutter);
      page.cleanup();
      // One page at a time, so a long paper never blocks the caller for the whole
      // run and the UI can show where it has got to.
      onProgress?.(pageNumber, pdf.numPages, detector ? 'layout' : 'text');
    }

    const modelStayed = detector !== null;
    detector?.dispose();
    detector = null;

    // A page whose own text is too thin to show a corridor is still read in the
    // book's two columns, so long as the book mostly showed one and this page
    // has text running up to both edges of it.
    const textPages = pageItems.filter((items) => items.length > 0).length;
    const bookGutter = documentGutter(pageGutters, textPages);
    if (bookGutter) {
      pages.forEach((page, index) => {
        if (pageGutters[index]) return;
        const items = pageItems[index];
        // A figure or a full-page table has no text beside the corridor, and
        // splitting it there would cut it in two.
        if (columns !== 2 && !gutterHasTextOnBothSides(items, bookGutter, page.width)) return;
        // A one-column page's full-width lines also run up to both edges of a
        // corridor; only a page whose rows mostly run along it reads in columns.
        if (columns !== 2 && !pageRunsInColumns(items, bookGutter)) return;
        page.lines = itemsToPageLines(items, page.width, {
          panels: pagePanelList[index],
          gutter: bookGutter,
          columns,
        });
      });
    }

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

      // The band the page was read in, so the model's boxes follow the same
      // panels, columns and gutter the text layout did.
      const modelOptions: AssignOptions = {
        pitch,
        measure,
        panels: pagePanelList[index],
        columns,
        gutter: pageGutters[index] ?? bookGutter ?? undefined,
      };

      const laidOut = boxes.length
        ? layoutParagraphs(pageNumber, page.width, page.height, items, boxes, modelOptions)
        : [];

      paragraphs.push(
        ...(laidOut.length ? laidOut : linesToParagraphs(pageNumber, page.lines, page.width, pitch, measure)),
      );
    });

    const finalParagraphs = stitchPages(classifyParagraphs(paragraphs, clean));
    const charCount = finalParagraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0);
    const chapters = chaptersFromPages(finalParagraphs, await outlineStarts(pdf), pdf.numPages);

    return {
      doc: { title, author, format: 'pdf', chapters },
      charsPerPage: pdf.numPages ? charCount / pdf.numPages : 0,
      pageCount: pdf.numPages,
      // A page the model could not read was laid out from the text: say so, and
      // the book stays on offer for re-analysis.
      layout: modelStayed && failed === 0 ? 'model' : 'heuristic',
      modelNote:
        modelNote ??
        (failed
          ? `The layout model failed on ${failed} ${failed === 1 ? 'page' : 'pages'}${modelStayed ? '' : ' and was stopped'}; ${modelStayed ? (failed === 1 ? 'that page was' : 'those pages were') : 'the rest of this PDF was'} read with the text layout only.`
          : undefined),
      modelPages: pageBoxes.filter((boxes) => boxes.length > 0).length,
    };
  } finally {
    // A page that throws must not strand the model either.
    detector?.dispose();
    await loadingTask.destroy();
  }
}

/** The detector, when the setting allows it and the model is installed. */
async function layoutDetector(): Promise<PageLayoutDetector | null> {
  // A settings read that fails is not a model that failed: fall back to the default.
  const mode = await getSetting<LayoutMode>('import.layout', 'auto').catch(() => 'auto' as LayoutMode);
  if (mode === 'heuristic') return null;
  // Null when the model is not downloaded; a model that is there and will not
  // start throws, and the caller reports it.
  return createLayoutDetector();
}

function reason(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).trim().replace(/[.\s]+$/, '');
  return text || 'no reason given';
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

