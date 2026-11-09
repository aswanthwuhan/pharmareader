import { describe, expect, it } from 'vitest';
import { ORT_BASE_URL } from './ort';
// @ts-expect-error - plain Node build script; the repo has allowJs off, so no declarations exist.
import * as copyScript from '../../../scripts/copy-ort.mjs';

interface CopyResult {
  source: string;
  target: string;
  files: { file: string; size: number; copied: boolean }[];
}

const { ORT_FILES, copyOrt, resolveOrtDist } = copyScript as unknown as {
  ORT_FILES: string[];
  copyOrt(): CopyResult;
  resolveOrtDist(): string;
};

describe('self-hosted onnxruntime-web', () => {
  it('serves the runtime from the app origin, not a CDN', () => {
    expect(ORT_BASE_URL).toBe('/ort/');
  });

  it('finds the installed onnxruntime-web build and copies the files the engines load', () => {
    expect(resolveOrtDist()).toContain('onnxruntime-web');
    const result = copyOrt();
    expect(result.target).toMatch(/public[\\/]ort$/);
    expect(result.files.map((entry) => entry.file)).toEqual(ORT_FILES);

    const sizes = new Map(result.files.map((entry) => [entry.file, entry.size]));
    // `ort.min.mjs` hard-codes the JSEP loader name, and the 21 MB wasm sits
    // beside it. If either is missing the app silently falls back to the CDN
    // default, so fail loudly here.
    expect(sizes.get('ort.min.mjs') ?? 0).toBeGreaterThan(300_000);
    expect(sizes.get('ort-wasm-simd-threaded.jsep.mjs') ?? 0).toBeGreaterThan(40_000);
    expect(sizes.get('ort-wasm-simd-threaded.jsep.wasm') ?? 0).toBeGreaterThan(10_000_000);
  });
});
