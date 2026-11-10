import { describe, expect, it, vi } from 'vitest';
import { makePdf } from './__fixtures__/makePdf';

/**
 * The release gate, as a test.
 *
 * On the factory Android System WebView 134 (Chrome 134) importing any PDF died
 * with "a.toHex is not a function": pdf.js 6 calls ES2025 helpers that engine
 * does not have. This deletes the same helpers before pdf.js loads, so the test
 * fails exactly the way the phone did unless the shipped path — the official
 * legacy build plus `pdfPolyfill.ts` — provides them.
 */

const ES2025_HELPERS: [object, string][] = [
  [Uint8Array.prototype, 'toHex'],
  [Uint8Array.prototype, 'toBase64'],
  [Uint8Array, 'fromHex'],
  [Uint8Array, 'fromBase64'],
  [Math, 'sumPrecise'],
  [Map.prototype, 'getOrInsert'],
  [Map.prototype, 'getOrInsertComputed'],
  [Promise, 'withResolvers'],
];

describe('parsePdf on an engine older than pdf.js 6 targets', () => {
  it('still parses when the ES2025 helpers are missing', { timeout: 120_000 }, async () => {
    const saved = ES2025_HELPERS.map(([target, name]) => {
      const descriptor = Object.getOwnPropertyDescriptor(target, name);
      delete (target as Record<string, unknown>)[name];
      return { target, name, descriptor };
    });

    try {
      // A fresh module graph: a module evaluated earlier in the suite must not
      // be what saves the day.
      vi.resetModules();
      const { parsePdf } = await import('./pdf');

      const data = makePdf([
        {
          head: 'British Journal of Pharmacology',
          number: 1,
          body: [
            'Thiazides act on the distal convoluted tubule.',
            'They lower blood pressure by increasing sodium loss.',
          ],
        },
      ]);

      const parsed = await parsePdf(data, 'old engine');

      expect(parsed.pageCount).toBe(1);
      const text = parsed.doc.chapters
        .flatMap((chapter) => chapter.blocks.flatMap((block) => block.sentences.map((sentence) => sentence.text)))
        .join(' ');
      expect(text).toContain('Thiazides act on the distal convoluted tubule.');
      expect(parsed.charsPerPage).toBeGreaterThan(50);
    } finally {
      for (const { target, name, descriptor } of saved) {
        if (descriptor) Object.defineProperty(target, name, descriptor);
        else delete (target as Record<string, unknown>)[name];
      }
      vi.resetModules();
    }
  });
});
