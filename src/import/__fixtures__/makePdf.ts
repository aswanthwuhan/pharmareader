/**
 * Builds the tiny generated PDFs the PDF tests parse.
 *
 * Lives beside the binary fixtures because it is test material: nothing in the
 * app imports it. `pdf.test.ts` and `pdfOldEngine.test.ts` share it so both run
 * against exactly the same document.
 */

const ESCAPE: Record<string, string> = { '\\': '\\\\', '(': '\\(', ')': '\\)' };
const escape = (text: string) => text.replace(/[\\()]/g, (match) => ESCAPE[match] ?? match);

export interface GeneratedPage {
  body: string[];
  head: string;
  number: number;
}

/**
 * A minimal but valid PDF: one Helvetica body paragraph per page, plus the
 * running head and page number a journal puts there.
 */
export function makePdf(pages: GeneratedPage[]): ArrayBuffer {
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
