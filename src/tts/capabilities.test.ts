// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WASM_SIMD_PROBE,
  neuralUnsupportedHint,
  supportsLookbehind,
  supportsNeuralVoices,
  supportsWasmSimd,
} from './capabilities';

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 15_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.4 Mobile/15E148 Safari/604.1';

/** Own properties to delete again, so the jsdom prototype getters come back. */
let shadowed: string[] = [];

function shadow(key: string, value: unknown): void {
  Object.defineProperty(navigator, key, { configurable: true, value });
  shadowed.push(key);
}

afterEach(() => {
  for (const key of shadowed) delete (navigator as unknown as Record<string, unknown>)[key];
  shadowed = [];
  vi.unstubAllGlobals();
});

describe('the neural-voice capability check', () => {
  it('proves the SIMD probe is a real SIMD module', () => {
    // The whole check rests on this byte sequence: it must validate only where
    // SIMD is compiled in. Node has SIMD, so a broken probe would fail here.
    expect(WebAssembly.validate(WASM_SIMD_PROBE)).toBe(true);
  });

  it('accepts a browser with lookbehind and SIMD', () => {
    expect(supportsLookbehind()).toBe(true);
    expect(supportsWasmSimd()).toBe(true);
    expect(supportsNeuralVoices()).toBe(true);
  });

  it('rejects a browser without lookbehind', () => {
    const RealRegExp = RegExp;
    vi.stubGlobal(
      'RegExp',
      class extends RealRegExp {
        constructor(pattern: string | RegExp, flags?: string) {
          if (typeof pattern === 'string' && pattern.includes('(?<=')) {
            throw new SyntaxError('Invalid regular expression: invalid group specifier name');
          }
          super(pattern, flags);
        }
      }
    );
    expect(supportsLookbehind()).toBe(false);
    expect(supportsNeuralVoices()).toBe(false);
  });

  it('rejects a browser whose WebAssembly does not support SIMD', () => {
    // Safari 15.4–16.3 validate a module built for plain wasm but not this one.
    vi.stubGlobal('WebAssembly', { validate: () => false });
    expect(supportsWasmSimd()).toBe(false);
    expect(supportsNeuralVoices()).toBe(false);
  });

  it('says iOS 16.4 on iPhone and something browser-neutral elsewhere', () => {
    shadow('userAgent', IPHONE_UA);
    expect(neuralUnsupportedHint()).toBe(
      "Needs iOS 16.4 or newer — your phone's built-in voice still works."
    );
    shadow('userAgent', 'Mozilla/5.0 (Linux; Android 10) Chrome/90.0.0.0 Mobile');
    expect(neuralUnsupportedHint()).toBe(
      'This browser cannot run the on-device voices — its built-in voice still works.'
    );
  });
});
