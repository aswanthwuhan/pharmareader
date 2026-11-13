import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PdfRect } from '../core/types';
import type { PageBlock } from './blockOrder';

const pdf = vi.hoisted(() => {
  const cancel = vi.fn();
  const cleanup = vi.fn();
  const destroy = vi.fn(() => Promise.resolve());
  const page = {
    pageNumber: 1,
    cleanup,
    getViewport: vi.fn(({ scale }: { scale: number }) => ({ scale, width: 600 * scale, height: 792 * scale })),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel })),
  };
  const getDocument = vi.fn(() => ({
    promise: Promise.resolve({ numPages: 5, getPage: async () => page }),
    destroy,
  }));
  return { page, cancel, cleanup, destroy, getDocument };
});

// The page view imports the official legacy pdf.js build (the default one calls
// ES2025 helpers the phone's WebView lacks) plus a worker wrapper module.
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ GlobalWorkerOptions: {}, getDocument: pdf.getDocument }));
vi.mock('../import/pdfWorker?worker&url', () => ({ default: 'worker.js' }));

const { default: PdfView } = await import('./PdfView');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RECTS: PdfRect[] = [{ page: 1, x: 10, y: 20, w: 100, h: 30 }];

/** A page's blocks, as ReaderView hands them over. */
const BLOCKS: PageBlock[] = [
  { chapterIndex: 0, blockIndex: 0, blockId: 'b1', kind: 'p', order: 1, box: { x: 10, y: 20, w: 100, h: 30 } },
  { chapterIndex: 0, blockIndex: 1, blockId: 'b2', kind: 'h', order: 2, box: { x: 10, y: 60, w: 100, h: 20 } },
];

let container: HTMLDivElement;
let root: Root | null = null;
const scrollTo = vi.fn();

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function renderView(
  rects: PdfRect[] = RECTS,
  file: Blob = new Blob(['%PDF-1.4']),
  fullscreen = false,
  docKey = 'book-1',
  page = 1
): Promise<void> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await rerenderView(rects, file, fullscreen, docKey, page);
}

async function rerenderView(
  rects: PdfRect[] = RECTS,
  file: Blob = new Blob(['%PDF-1.4']),
  fullscreen = false,
  docKey = 'book-1',
  page = 1
): Promise<void> {
  await act(async () => {
    root?.render(
      <PdfView
        docKey={docKey}
        file={file}
        page={page}
        rects={rects}
        onPageChange={() => undefined}
        fullscreen={fullscreen}
      />
    );
  });
}

function canvas(): HTMLCanvasElement {
  const element = container.querySelector<HTMLCanvasElement>('canvas');
  if (!element) throw new Error('no canvas');
  return element;
}

beforeEach(() => {
  pdf.page.render.mockClear();
  pdf.cancel.mockClear();
  pdf.cleanup.mockClear();
  pdf.destroy.mockClear();
  pdf.getDocument.mockClear();
  scrollTo.mockClear();
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value: scrollTo,
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => ({}) as unknown as CanvasRenderingContext2D
  );
  // jsdom has no layout: give the wrapper a phone width and a 2× screen.
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 300 });
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  container.remove();
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
  delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
  delete (window as { devicePixelRatio?: number }).devicePixelRatio;
});

describe('PdfView', () => {
  it('paints the page at device resolution and scales the sentence overlay with it', async () => {
    await renderView();
    await waitFor(() => canvas().width > 0, 'first paint');

    // 600pt wide page fitted into 300px → scale 0.5, painted at 2× for sharpness.
    expect(canvas().width).toBe(600);
    expect(canvas().height).toBe(792);
    expect(canvas().getAttribute('role')).toBe('img');
    expect(canvas().getAttribute('aria-label')).toBe('Page 1 of 5');

    const rect = container.querySelector<HTMLElement>('.rd-pdf-rect');
    expect(rect).not.toBeNull();
    expect(parseFloat(rect?.style.left ?? '')).toBeCloseTo(5);
    expect(parseFloat(rect?.style.top ?? '')).toBeCloseTo(10);
    expect(parseFloat(rect?.style.width ?? '')).toBeCloseTo(50);
    expect(parseFloat(rect?.style.height ?? '')).toBeCloseTo(15);
  });

  it('rescales the overlay when the reader zooms', async () => {
    await renderView();
    await waitFor(() => canvas().width === 600, 'first paint');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')?.click();
    });
    await waitFor(() => canvas().width === 720, 'zoomed paint');

    const rect = container.querySelector<HTMLElement>('.rd-pdf-rect');
    expect(parseFloat(rect?.style.left ?? '')).toBeCloseTo(6);
    expect(parseFloat(rect?.style.width ?? '')).toBeCloseTo(60);
  });

  it('releases the canvas bitmap and the document when unmounted', async () => {
    await renderView();
    await waitFor(() => canvas().width === 600, 'first paint');
    const element = canvas();

    act(() => root?.unmount());
    root = null;

    expect(element.width).toBe(0);
    expect(element.height).toBe(0);
    expect(pdf.destroy).toHaveBeenCalled();
    expect(pdf.cleanup).toHaveBeenCalled();
  });

  it('hides rects that belong to another page', async () => {
    await renderView([
      { page: 1, x: 10, y: 20, w: 100, h: 30 },
      { page: 2, x: 10, y: 20, w: 100, h: 30 },
    ]);
    await waitFor(() => canvas().width > 0, 'first paint');
    expect(container.querySelectorAll('.rd-pdf-rect').length).toBe(1);
  });

  it('paints at the real width after a zero-width first measure (the tiny-page report)', async () => {
    // The report was: the first paint lands before the reader's layout settles,
    // so the page is drawn at a fraction of its width until Text/Page is toggled.
    let measured = 0;
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => measured });

    await renderView();
    // No width yet: painting a guess here is what produced the tiny page.
    expect(pdf.page.render).not.toHaveBeenCalled();

    measured = 300;
    await act(async () => {
      window.dispatchEvent(new Event('resize'));
    });

    await waitFor(() => canvas().width === 600, 'paint once the width is known');
    expect(parseFloat(container.querySelector<HTMLElement>('.rd-pdf-rect')?.style.width ?? '')).toBeCloseTo(50);
  });

  it('fits the whole page when it enters full screen and re-fits when it leaves', async () => {
    // Full screen: a phone-width, phone-height box, so the page must shrink to
    // the height instead of hanging off the bottom.
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 600 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 300 });
    const file = new Blob(['%PDF-1.4']);

    await renderView(RECTS, file, true);
    // Fit page by default: 300/792 ≈ 0.379 of a 600pt sheet, painted at 2×.
    await waitFor(() => canvas().width === 454, 'fit-page paint in full screen');
    expect(canvas().height).toBe(600);

    // The manual override still exists, in full screen as anywhere else.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Fit width"]')?.click();
    });
    await waitFor(() => canvas().width === 1200, 'fit-width paint');

    // Leaving full screen re-fits the page for the smaller box: no button press.
    // The box is a tablet's here (700 tall), so "auto" lands on fit page again.
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 700 });
    await rerenderView(RECTS, file);
    await waitFor(() => canvas().width === 1060, 'fit page again after leaving full screen');
    // Fit page is a control in both layouts now, not a full-screen privilege.
    expect(container.querySelector('[aria-label="Fit page"]')).not.toBeNull();
  });

  it('fits a portrait page by height in a tablet-width box, without overflow', async () => {
    // A 600×792 pt sheet in a box with room for it: the height is the tighter
    // fit, and fitting only the width is what used to crop the page.
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 600 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 700 });

    await renderView();
    // 700/792 ≈ 0.884 → 530 CSS px wide, 700 tall, painted at 2×.
    await waitFor(() => canvas().width === 1060, 'fit-by-height paint');
    expect(canvas().height).toBe(1400);
    expect(canvas().width).toBeLessThan(600 * 2);
    expect(container.querySelector('[aria-label="Fit page"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[aria-label="Fit width"]')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('fills the width on a phone instead of fitting a thumbnail of the sheet', async () => {
    // What a phone's page box is worth once the bar, the player and the toolbar
    // have taken their share: 360×220. The report was "in page view no PDF is
    // shown" — the sheet fitted the height of this box, which is a 27px page.
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 360 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 220 });

    await renderView();
    // 360/600 = 0.6 of the sheet, painted at 2×, and the box scrolls the rest.
    await waitFor(() => canvas().width === 720, 'fit-width paint');
    expect(canvas().height).toBe(950);
    expect(container.querySelector('[aria-label="Fit width"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[aria-label="Fit page"]')?.getAttribute('aria-pressed')).toBe('false');

    // The whole sheet is still one tap away, at the size it was fitted to.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Fit page"]')?.click();
    });
    await waitFor(() => canvas().width === 333, 'fit-page paint');
    expect(container.querySelector('[aria-label="Fit page"]')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('returns to fit page and 100% when the document changes', async () => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 600 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 700 });

    await renderView();
    await waitFor(() => canvas().width === 1060, 'fit-page first paint');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Fit width"]')?.click();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')?.click();
    });
    await waitFor(() => canvas().width === 1440, 'fit width at 120%');

    await rerenderView(RECTS, new Blob(['%PDF-1.4']), false, 'book-2');
    await waitFor(() => canvas().width === 1060, 'the new book starts at fit page, 100%');
  });

  it('scrolls the page box to a sentence that is below the fold', async () => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 300 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 200 });

    // A 300×200 box: the sheet fills the width and hangs below the fold, so
    // following the voice scrolls from the first paint. Fit width: scale 0.5,
    // the line starts at 350px in a 200px box.
    await renderView([{ page: 1, x: 10, y: 700, w: 100, h: 30 }]);
    await waitFor(() => scrollTo.mock.calls.length > 0, 'scroll to the sentence on the first paint');

    const options = scrollTo.mock.calls.at(-1)?.[0] as ScrollToOptions;
    // Enough to bring the line in with a margin, not yanked to the very top.
    expect(options.top).toBeGreaterThan(200);
    expect(options.top).toBeLessThan(350);
    expect(options.behavior).toBe('smooth');

    // The reader asks for the whole sheet: then nothing can be below the fold.
    scrollTo.mockClear();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Fit page"]')?.click();
    });
    await waitFor(() => canvas().width === 303, 'fit-page paint');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('starts a newly shown page at its top when the box was scrolled', async () => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 300 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 200 });

    // A box that shows the top of a page taller than itself is one the reader
    // can leave scrolled: the next page must not open halfway down.
    await renderView();
    await waitFor(() => canvas().width === 600, 'width-fit first paint');
    const box = container.querySelector<HTMLElement>('.rd-pdf-wrap');
    if (!box) throw new Error('no page box');
    box.scrollTop = 140;

    await rerenderView(RECTS, new Blob(['%PDF-1.4']), false, 'book-1', 2);
    await waitFor(() => box.scrollTop === 0, 'the new page starts at its top');
  });

  it('leaves a sentence that is already visible where it is', async () => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 300 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 200 });

    // RECTS[0] starts at y=20: with the whole page fitted into the 200px box it
    // is already showing, so following the voice must not move anything.
    await renderView();
    await waitFor(() => canvas().width > 0, 'first paint');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('says the stored file is gone instead of failing inside pdf.js', async () => {
    await renderView(RECTS, new Blob([]));

    await waitFor(() => container.querySelector('.banner-error') !== null, 'missing-file banner');

    const banner = container.querySelector('.banner-error')?.textContent ?? '';
    expect(banner).toContain('The original file is no longer available');
    expect(banner).toContain('re-import it to use Page view and Re-analyse');
    // pdf.js would only say "The PDF file is empty, size zero bytes".
    expect(pdf.getDocument).not.toHaveBeenCalled();
  });

  it('opens the reading-order bar under the page on the very first toggle', async () => {
    const onSaveOrder = vi.fn(async () => undefined);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <PdfView
          docKey="book-1"
          file={new Blob(['%PDF-1.4'])}
          page={1}
          rects={RECTS}
          onPageChange={() => undefined}
          fullscreen={false}
          layoutBlocks={BLOCKS}
          onSaveOrder={onSaveOrder}
        />
      );
    });
    await waitFor(() => canvas().width > 0, 'first paint');

    // The bar is the row right after the page box, and it is out of the way —
    // no empty row costing the page column its gap — while the overlay is off.
    const bar = container.querySelector('.rd-pdf-wrap')?.nextElementSibling as HTMLElement;
    expect(bar).toBeInstanceOf(HTMLElement);
    expect(bar.hidden).toBe(true);
    expect(container.querySelectorAll('[data-block-id]')).toHaveLength(0);

    const layoutButton = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === 'Layout'
    );
    await act(async () => layoutButton?.click());
    await waitFor(() => container.querySelectorAll('[data-block-id]').length === BLOCKS.length, 'the page boxes');

    // The host is only known once its ref has run. Read during the render that
    // opens the overlay it is still null, and the bar would be drawn inside the
    // page box instead of under it — over the words still to be tapped.
    expect(bar.hidden).toBe(false);
    expect(bar.textContent).toContain('Fix order');
    expect(container.querySelector('.rd-pdf-page')?.textContent).not.toContain('Fix order');
    expect(layoutButton?.getAttribute('aria-expanded')).toBe('true');

    // And the wiring through to the saver: tap the second block, then save.
    const panelButton = (label: string): HTMLButtonElement | undefined =>
      Array.from(bar.querySelectorAll('button')).find((candidate) => candidate.textContent?.trim() === label);
    await act(async () => panelButton('Fix order')?.click());
    const page = container.querySelector('.rd-pdf-page');
    await act(async () => page?.querySelectorAll<HTMLButtonElement>('button[data-block-id]')[1]?.click());
    await act(async () => panelButton('Save')?.click());

    expect(onSaveOrder).toHaveBeenCalledWith(['b2', 'b1']);
  });
});
