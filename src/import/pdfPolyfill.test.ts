import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The helpers pdf.js 6 calls that Android System WebView 134 does not have.
 * The release gate hit the first one ("a.toHex is not a function") on every PDF
 * import, so each of these is deleted before the polyfills are loaded.
 */
const HELPERS: [object, string][] = [
  [Uint8Array.prototype, 'toHex'],
  [Uint8Array.prototype, 'toBase64'],
  [Uint8Array, 'fromHex'],
  [Uint8Array, 'fromBase64'],
  [Math, 'sumPrecise'],
  [Map.prototype, 'getOrInsert'],
  [Map.prototype, 'getOrInsertComputed'],
  [Promise, 'withResolvers'],
];

interface Saved {
  target: object;
  name: string;
  descriptor?: PropertyDescriptor;
}

let saved: Saved[] = [];

function removeHelpers(): void {
  saved = HELPERS.map(([target, name]) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    delete (target as Record<string, unknown>)[name];
    return { target, name, descriptor };
  });
}

function restoreHelpers(): void {
  for (const { target, name, descriptor } of saved) {
    if (descriptor) Object.defineProperty(target, name, descriptor);
    else delete (target as Record<string, unknown>)[name];
  }
  saved = [];
}

const typedArrayProto = Uint8Array.prototype as unknown as {
  toHex?: (this: Uint8Array) => string;
  toBase64?: (this: Uint8Array) => string;
};
const typedArrayCtor = Uint8Array as unknown as {
  fromHex?: (hex: string) => Uint8Array;
  fromBase64?: (base64: string) => Uint8Array;
};
const math = Math as unknown as { sumPrecise?: (this: Math, values: Iterable<number>) => number };
const mapProto = Map.prototype as unknown as {
  getOrInsert?: (this: Map<string, number>, key: string, value: number) => number;
  getOrInsertComputed?: (
    this: Map<string, number>,
    key: string,
    compute: (key: string) => number,
  ) => number;
};
const promiseCtor = Promise as unknown as {
  withResolvers?: <T>() => {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: unknown) => void;
  };
};

beforeEach(removeHelpers);
afterEach(() => {
  // Put the engine's own helpers back: the polyfill's versions must never leak
  // into the rest of the suite.
  restoreHelpers();
  vi.resetModules();
});

describe('pdfPolyfill', () => {
  it('installs the ES2025 helpers pdf.js calls, on an engine that lacks them', async () => {
    vi.resetModules();
    await import('./pdfPolyfill');

    expect(typedArrayProto.toHex?.call(new Uint8Array([0x01, 0x02, 0xff]))).toBe('0102ff');
    expect(typedArrayProto.toBase64?.call(new TextEncoder().encode('hello'))).toBe('aGVsbG8=');
    expect(Array.from(typedArrayCtor.fromHex?.('cafed00d') ?? [])).toEqual([0xca, 0xfe, 0xd0, 0x0d]);
    expect(new TextDecoder().decode(typedArrayCtor.fromBase64?.('aGVsbG8=') ?? new Uint8Array())).toBe('hello');

    // The classic precision case: naive summation returns 0 here.
    expect(math.sumPrecise?.call(Math, [1e100, 1, -1e100])).toBe(1);
    expect(math.sumPrecise?.call(Math, [0.1, 0.2, 0.3])).toBeCloseTo(0.6, 15);

    const store = new Map<string, number>();
    expect(mapProto.getOrInsert?.call(store, 'a', 1)).toBe(1);
    expect(mapProto.getOrInsert?.call(store, 'a', 2)).toBe(1);

    const computed = new Map<string, number>();
    const compute = vi.fn((key: string) => key.length);
    expect(mapProto.getOrInsertComputed?.call(computed, 'abc', compute)).toBe(3);
    expect(mapProto.getOrInsertComputed?.call(computed, 'abc', compute)).toBe(3);
    expect(compute).toHaveBeenCalledTimes(1);

    const deferred = promiseCtor.withResolvers?.<number>();
    expect(deferred).toBeDefined();
    deferred?.resolve(7);
    await expect(deferred?.promise).resolves.toBe(7);
  });

  it('rejects malformed hex instead of returning garbage', async () => {
    vi.resetModules();
    await import('./pdfPolyfill');

    expect(() => typedArrayCtor.fromHex?.('abc')).toThrow(SyntaxError);
    expect(() => typedArrayCtor.fromHex?.('zz')).toThrow(SyntaxError);
  });

  it('leaves an implementation the engine already has alone', async () => {
    const native = () => 'native';
    Object.defineProperty(Uint8Array.prototype, 'toHex', {
      value: native,
      configurable: true,
      writable: true,
    });

    vi.resetModules();
    await import('./pdfPolyfill');

    expect(typedArrayProto.toHex).toBe(native);
  });
});
