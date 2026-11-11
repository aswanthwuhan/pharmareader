import { describe, expect, it } from 'vitest';
import { makePdf } from './__fixtures__/makePdf';
import { parsePdf } from './pdf';

const SAMPLE = {
  head: 'British Journal of Pharmacology',
  body: [
    'Thiazides act on the distal convoluted tubule.',
    'They lower blood pressure by increasing sodium loss.',
    'A dose of 12.5 mg once daily is usual.',
    'Hydrochlorothiazide and indapamide are examples.',
  ],
};

describe('parsePdf', () => {
  it('extracts the body text and drops the running head and page number', { timeout: 60_000 }, async () => {
    const data = makePdf([
      { ...SAMPLE, number: 1 },
      { ...SAMPLE, number: 2 },
    ]);

    const parsed = await parsePdf(data, 'fallback title');

    expect(parsed.pageCount).toBe(2);
    const text = parsed.doc.chapters
      .flatMap((chapter) => chapter.blocks.flatMap((block) => block.sentences.map((sentence) => sentence.text)))
      .join(' ');

    expect(text).toContain('Thiazides act on the distal convoluted tubule.');
    expect(text).toContain('12.5 mg once daily');
    expect(text).not.toContain('British Journal of Pharmacology');
    expect(parsed.doc.chapters.length).toBeGreaterThan(0);
  });

  it('reports progress once per page', { timeout: 60_000 }, async () => {
    const data = makePdf([1, 2, 3].map((number) => ({ ...SAMPLE, number })));
    const seen: [number, number][] = [];

    await parsePdf(data, 'progress', (done, total) => seen.push([done, total]));

    expect(seen).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it('uses the document title from the metadata when there is one', { timeout: 60_000 }, async () => {
    const parsed = await parsePdf(makePdf([{ ...SAMPLE, number: 1 }]), 'renal-handout');

    expect(parsed.doc.format).toBe('pdf');
    expect(parsed.doc.title).toBeTruthy();
    expect(parsed.charsPerPage).toBeGreaterThan(50);
  });
});

/** A run of text placed at a PDF-space baseline point. */
interface Run {
  x: number;
  y: number;
  text: string;
}

/** One page of a generated two-column document. */
interface ColumnPage {
  runs: Run[];
  /** A shaded box, in PDF space (y grows up). */
  box?: { x: number; y: number; w: number; h: number };
}

const ESCAPE: Record<string, string> = { '\\': '\\\\', '(': '\\(', ')': '\\)' };
const escape = (text: string) => text.replace(/[\\()]/g, (match) => ESCAPE[match] ?? match);

/**
 * A page of two short columns, optionally with a filled box across both. The
 * operations are the ones a real page uses for a shaded sidebar (`re f`), so
 * the panel reading is exercised against pdf.js itself.
 */
function makeColumnPdf(pages: ColumnPage[]): ArrayBuffer {
  const objects: string[] = [];
  const pageIds = pages.map((_, index) => 4 + index * 2);

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  pages.forEach((page, index) => {
    const pageId = 4 + index * 2;
    const lines: string[] = [];
    if (page.box) {
      lines.push(`0.92 g ${page.box.x} ${page.box.y} ${page.box.w} ${page.box.h} re f 0 g`);
    }
    for (const run of page.runs) {
      lines.push(`BT /F1 10 Tf ${run.x} ${run.y} Td (${escape(run.text)}) Tj ET`);
    }
    const stream = lines.join('\n');

    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = pdf.length;
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }

  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) {
    pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  const bytes = new TextEncoder().encode(pdf);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Page space to PDF space: y grows up. */
const pdfY = (pageY: number) => 792 - pageY;

/**
 * Sixteen rows of two columns with a shaded panel across the middle six. The
 * panel's rows carry short text, as a sidebar with its own inner columns does.
 */
function panelledPage(): ColumnPage {
  const runs: Run[] = [];
  for (let row = 0; row < 16; row++) {
    const inside = row >= 5 && row <= 10;
    const y = pdfY(100 + row * 40);
    runs.push({
      x: inside ? 80 : 50,
      y,
      text: inside ? `Row ${row} left.` : `Row ${row} left, with words to fill the measure.`,
    });
    runs.push({ x: 380, y, text: `Row ${row} right, with words.` });
  }

  // Page y 290..510, so it holds rows 5..10.
  return { runs, box: { x: 60, y: pdfY(510), w: 490, h: 220 } };
}

function textOf(parsed: Awaited<ReturnType<typeof parsePdf>>): string {
  return parsed.doc.chapters
    .flatMap((chapter) => chapter.blocks.flatMap((block) => block.sentences.map((sentence) => sentence.text)))
    .join(' ');
}

describe('parsePdf with two columns', () => {
  it('reads a shaded panel in bands of its own', { timeout: 60_000 }, async () => {
    const text = textOf(await parsePdf(makeColumnPdf([panelledPage()]), 'panel'));

    // Above the panel: the whole left column, then the whole right one.
    expect(text.indexOf('Row 4 left')).toBeLessThan(text.indexOf('Row 0 right'));
    expect(text.indexOf('Row 4 right')).toBeLessThan(text.indexOf('Row 5 left'));
    // Inside it, the panel's own columns; then the bands below.
    expect(text.indexOf('Row 10 right')).toBeLessThan(text.indexOf('Row 11 left'));
    expect(text).toContain('Row 9 left.');
  });

  it('leaves a two-column page in row order when the caller says one column', { timeout: 60_000 }, async () => {
    const text = textOf(await parsePdf(makeColumnPdf([panelledPage()]), 'panel', undefined, { columns: 1 }));

    // Every row is one line: its right half follows its left half immediately.
    expect(text.indexOf('Row 0 right')).toBeLessThan(text.indexOf('Row 1 left'));
    expect(text.indexOf('Row 5 right')).toBeLessThan(text.indexOf('Row 6 left'));
  });

  it('splits a page in the middle when the caller says two columns', { timeout: 60_000 }, async () => {
    // Six rows: too few to show a corridor, so only the caller can say it is two.
    const page = (): ColumnPage => {
      const runs: Run[] = [];
      for (let row = 0; row < 6; row++) {
        const y = pdfY(100 + row * 30);
        runs.push({ x: 50, y, text: `Row ${row} left.` }, { x: 400, y, text: `Row ${row} right.` });
      }
      return { runs };
    };

    // pdf.js detaches the buffer it reads, so each parse gets its own document.
    const auto = textOf(await parsePdf(makeColumnPdf([page()]), 'auto'));
    expect(auto.indexOf('Row 0 right')).toBeLessThan(auto.indexOf('Row 1 left'));

    const two = textOf(await parsePdf(makeColumnPdf([page()]), 'two', undefined, { columns: 2 }));
    expect(two.indexOf('Row 5 left')).toBeLessThan(two.indexOf('Row 0 right'));
  });

  it('reads a page with too few rows down the gutter of the other pages', { timeout: 60_000 }, async () => {
    const open = (name: string): ColumnPage => {
      const runs: Run[] = [];
      for (let row = 0; row < 16; row++) {
        const y = pdfY(100 + row * 40);
        runs.push({ x: 50, y, text: `${name} ${row} left, with words to fill the measure.` });
        runs.push({ x: 380, y, text: `${name} ${row} right, with words.` });
      }
      return { runs };
    };
    // Ten rows do not show a corridor of their own (detectGutter wants twelve).
    const short = (): ColumnPage => {
      const runs: Run[] = [];
      for (let row = 0; row < 10; row++) {
        const y = pdfY(100 + row * 14);
        runs.push({ x: 50, y, text: `Fourth ${row} left, with words to fill the measure.` });
        runs.push({ x: 380, y, text: `Fourth ${row} right, with words.` });
      }
      return { runs };
    };

    const text = textOf(await parsePdf(makeColumnPdf([open('First'), open('Second'), open('Third'), short()]), 'book'));

    // The document's gutter makes page four read like the others.
    expect(text.indexOf('Fourth 9 left')).toBeLessThan(text.indexOf('Fourth 0 right'));
  });
});
