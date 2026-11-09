/**
 * The two engines load ORT differently but from the same copied build:
 *   - pocket-tts-js imports `${base}ort.min.mjs` (the "extern-wasm" build), which
 *     then loads `ort-wasm-simd-threaded.jsep.mjs` next to itself;
 *   - kokoro-js (transformers.js) resolves `ort-wasm-simd-threaded.jsep.mjs` from
 *     `env.wasmPaths` directly.
 *
 * So `public/ort` must contain exactly this trio, and the JS glue must still name
 * the binary we ship. An `onnxruntime-web` upgrade that renames the loader breaks
 * both engines at load time with "no available backend found" — this test catches
 * that at `pnpm test` instead of on a phone.
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ortDir = resolve(process.cwd(), 'public/ort');

function size(name: string): number {
  return statSync(resolve(ortDir, name)).size;
}

describe('public/ort (the on-device WASM runtime both engines share)', () => {
  it('ships the entry module, the jsep loader and its binary', () => {
    expect(size('ort.min.mjs')).toBeGreaterThan(200_000);
    expect(size('ort-wasm-simd-threaded.jsep.mjs')).toBeGreaterThan(10_000);
    // ~21 MB: the WASM itself. A placeholder here would "download" instantly and
    // only fail later, inside the worker, as "no available backend found".
    expect(size('ort-wasm-simd-threaded.jsep.wasm')).toBeGreaterThan(10_000_000);
  });

  it('has a loader name the entry module actually asks for', () => {
    const entry = readFileSync(resolve(ortDir, 'ort.min.mjs'), 'utf8');
    expect(entry).toContain('ort-wasm-simd-threaded.jsep.mjs');

    const loader = readFileSync(resolve(ortDir, 'ort-wasm-simd-threaded.jsep.mjs'), 'utf8');
    expect(loader).toContain('ort-wasm-simd-threaded.jsep.wasm');
  });
});
