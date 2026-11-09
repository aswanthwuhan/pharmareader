import { describe, expect, it, vi } from 'vitest';
import { parsePdf } from './pdf';

// The default pdfjs build wants a browser crypto/DOM stack; the legacy build is
// the one pdf.js documents for Node. Production keeps the normal build.
vi.mock('pdfjs-dist', async () => await import('pdfjs-dist/legacy/build/pdf.mjs'));

const ESCAPE: Record<string, string> = { '\\': '\\\\', '(': '\\(', ')': '\\)' };
const escape = (text: string) => text.replace(/[\\()]/g, (match) => ESCAPE[match] ?? match);

/**
 * A minimal but valid PDF: one Helvetica body paragraph per page, plus the
 * running head and page number a journal puts there. Keeps this suite free of
 * fixture binaries.
 */
function makePdf(pages: { body: string[]; head: string; number: number }[]): ArrayBuffer {
  const objects: string[] = [];
  const pageIds = pages.map((_, index) => 4 + index * 2);

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  pages.forEach((page, index) => {
    const pageId = 4 + index * 2;
    const contentId = pageId + 1;
    const lines = [
      `BT /F1 9 Tf 50 770 Td (${escape(page.head)}) Tj ET`,
      `BT /F1 9 Tf 300 30 Td (${escape(String(page.number))}) Tj ET`,
      ...page.body.map((text, row) => `BT /F1 10 Tf 50 ${700 - row * 14} Td (${escape(text)}) Tj ET`),
    ];
    const stream = lines.join('\n');

    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
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
