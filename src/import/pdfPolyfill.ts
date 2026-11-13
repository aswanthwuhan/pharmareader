/**
 * The JavaScript pdf.js 6 expects, for the WebView the phone actually ships.
 *
 * The default pdf.js build calls the newest typed-array and promise helpers
 * directly (`Uint8Array.prototype.toHex` and friends), which killed every PDF
 * import on Android System WebView 134 with "a.toHex is not a function". The
 * official `legacy/` build bundles core-js shims for most of them, but not for
 * `Promise.withResolvers`, and a Web Worker has its own global scope, so the
 * main bundle's shims never reach the worker at all.
 *
 * Everything here is feature-detected: a modern engine keeps its native code,
 * and this module is a no-op there. With it loaded first, the oldest runtime
 * pdf.js still works on is Chrome / Android WebView 110 (it also relies on
 * `structuredClone`, `Object.hasOwn` and ES-module workers).
 *
 * `ArrayBuffer.prototype.transferToFixedLength` (Safari 17.4, Chrome 114) is not
 * shimmed by the legacy build either: without it the worker's operator list
 * throws and every PDF page renders blank (iOS 16.4–17.3, WebView 110–113).
 *
 * Import this module before any `pdfjs-dist` import — see `pdf.ts`, the worker
 * entry `pdfWorker.ts`, and `src/reader/PdfView.tsx`.
 */

const typedArray = Uint8Array as unknown as {
  prototype: Record<string, unknown>;
  fromHex?: unknown;
};

/** Install `value` only where the engine does not already provide it. */
function define(target: object, name: string, value: unknown): void {
  const holder = target as Record<string, unknown>;
  if (typeof holder[name] === 'function') return;
  Object.defineProperty(holder, name, { value, writable: true, configurable: true, enumerable: false });
}

function toHex(this: Uint8Array): string {
  let out = '';
  for (const byte of this) out += byte.toString(16).padStart(2, '0');
  return out;
}

function fromHex(this: unknown, hex: string): Uint8Array {
  const text = String(hex);
  if (text.length % 2 !== 0 || /[^0-9a-fA-F]/.test(text)) {
    throw new SyntaxError('Invalid hex string');
  }
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toBase64(this: Uint8Array): string {
  // Spread in 32K chunks: a whole PDF page of bytes on the stack overflows.
  let binary = '';
  for (let i = 0; i < this.length; i += 0x8000) {
    binary += String.fromCharCode(...this.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(this: unknown, base64: string): Uint8Array {
  const binary = atob(String(base64));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Neumaier summation: the spec's `Math.sumPrecise`, to the last bit that matters. */
function sumPrecise(this: Math, values: Iterable<number>): number {
  let sum = 0;
  let compensation = 0;
  for (const value of values) {
    if (typeof value !== 'number') throw new TypeError('Math.sumPrecise: not a number');
    const next = sum + value;
    compensation += Math.abs(sum) >= Math.abs(value) ? sum - next + value : value - next + sum;
    sum = next;
  }
  return compensation && Number.isFinite(compensation) ? sum + compensation : sum;
}

function getOrInsert<K, V>(this: Map<K, V>, key: K, value: V): V {
  const existing = this.get(key);
  if (existing !== undefined || this.has(key)) return existing as V;
  this.set(key, value);
  return value;
}

function getOrInsertComputed<K, V>(this: Map<K, V>, key: K, compute: (key: K) => V): V {
  const existing = this.get(key);
  if (existing !== undefined || this.has(key)) return existing as V;
  const value = compute(key);
  this.set(key, value);
  return value;
}

function withResolvers<T>(this: unknown): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Copying stand-in for `transfer`: the source is not detached, which callers never rely on. */
function transfer(this: ArrayBuffer, newLength: number = this.byteLength): ArrayBuffer {
  const out = new ArrayBuffer(newLength);
  new Uint8Array(out).set(new Uint8Array(this, 0, Math.min(newLength, this.byteLength)));
  return out;
}

define(ArrayBuffer.prototype, 'transfer', transfer);
define(ArrayBuffer.prototype, 'transferToFixedLength', transfer);
define(typedArray.prototype, 'toHex', toHex);
define(typedArray.prototype, 'toBase64', toBase64);
define(typedArray, 'fromHex', fromHex);
define(typedArray, 'fromBase64', fromBase64);
define(Math, 'sumPrecise', sumPrecise);
define(Map.prototype, 'getOrInsert', getOrInsert);
define(Map.prototype, 'getOrInsertComputed', getOrInsertComputed);
define(Promise, 'withResolvers', withResolvers);

export {};
