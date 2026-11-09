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

vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: pdf.getDocument }));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'worker.js' }));

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

async function renderView(rects: PdfRect[] = RECTS): Promise<void> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <PdfView docKey="book-1" file={new Blob(['%PDF-1.4'])} page={1} rects={rects} onPageChange={() => undefined} />
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
});
