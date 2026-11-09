#!/usr/bin/env node
/**
 * Copy the onnxruntime-web build that the on-device TTS engines load at runtime
 * into `public/ort/`, so the app never fetches it from a CDN.
 *
 * Why these three files: kokoro-js (via @huggingface/transformers) and
 * pocket-tts-js both use the JSEP build, whose loader `ort.min.mjs` hard-codes
 * the file name `ort-wasm-simd-threaded.jsep.mjs`; that loader then fetches
 * `ort-wasm-simd-threaded.jsep.wasm` from the directory in `wasmPaths` /
 * `ortBaseUrl`. The non-jsep `ort-wasm-simd-threaded.{mjs,wasm}` pair belongs to
 * `ort.wasm.min.mjs`, which neither library imports.
 *
 * Usage: `node scripts/copy-ort.mjs` (wire into prebuild/predev so the copy
 * tracks the installed onnxruntime-web version). Idempotent: same-size files
 * are left alone.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Files the browser needs; the names are fixed by the ORT build. */
export const ORT_FILES = [
  'ort.min.mjs',
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
];

function hasRuntime(dir) {
  return ORT_FILES.every((file) => existsSync(join(dir, file)));
}

/**
 * Locate onnxruntime-web's dist directory. It is a transitive dependency (via
 * kokoro-js -> @huggingface/transformers), so with pnpm it only exists inside
 * the virtual store; npm/yarn hoist it to the top level.
 */
export function resolveOrtDist(root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const candidates = [join(root, 'node_modules', 'onnxruntime-web', 'dist')];
  const store = join(root, 'node_modules', '.pnpm');
  if (existsSync(store)) {
    const packages = readdirSync(store)
      .filter((name) => name.startsWith('onnxruntime-web@'))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const name of packages) {
      candidates.push(join(store, name, 'node_modules', 'onnxruntime-web', 'dist'));
    }
  }
  const found = candidates.find(hasRuntime);
  if (!found) {
    throw new Error(
      `onnxruntime-web dist with ${ORT_FILES.join(', ')} not found under ${root}. ` +
        'Run pnpm install, then node scripts/copy-ort.mjs.'
    );
  }
  return found;
}

/** Copy the runtime into `<root>/public/ort`; returns the target paths written. */
export function copyOrt(root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const source = resolveOrtDist(root);
  const target = join(root, 'public', 'ort');
  mkdirSync(target, { recursive: true });

  const written = [];
  for (const file of ORT_FILES) {
    const from = join(source, file);
    const to = join(target, file);
    const size = statSync(from).size;
    if (!existsSync(to) || statSync(to).size !== size) {
      copyFileSync(from, to);
      written.push({ file, size, copied: true });
    } else {
      written.push({ file, size, copied: false });
    }
  }
  return { source, target, files: written };
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    const { source, target, files } = copyOrt();
    console.log(`onnxruntime-web: ${source}`);
    console.log(`            -> ${target}`);
    for (const { file, size, copied } of files) {
      console.log(`  ${copied ? 'copied ' : 'kept   '} ${file} (${(size / 1024 / 1024).toFixed(1)} MB)`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
