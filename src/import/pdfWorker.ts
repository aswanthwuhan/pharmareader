/**
 * Entry point for the pdf.js worker.
 *
 * pdf.js starts this file with `new Worker(url, { type: 'module' })`, in a global
 * scope of its own — so the polyfills the app installs for the main thread are
 * not there, and a WebView older than the one pdf.js 6 targets dies as soon as
 * the worker touches the same ES2025 helpers. Hence: polyfills first, then the
 * official legacy build (see `pdfPolyfill.ts` for why it has to be legacy).
 *
 * vite.config.ts builds workers as ES modules (`worker.format: 'es'`), which is
 * what `{ type: 'module' }` requires.
 */
import './pdfPolyfill';
import 'pdfjs-dist/legacy/build/pdf.worker.min.mjs';
