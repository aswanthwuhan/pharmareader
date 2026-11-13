/**
 * Where pdf.js finds its image decoders (JPEG 2000, JBIG2, ICC) and the 14
 * standard fonts — copied into `public/pdfjs/` by scripts/copy-pdfjs.mjs.
 * Without them a scanned page, usually one JPX or JBIG2 image, paints blank.
 * pdf.js requires the trailing slash.
 */
const PDFJS_BASE = `${import.meta.env.BASE_URL}pdfjs/`;

export const PDF_ASSETS = {
  wasmUrl: `${PDFJS_BASE}wasm/`,
  standardFontDataUrl: `${PDFJS_BASE}standard_fonts/`,
  iccUrl: `${PDFJS_BASE}iccs/`,
} as const;
