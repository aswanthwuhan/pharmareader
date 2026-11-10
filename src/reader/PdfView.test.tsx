import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PdfRect } from '../core/types';

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

let container: HTMLDivElement;
let root: Root | null = null;

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
  fullscreen = false
): Promise<void> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <PdfView
        docKey="book-1"
        file={file}
        page={1}
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

  it('fits the whole page in full screen and returns to width when it leaves', async () => {
    // Full screen: a phone-width, phone-height box, so the page must shrink to
    // the height instead of hanging off the bottom.
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 600 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 300 });
    const file = new Blob(['%PDF-1.4']);

    await renderView(RECTS, file, true);
    // Fit width by default: 600pt page in 600px → scale 1, 2× bitmap.
    await waitFor(() => canvas().width === 1200, 'fit-width paint in full screen');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Fit page"]')?.click();
    });
    // Height fit is 300/792 ≈ 0.379, which is smaller than the width fit.
    await waitFor(() => canvas().width === 454, 'fit-page paint');
    expect(canvas().height).toBe(600);

    // Leaving full screen drops fit page: the box can only be width-fitted.
    await act(async () => {
      root?.render(
        <PdfView docKey="book-1" file={file} page={1} rects={RECTS} onPageChange={() => undefined} />
      );
    });
    await waitFor(() => canvas().width === 1200, 'back to fit width');
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
});
