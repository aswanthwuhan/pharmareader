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
import { useEffect, useRef, useState } from 'react';
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PdfRect } from '../core/types';

GlobalWorkerOptions.workerSrc ||= workerUrl;

interface Props {
  /** Identity of the document: reload only when the book changes. */
  docKey: string;
  file: Blob;
  page: number;
  /** Rectangles of the current sentence, on any page. */
  rects: PdfRect[];
  onPageChange(page: number): void;
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

export default function PdfView({ docKey, file, page, rects, onPageChange }: Props) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(0);
  const [scale, setScale] = useState(1);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderTask = useRef<{ cancel(): void; promise: Promise<void> } | null>(null);
  const fileRef = useRef(file);
  fileRef.current = file;
  const pinch = useRef<{ distance: number; zoom: number } | null>(null);

  // Load the document once; the pages are rendered on demand below.
  useEffect(() => {
    let alive = true;
    let loadingTask: ReturnType<typeof getDocument> | null = null;
    setDoc(null);
    setLoading(true);
    setError(null);
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
      void loadingTask?.destroy();
    };
  }, [docKey]);

  // Fit to the available width; a rotation or a side panel changes it too.
  useEffect(() => {
    const element = wrap.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

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
            // the cancelled task always rejects
          }
          if (cancelled) return;
        }

        const base = pdfPage.getViewport({ scale: 1 });
        const fit = width / base.width;
        const viewport = pdfPage.getViewport({ scale: fit * zoom });
        const ratio = Math.min(window.devicePixelRatio || 1, 2);

        renderTask.current?.cancel();
        element.width = Math.floor(viewport.width * ratio);        element.height = Math.floor(viewport.height * ratio);
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
        setScale(viewport.scale);
        setSize({ w: viewport.width, h: viewport.height });
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
  }, [doc, page, zoom, width]);

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
          setZoom(clampNumber(pinch.current.zoom * factor, ZOOM_MIN, ZOOM_MAX));
        }}
        onTouchEnd={() => {
          pinch.current = null;
        }}
      >
        <div className="rd-pdf-page" style={{ width: size.w || undefined, height: size.h || undefined }}>
          <canvas ref={canvas} className="rd-pdf-canvas" style={{ width: size.w || undefined, height: size.h || undefined }} />
          {rects
            .filter((rect) => rect.page === page)
            .map((rect, i) => (
              <div
                key={`${rect.page}-${i}`}
                className="rd-pdf-rect"
                style={{
                  left: `${rect.x * scale}px`,
                  top: `${rect.y * scale}px`,
                  width: `${Math.max(rect.w * scale, 2)}px`,
                  height: `${Math.max(rect.h * scale, 2)}px`,
                }}
              />
            ))}
        </div>
      </div>

      {error ? (
        <p className="rd-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="rd-pdf-controls">
        <button type="button" className="rd-btn" onClick={() => onPageChange(page - 1)} disabled={page <= 1}>
          <span aria-hidden="true">‹</span> Prev
        </button>
        <span className="rd-pdf-count" aria-live="polite">
          {loading ? '…' : `Page ${page} / ${pageCount || '?'}`}
        </span>
        <button
          type="button"
          className="rd-btn"
          onClick={() => onPageChange(page + 1)}
          disabled={pageCount > 0 && page >= pageCount}
        >
          Next <span aria-hidden="true">›</span>
        </button>
        <button
          type="button"
          className="rd-btn"
          aria-label="Zoom out"
          onClick={() => setZoom((value) => clampNumber(value - 0.2, ZOOM_MIN, ZOOM_MAX))}
        >
          A−
        </button>
        <button
          type="button"
          className="rd-btn"
          aria-label="Zoom in"
          onClick={() => setZoom((value) => clampNumber(value + 0.2, ZOOM_MIN, ZOOM_MAX))}
        >
          A+
        </button>
        <button type="button" className="rd-btn" onClick={() => setZoom(1)}>
          Fit width
        </button>
      </div>
    </div>
  );
}
