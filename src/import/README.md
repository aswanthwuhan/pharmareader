# PDF rendering: what the app needs from the WebView

The reader renders PDFs with `pdfjs-dist`. Two things in this folder keep that
working on the Android System WebView that actually ships on phones:

## 1. The legacy build (`pdfPolyfill.ts`, `pdfWorker.ts`)

`pdfjs-dist` 6.x is compiled for ES2025. Its worker calls
`Uint8Array.prototype.toHex` on the very first page, which only exists from
Chrome/WebView 137 — on WebView 134 (this tablet's factory image, and the release
gate's device) importing any PDF failed with `a.toHex is not a function`.

So every pdf.js import points at the **legacy** build:

```ts
import { getDocument, GlobalWorkerOptions, Util } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from './pdfWorker?worker&url'; // pdfWorker.ts -> polyfill + legacy worker
```

The legacy build brings its own core-js shims for `toHex`/`fromHex`/`toBase64`/
`fromBase64`, `Math.sumPrecise`, `Map.prototype.getOrInsert*`, `Promise.try` and
the `Set` proposal methods. One gap is left: it calls `Promise.withResolvers()`
(Chrome 119+) plainly, at `PDFDocumentLoadingTask` construction — so the legacy
build alone still crashes on WebView 134. `pdfPolyfill.ts` is the side-effect
module that fills exactly these holes (feature-detected, never overwrites a
native implementation), and it is imported first by both the main thread
(`pdf.ts`, `PdfView.tsx`) and the worker (`pdfWorker.ts`).

**Minimum supported WebView: 110** (`Array.prototype.toSpliced`, used by the
legacy worker, lands in Chrome 110). Anything older has not been tested and the
PDF page view is not expected to render there; the parsed text view still works.

Tests: `src/import/pdfPolyfill.test.ts` (the shims themselves) and
`src/import/pdfOldEngine.test.ts` (deletes those helpers, then parses a PDF
through `pdf.ts` — it fails with the same `TypeError` the gate saw if the
polyfill stops loading).

## 2. Not shipped: the wasm decoders

pdf.js 6 decodes JPEG2000/JBIG2 images with
`pdfjs-dist/wasm/{openjpeg,jbig2,qcms}.wasm` (~420 KB). `copy-ort`/`vite build`
do not copy them, so the console logs
`#getWasmInstance: UnknownErrorException: … wasmUrl …` for PDFs that contain
those image types. Text and normal images render; scanned-image PDFs whose pages
are JPEG2000/JBIG2 may come out blank. Shipping the three files and setting
`getDocument({ wasmUrl })` is the follow-up.

## 3. Stored bytes

`importFileDetailed` stores an owned `Blob` copy (`ownedCopy`), never the
`File` handed out by the picker: the picker keeps only a handle to the
provider's document, so after a reinstall/relaunch the `File` reads back empty
("The PDF file is empty, size zero bytes"). A book whose blob is still empty
from an older build is reported with `MISSING_FILE_MESSAGE` on the page view and
can be re-imported; `reanalyseBook` refuses for the same reason.
