import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LayoutBox } from './layout/engine';
import { parsePdf } from './pdf';

// A model that is "installed": the real one needs a browser, a worker and 32 MB.
const detector = vi.hoisted(() => ({ detect: vi.fn(), dispose: vi.fn() }));
vi.mock('./layout/detector', () => ({ createLayoutDetector: async () => detector }));

const HERE = dirname(fileURLToPath(import.meta.url));
const NMC_PDF = resolve(HERE, '__fixtures__/nmc-md-pharmacology.pdf');

function read(path: string): ArrayBuffer {
  const bytes = readFileSync(path);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** The regions PP-DocLayout-L returned for page 12 of the fixture, in page points. */
function recordedPage12(width: number, height: number): LayoutBox[] {
  const file = resolve(HERE, 'layout/__fixtures__/nmc-p12.json');
  const { boxes } = JSON.parse(readFileSync(file, 'utf8')) as { boxes: LayoutBox[] };
  return boxes.map((box) => ({ ...box, x: box.x * width, y: box.y * height, w: box.w * width, h: box.h * height }));
}

beforeEach(() => {
  detector.detect.mockReset();
  detector.dispose.mockReset();
});

describe('parsePdf with the layout model installed', () => {
  it('frees the model when a page fails, and does not claim the model read the book', { timeout: 120_000 }, async () => {
    detector.detect.mockRejectedValue(new Error('out of memory'));
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const parsed = await parsePdf(read(NMC_PDF), 'nmc');
    quiet.mockRestore();

    // The loaded model holds ~200 MB of WASM memory in a worker: dropping the
    // handle without disposing it leaks that for the life of the page.
    expect(detector.detect).toHaveBeenCalledTimes(1);
    expect(detector.dispose).toHaveBeenCalledTimes(1);
    expect(parsed.layout).toBe('heuristic');
    expect(parsed.modelPages).toBe(0);
  });

  it('turns the regions of a table page into one table block of the saved document', { timeout: 120_000 }, async () => {
    let page = 1;
    detector.detect.mockImplementation(async (_pixels: unknown, width: number, height: number) =>
      page === 12 ? recordedPage12(width, height) : [],
    );

    const parsed = await parsePdf(read(NMC_PDF), 'nmc', (done) => {
      page = done + 1;
    });

    expect(parsed.layout).toBe('model');
    expect(parsed.modelPages).toBe(1);
    expect(detector.dispose).toHaveBeenCalledTimes(1);

    const blocks = parsed.doc.chapters.flatMap((chapter) => chapter.blocks);
    const tables = blocks.filter((block) => block.kind === 'table');
    expect(tables).toHaveLength(1);
    const cells = tables[0].sentences.map((sentence) => sentence.text).join(' ');
    expect(cells).toMatch(/Journal based \/ recent/);
    expect(cells).toContain('7. Log Book Maintenance');
    // Page view highlights by these rects, so they must sit on the page the table is on.
    expect(tables[0].sentences.every((sentence) => sentence.pdfRects?.every((rect) => rect.page === 12))).toBe(true);

    // Sentence ids stay unique and positional after the model's blocks are merged in.
    const ids = blocks.flatMap((block) => block.sentences.map((sentence) => sentence.id));
    expect(new Set(ids).size).toBe(ids.length);

    // The form's title and the "Name of the PG Student" lines sit above the table
    // and the model drew no box around them: they are still read where they are
    // printed, not after everything the model did find.
    const order = blocks.map((block) => block.sentences.map((sentence) => sentence.text).join(' '));
    const table = blocks.indexOf(tables[0]);
    const title = order.findIndex((text) => text.startsWith('Postgraduate Students Appraisal Form'));
    const student = order.findIndex((text) => text.startsWith('Name of the PG Student'));
    const signature = order.findIndex((text) => text.includes('SIGNATURE OF CONSULTANT'));
    expect(title).toBeGreaterThanOrEqual(0);
    expect(title).toBeLessThan(student);
    expect(student).toBeLessThan(table);
    expect(table).toBeLessThan(signature);
  });
});
