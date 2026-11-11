/**
 * PDF page view: the real page image with the current sentence boxed on it.
 *
 * Rectangles in `Sentence.pdfRects` are PDF user-space units at scale 1, which
 * is exactly what `page.getViewport({ scale })` scales — so an overlay div at
 * `x * scale` lands on the right glyphs with no PDF matrix maths here.
 *
 * This module is loaded lazily (only for PDF books in page mode) because
 * pdfjs-dist is by far the heaviest dependency in the app.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
// pdf.js 6's default build calls ES2025 helpers the phone's WebView does not
// have (every import crashed with "a.toHex is not a function" on WebView 134);
// the polyfills and the official legacy build are the fix — see pdfPolyfill.ts.
import '../import/pdfPolyfill';
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import workerUrl from '../import/pdfWorker?worker&url';
import { MISSING_FILE_MESSAGE, fileMissing } from '../import';
import type { PdfRect } from '../core/types';
import { Glyph, icons } from './Icon';

GlobalWorkerOptions.workerSrc ||= workerUrl;

interface Props {
  /** Identity of the document: reload only when the book changes. */
  docKey: string;
  file: Blob;
  page: number;
  /** Rectangles of the current sentence, on any page. */
  rects: PdfRect[];
  onPageChange(page: number): void;
  /** Full screen offers "fit page" as well, for seeing a whole figure at once. */
  fullscreen?: boolean;
}

const ZOOM_MIN = 0.6;
const ZOOM_MAX = 3;

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function touchDistance(touches: ArrayLike<{ clientX: number; clientY: number }>): number {
  const [a, b] = [touches[0], touches[1]];
  if (!a || !b) return 0;
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

export default function PdfView({ docKey, file, page, rects, onPageChange, fullscreen = false }: Props) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [zoom, setZoom] = useState(1);
  // How the page is fitted before `zoom`: the whole sheet by default, so a phone
  // shows one complete page instead of the top of a page that hangs off the
  // bottom. "Fit width" is the manual override for reading the print larger.
  const [fit, setFit] = useState<'width' | 'page'>('page');
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [scale, setScale] = useState(1);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderTask = useRef<{ cancel(): void; promise: Promise<unknown> } | null>(null);
  const shownPage = useRef<{ num: number; page: PDFPageProxy } | null>(null);
  const fileRef = useRef(file);
  fileRef.current = file;
  const pinch = useRef<{ distance: number; zoom: number } | null>(null);
  const zoomFrame = useRef(0);
  const pendingZoom = useRef<number | null>(null);

  /** The page number that is actually painted (the prop may be out of range). */
  const painted = pageCount > 0 ? clampNumber(page, 1, pageCount) : page;

  // Load the document once; the pages are rendered on demand below.
  useEffect(() => {
    let alive = true;
    let loadingTask: ReturnType<typeof getDocument> | null = null;
    setDoc(null);
    setPageCount(0);
    setError(null);
    // A book imported before an app update kept the picker's File handle, which
    // reads back as zero bytes (see `ownedCopy`). pdf.js can only answer that
    // with "The PDF file is empty, size zero bytes", which does not tell the
    // reader what to do — so say what happened instead of trying at all.
    if (fileMissing({ fileBlob: fileRef.current })) {
      setLoading(false);
      setError(MISSING_FILE_MESSAGE);
      return;
    }
    setLoading(true);
    void (async () => {
      const data = new Uint8Array(await fileRef.current.arrayBuffer());
      if (!alive) return;
      loadingTask = getDocument({ data });
      const loaded = await loadingTask.promise;
      if (!alive) {
        void loadingTask.destroy();
        return;
      }
      setDoc(loaded);
      setPageCount(loaded.numPages);
      setLoading(false);
    })().catch((err: unknown) => {
      if (!alive) return;
      setLoading(false);
      setError(err instanceof Error ? err.message : String(err));
    });

    return () => {
      alive = false;
      // Drop the bitmap and the decoded page with the view: a 2000-page book
      // should not keep a full-page canvas alive after the reader leaves.
      renderTask.current?.cancel();
      renderTask.current = null;
      const last = shownPage.current;
      shownPage.current = null;
      try {
        last?.page.cleanup();
      } catch {
        // already torn down with the document
      }
      void loadingTask?.destroy();
    };
  }, [docKey]);

  // Free the full-page bitmap when the reader leaves. This effect has to own
  // its element: React detaches refs before passive cleanups, so looking at
  // `canvas.current` from the load effect's cleanup would find null.
  useEffect(() => {
    const element = canvas.current;
    return () => {
      if (element) {
        element.width = 0;
        element.height = 0;
      }
    };
  }, []);

  // Fit to the available width; a rotation or a side panel changes it too.
  //
  // This ran as a plain effect that measured once, and on Android the first
  // measurement could land before the reader's layout had settled, leaving the
  // page painted at a fraction of the screen until Text/Page was toggled. A
  // layout effect measures the frame that is about to be shown, the next frame
  // measures again in case the WebView was still resizing, and the observer
  // watches the wrap *and* its parent so a parent-driven resize is not missed.
  useLayoutEffect(() => {
    const element = wrap.current;
    if (!element) return;

    const measure = () => {
      const next = element.clientWidth;
      if (next > 0) setWidth((previous) => (previous === next ? previous : next));
      // Zero in the normal layout (the wrap has no fixed height): then only the
      // width can fit the page, which is what the non-fullscreen view wants.
      const nextHeight = element.clientHeight;
      if (nextHeight > 0) setHeight((previous) => (previous === nextHeight ? previous : nextHeight));
    };

    measure();
    const frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(measure) : 0;

    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure);
      observer.observe(element);
      if (element.parentElement) observer.observe(element.parentElement);
    }
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);

    return () => {
      if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
    };
  }, []);

  // Fit the whole sheet again whenever the thing being fitted changes: another
  // book, or a full-screen toggle that gives the box a different height. Zoom is
  // relative to that fit, so it starts over with it.
  useEffect(() => {
    setFit('page');
    setZoom(1);
  }, [docKey, fullscreen]);

  // Follow the voice: when the spoken sentence's first line is outside the
  // visible part of the page box, bring it into view with a margin. Only when it
  // is out of view — a line already showing is never yanked out from under a
  // hand that is panning the page.
  useEffect(() => {
    const element = wrap.current;
    // Nothing is painted yet at the initial scale of 1 and a zero-size page:
    // scrolling then would be undone by the first real fit a frame later.
    if (!element || scale <= 0 || size.h <= 0) return;
    const first = rects.find((rect) => rect.page === painted);
    if (!first) return;
    const margin = Math.min(48, element.clientHeight * 0.1);
    const top = first.y * scale;
    const bottom = top + Math.max(first.h * scale, 2);
    const viewTop = element.scrollTop;
    const viewHeight = element.clientHeight;
    // A little slack either way: a line that is already showing stays where it
    // is, so a short sentence is not scrolled twice for nothing.
    if (top >= viewTop - 2 && bottom <= viewTop + viewHeight + 2) return;
    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const target = Math.max(0, top - margin);
    if (typeof element.scrollTo === 'function') {
      element.scrollTo({ top: target, behavior: reduced ? 'auto' : 'smooth' });
    } else {
      element.scrollTop = target;
    }
  }, [rects, scale, painted, size.h]);

  // Paint the page whenever the document, page, zoom or width changes.
  useEffect(() => {
    const element = canvas.current;
    if (!doc || !element || width <= 0) return;
    let cancelled = false;

    void (async () => {
      try {
        const pdfPage = await doc.getPage(clampNumber(page, 1, doc.numPages));
        if (cancelled) return;

        // A cancelled render keeps the canvas busy until its promise settles;
        // starting the next one before that would throw.
        const previous = renderTask.current;
        if (previous) {
          try {
            await previous.promise;
          } catch {
            // a cancelled task always rejects
          }
          if (cancelled) return;
        }

        const base = pdfPage.getViewport({ scale: 1 });
        // Measure again at paint time: the `width` in state is what triggered
        // this run, but a box that grew since then must not be painted small.
        const availableWidth = wrap.current?.clientWidth || width;
        const availableHeight = wrap.current?.clientHeight || height;
        const widthFit = availableWidth / base.width;
        // "Fit page": the smaller of the two fits, so a portrait sheet is shown
        // complete inside the box — on a phone the height is usually the tighter
        // one, and fitting only the width is what cropped the page.
        const pageFit = availableHeight > 0 ? Math.min(widthFit, availableHeight / base.height) : widthFit;
        const baseFit = fit === 'page' ? pageFit : widthFit;
        const viewport = pdfPage.getViewport({ scale: baseFit * zoom });
        const ratio = Math.min(window.devicePixelRatio || 1, 2);

        // Publish the geometry *before* painting, so the sentence overlay is
        // never drawn at the previous page's scale.
        setScale(viewport.scale);
        setSize({ w: viewport.width, h: viewport.height });

        renderTask.current?.cancel();
        element.width = Math.floor(viewport.width * ratio);
        element.height = Math.floor(viewport.height * ratio);
        const context = element.getContext('2d');
        if (!context) return;
        const task = pdfPage.render({
          canvas: element,
          canvasContext: context,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
        });
        renderTask.current = task;
        await task.promise;
        if (cancelled) return;

        // Only one page's operator list is worth keeping on a phone.
        const last = shownPage.current;
        if (last && last.num !== pdfPage.pageNumber) {
          try {
            last.page.cleanup();
          } catch {
            // the page proxy may already be gone with the document
          }
        }
        shownPage.current = { num: pdfPage.pageNumber, page: pdfPage };
      } catch (err) {
        // Cancelling a render is normal when the reader turns pages quickly.
        const name = err instanceof Error ? err.name : '';
        if (cancelled || name === 'RenderingCancelledException') return;
        setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
      renderTask.current?.cancel();
    };
  }, [doc, page, zoom, width, height, fit, fullscreen]);

  // Pinch rerenders the whole page; coalesce touchmove bursts to one per frame.
  function scheduleZoom(value: number): void {
    pendingZoom.current = value;
    if (zoomFrame.current || typeof requestAnimationFrame === 'undefined') {
      if (!zoomFrame.current) setZoom(value);
      return;
    }
    zoomFrame.current = requestAnimationFrame(() => {
      zoomFrame.current = 0;
      const next = pendingZoom.current;
      if (next !== null) setZoom(next);
    });
  }

  useEffect(() => {
    return () => {
      if (zoomFrame.current && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(zoomFrame.current);
    };
  }, []);

  // A book whose bytes are gone has nothing to paint: show the explanation on
  // its own instead of an empty page box and a dead page counter.
  if (error === MISSING_FILE_MESSAGE) {
    return (
      <div className="rd-pdf">
        <div className="banner banner-error rd-error" role="alert">
          <Glyph>{icons.alert}</Glyph>
          <div>
            <p>{error}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rd-pdf">
      <div
        className="rd-pdf-wrap"
        ref={wrap}
        onTouchStart={(event) => {
          if (event.touches.length === 2) pinch.current = { distance: touchDistance(event.touches), zoom };
        }}
        onTouchMove={(event) => {
          if (!pinch.current || event.touches.length !== 2) return;
          const factor = touchDistance(event.touches) / (pinch.current.distance || 1);
          scheduleZoom(clampNumber(pinch.current.zoom * factor, ZOOM_MIN, ZOOM_MAX));
        }}
        onTouchEnd={() => {
          pinch.current = null;
        }}
      >
        <div className="rd-pdf-page" style={{ width: size.w || undefined, height: size.h || undefined }}>
          <canvas
            ref={canvas}
            className="rd-pdf-canvas"
            role="img"
            aria-label={`Page ${painted}${pageCount ? ` of ${pageCount}` : ''}`}
            style={{ width: size.w || undefined, height: size.h || undefined }}
          />
          {scale > 0
            ? rects
                .filter((rect) => rect.page === painted)
                .map((rect, i) => (
                  <div
                    key={`${rect.page}-${i}`}
                    className="rd-pdf-rect"
                    aria-hidden="true"
                    style={{
                      left: `${rect.x * scale}px`,
                      top: `${rect.y * scale}px`,
                      width: `${Math.max(rect.w * scale, 2)}px`,
                      height: `${Math.max(rect.h * scale, 2)}px`,
                    }}
                  />
                ))
            : null}
        </div>
      </div>

      {error ? (
        <div className="banner banner-error rd-error" role="alert">
          <Glyph>{icons.alert}</Glyph>
          <div>
            <p>{error}</p>
          </div>
        </div>
      ) : null}

      <div className="rd-pdf-controls">
        <div className="rd-pdf-nav" role="group" aria-label="Page">
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label="Previous page"
            onClick={() => onPageChange(painted - 1)}
            disabled={painted <= 1}
          >
            <Glyph>{icons.back}</Glyph>
          </button>
          <span className="rd-pdf-count" aria-live="polite">
            {loading ? '…' : `Page ${painted} / ${pageCount || '?'}`}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label="Next page"
            onClick={() => onPageChange(painted + 1)}
            disabled={pageCount > 0 && painted >= pageCount}
          >
            <Glyph>{icons.forward}</Glyph>
          </button>
        </div>
        <div className="rd-pdf-zoom" role="group" aria-label="Zoom">
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label="Zoom out"
            onClick={() => setZoom((value) => clampNumber(value - 0.2, ZOOM_MIN, ZOOM_MAX))}
          >
            <Glyph>{icons.zoomOut}</Glyph>
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label="Zoom in"
            onClick={() => setZoom((value) => clampNumber(value + 0.2, ZOOM_MIN, ZOOM_MAX))}
          >
            <Glyph>{icons.zoomIn}</Glyph>
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label="Fit width"
            title="Fit width"
            aria-pressed={fit === 'width'}
            onClick={() => {
              setFit('width');
              setZoom(1);
            }}
          >
            <Glyph>{icons.fitWidth}</Glyph>
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label="Fit page"
            title="Fit page"
            aria-pressed={fit === 'page'}
            onClick={() => {
              setFit('page');
              setZoom(1);
            }}
          >
            <Glyph>{icons.page}</Glyph>
          </button>
        </div>
      </div>
    </div>
  );
}
