#!/usr/bin/env node
/**
 * Copy pdf.js's image decoders and standard fonts into `public/pdfjs/`.
 *
 * pdf.js 6 decodes JPEG 2000 (OpenJPEG), JBIG2 and ICC colour with wasm modules
 * from `wasmUrl`, draws the 14 standard PDF fonts from `standardFontDataUrl` and
 * converts CMYK with the profile at `iccUrl`. Without them a scanned textbook
 * page — usually one big JPX or JBIG2 image — renders blank in Page view.
 * See `src/import/pdfAssets.ts`.
 *
 * Usage: `node scripts/copy-pdfjs.mjs` (runs before dev and build).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'node_modules', 'pdfjs-dist');

// quickjs runs JavaScript embedded in PDFs; scripting is off, so it is not shipped.
const DIRS = { wasm: (name) => !name.startsWith('quickjs'), standard_fonts: () => true, iccs: () => true };

let copied = 0;
for (const [dir, keep] of Object.entries(DIRS)) {
  const from = join(source, dir);
  const to = join(root, 'public', 'pdfjs', dir);
  if (!existsSync(from)) {
    console.error(`pdfjs-dist/${dir} not found — run pnpm install.`);
    process.exit(1);
  }
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from).filter(keep)) {
    const src = join(from, name);
    const dst = join(to, name);
    if (!existsSync(dst) || statSync(dst).size !== statSync(src).size) {
      copyFileSync(src, dst);
      copied += 1;
    }
  }
}
console.log(`pdfjs assets -> public/pdfjs (${copied} copied)`);
