/**
 * Can this browser actually run the downloaded voices?
 *
 * Both on-device engines are ONNX Runtime WebAssembly builds compiled for SIMD,
 * and kokoro-js builds a lookbehind regex while it loads. Safari gained both in
 * 16.4, so on iOS 15.4–16.3 the models download fine and then fail at run time —
 * the app asks before offering them instead.
 */
import { isIos } from '../core/platform';

/**
 * The smallest SIMD module that validates only where SIMD exists: one exported
 * memory and a `v128.splat` (0xfd 0x0f) + `i16x8.splat` (0xfd 0x62).
 */
export const WASM_SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0,
  65, 0, 253, 15, 253, 98, 11,
]);

/** Safari only parses lookbehind from 16.4; kokoro-js needs it to load. */
export function supportsLookbehind(): boolean {
  try {
    new RegExp('(?<=a)b');
    return true;
  } catch {
    return false;
  }
}

/** ONNX Runtime Web's WASM build is SIMD-only (Safari 16.4). */
export function supportsWasmSimd(): boolean {
  try {
    return typeof WebAssembly !== 'undefined' && WebAssembly.validate(WASM_SIMD_PROBE);
  } catch {
    return false;
  }
}

/** True when Kokoro, Pocket and the Whisper aligner can run here. */
export function supportsNeuralVoices(): boolean {
  return supportsLookbehind() && supportsWasmSimd();
}

/** One plain line, for wherever the downloadable voices are offered. */
export function neuralUnsupportedHint(): string {
  return isIos()
    ? "Needs iOS 16.4 or newer — your phone's built-in voice still works."
    : 'This browser cannot run the on-device voices — its built-in voice still works.';
}
