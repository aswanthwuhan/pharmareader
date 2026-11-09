import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { Chapter, ParsedDoc } from '../core/types';
import { parseDocx } from './docx';
import { parseEpub } from './epub';
import { parsePdf, type PdfParseResult } from './pdf';

// The default pdfjs build needs a browser crypto/DOM stack; the legacy build is
// the one pdf.js documents for Node. Production keeps using the normal build.
vi.mock('pdfjs-dist', async () => await import('pdfjs-dist/legacy/build/pdf.mjs'));

/**
 * Real-file checks. Fixtures are genuine files (Gutenberg EPUB, Word-produced
 * DOCX, an open-access two-column journal PDF). The 2 MB PDF stays out of the
 * repo, so those cases skip when it is absent — CI without samples still passes.
 *
 * Set IMPORT_DUMP_DIR to write the extracted text to JSON for eyeballing.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '__fixtures__');
const SAMPLES = resolve(HERE, '../../.tmp/review-import/samples');

const fixture = (name: string) => resolve(FIXTURES, name);
const sample = (name: string) => resolve(SAMPLES, name);

const REAL_PDF = sample('bjp-bee-venom.pdf'); // 15 pp, two columns, CC BY (PMC6240132)
const SINGLE_COLUMN_PDF = sample('piezo1-pharmacology.pdf'); // 34 pp, one column (PMC7618196)
const NMC_PDF = fixture('nmc-md-pharmacology.pdf'); // 12 pp, one column, 12 pt on a 20.6 pt step

function read(path: string): ArrayBuffer {
  const bytes = readFileSync(path);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function allSentences(doc: ParsedDoc): string[] {
  return doc.chapters.flatMap((chapter) =>
    chapter.blocks.flatMap((block) => block.sentences.map((sentence) => sentence.text)),
  );
}

function allIds(doc: ParsedDoc): string[] {
  return [
    ...doc.chapters.map((chapter) => chapter.id),
    ...doc.chapters.flatMap((chapter) => [
      ...chapter.blocks.map((block) => block.id),
      ...chapter.blocks.flatMap((block) => block.sentences.map((sentence) => sentence.id)),
    ]),
  ];
}

function dump(name: string, doc: ParsedDoc, extra: Record<string, unknown> = {}): void {
  const dir = process.env.IMPORT_DUMP_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });

  const sentences = allSentences(doc);
  const first: Chapter[] = doc.chapters.slice(0, 2);
  writeFileSync(
    resolve(dir, `dump-${name}.json`),
    JSON.stringify(
      {
        title: doc.title,
        author: doc.author,
        format: doc.format,
        chapterCount: doc.chapters.length,
        sentenceCount: sentences.length,
        chapters: doc.chapters.map((chapter) => ({
          title: chapter.title,
          blocks: chapter.blocks.length,
          sentences: chapter.blocks.reduce((sum, block) => sum + block.sentences.length, 0),
        })),
        firstChapters: first.map((chapter) => ({
          title: chapter.title,
          blockKinds: chapter.blocks.map((block) => block.kind),
          sentences: chapter.blocks
            .flatMap((block) => block.sentences.map((sentence) => sentence.text))
            .slice(0, 30),
          rectCounts: chapter.blocks
            .flatMap((block) => block.sentences.map((sentence) => sentence.pdfRects?.length ?? 0))
            .slice(0, 30),
        })),
        ...extra,
      },
      null,
      2,
    ),
  );
}

/** Invariants every extractor must hold, whatever the file. */
function expectWellFormed(doc: ParsedDoc): void {
  expect(doc.title.trim().length).toBeGreaterThan(0);
  expect(doc.chapters.length).toBeGreaterThan(0);

  const ids = allIds(doc);
  expect(new Set(ids).size).toBe(ids.length);

  for (const chapter of doc.chapters) {
    expect(chapter.title.trim().length).toBeGreaterThan(0);
    expect(chapter.blocks.length).toBeGreaterThan(0);
    for (const block of chapter.blocks) {
      expect(block.sentences.length).toBeGreaterThan(0);
      for (const sentence of block.sentences) {
        expect(sentence.text).toBe(sentence.text.trim());
        expect(sentence.text.length).toBeGreaterThan(1);
        expect(sentence.text).not.toMatch(/\s{2,}/);
        expect(sentence.text).not.toMatch(/[\r\n\t]/);
        expect(sentence.text).not.toMatch(/^\d{1,4}$/); // stray page numbers
      }
    }
  }
}

describe.skipIf(!existsSync(fixture('notes-on-nursing.epub')))('real EPUB: Notes on Nursing (Gutenberg 17366)', () => {
  it('extracts readable chapters with sensible titles', { timeout: 120_000 }, async () => {
    const doc = await parseEpub(read(fixture('notes-on-nursing.epub')), 'fallback');
    dump('epub-notes-on-nursing', doc);

    expectWellFormed(doc);
    expect(doc.format).toBe('epub');
    expect(doc.title).toMatch(/notes on nursing/i);
    expect(doc.author).toMatch(/nightingale/i);
    // The book has 13 numbered chapters spread over 6 size-split spine files.
    expect(doc.chapters.length).toBeGreaterThanOrEqual(10);

    // A Gutenberg EPUB names its sections in the TOC; "Section N" means the match failed.
    const generic = doc.chapters.filter((chapter) => /^Section \d+$/.test(chapter.title));
    expect(generic.length).toBeLessThan(doc.chapters.length / 2);

    // Chapters split inside a spine file keep the heading they start on: the file
    // holding "III. PETTY MANAGEMENT." also holds "IV. NOISE.".
    const titles = doc.chapters.map((chapter) => chapter.title);
    expect(titles.some((title) => /^I\.\s*VENTILATION AND WARMING/.test(title))).toBe(true);
    expect(titles.some((title) => /^IV\.\s*NOISE/.test(title))).toBe(true);

    const text = allSentences(doc).join(' ');
    expect(text).toContain('Notes on Nursing');
    expect(text.length).toBeGreaterThan(50_000);

    // Each chapter must open on its own first paragraph, not on the tail of the
    // previous chapter that shared its spine file.
    const light = doc.chapters.find((chapter) => /^IX\.\s*LIGHT/.test(chapter.title));
    expect(light?.blocks[0]?.sentences[0]?.text).toMatch(/^It is the unqualified result/);
    const food = doc.chapters.find((chapter) => /^VII\.\s*WHAT FOOD/.test(chapter.title));
    expect(food?.blocks[0]?.sentences[0]?.text).toMatch(/^I will mention one or two/);

    // Gutenberg marks running side headings in the margin; read inline they were
    // spliced into the sentence the note labels ("Beef tea.One is the belief").
    expect(text).not.toContain('Beef tea.One');
    expect(text).toContain('One is the belief that beef tea');
  });
});

describe.skipIf(!existsSync(fixture('pharma-hypertension.docx')))('real DOCX: generated Word document', () => {
  it('maps Heading1 runs to chapters', { timeout: 30_000 }, async () => {
    const doc = await parseDocx(read(fixture('pharma-hypertension.docx')), 'pharma-hypertension');
    dump('docx-pharma-hypertension', doc);

    expectWellFormed(doc);
    expect(doc.format).toBe('docx');
    expect(doc.chapters.map((chapter) => chapter.title)).toEqual([
      'Pharmacology of Hypertension',
      'Thiazide Diuretics',
      'Beta Blockers',
    ]);
    expect(allSentences(doc).join(' ')).toContain('amlodipine 5 mg once daily');
  });
});

describe.skipIf(!existsSync(fixture('word-tables.docx')))('real DOCX: mammoth fixture', () => {
  it('keeps table text as one speakable block', { timeout: 30_000 }, async () => {
    const doc = await parseDocx(read(fixture('word-tables.docx')), 'tables');
    dump('docx-word-tables', doc);

    expectWellFormed(doc);
    const kinds = doc.chapters.flatMap((chapter) => chapter.blocks.map((block) => block.kind));
    expect(kinds).toContain('table');
    expect(allSentences(doc).join(' ')).toContain('Top left');
  });
});

describe.skipIf(!existsSync(REAL_PDF))('real PDF: two-column BJP review (PMC6240132)', () => {
  it('reads each column top-to-bottom instead of interleaving them', { timeout: 120_000 }, async () => {
    const parsed: PdfParseResult = await parsePdf(read(REAL_PDF), 'bee venom');
    dump('pdf-bjp-bee-venom', parsed.doc, {
      pageCount: parsed.pageCount,
      charsPerPage: parsed.charsPerPage,
    });

    expectWellFormed(parsed.doc);
    expect(parsed.pageCount).toBe(15);
    expect(parsed.charsPerPage).toBeGreaterThan(1000);

    const sentences = allSentences(parsed.doc);

    // The abstract repeats this phrase, so anchor on the body paragraph that
    // opens the Introduction in the left column of page 2.
    const opening = sentences.findIndex((sentence) => sentence.includes('commonly known as atopic eczema'));
    expect(opening).toBeGreaterThanOrEqual(0);

    // Whole paragraph from the left column, with nothing from the right column in it.
    expect(sentences[opening]).toContain('multifactorial skin disease');
    expect(sentences[opening]).not.toContain('genetic predisposing factor');

    // "identified" begins the right column, i.e. it comes after the whole left
    // column. Reading the rows in y order would splice it into the sentence above.
    const identified = sentences.findIndex((sentence) => sentence.startsWith('identified as the main'));
    expect(identified).toBeGreaterThan(opening);

    // Words hyphenated over a line or column break are one word again.
    const text = sentences.join(' ');
    expect(text).toContain('complex interactions of innate and adaptive immune responses');
    // "anti- JAK2" is not in this list: the space is inside a single PDF run in
    // the source ("anti-GAPDH, anti- JAK2, anti-"), so no layout rule can undo it.
    for (const broken of ['interac- ', 'identi- ', 'charac- ', 'filaggr- ', 'predisposin- ', 'ec- ']) {
      expect(text).not.toContain(broken);
    }
    // Figure captions on the full-page figure panels are set in ragged columns of
    // their own; the body text is what must never end on a hanging hyphen.
    const body = sentences.filter((sentence) => !/^\([A-Z]\)|^Fig(?:ure)?\s*\d/.test(sentence));
    expect(body.some((sentence) => /\b\w+-$/.test(sentence))).toBe(false);
    expect(text).toContain('characterized by an impaired epidermal barrier');
  });
});

describe.skipIf(!existsSync(SINGLE_COLUMN_PDF))('real PDF: single-column review (PMC7618196)', () => {
  it('still reads a one-column page in order and keeps every page', { timeout: 120_000 }, async () => {
    const parsed = await parsePdf(read(SINGLE_COLUMN_PDF), 'piezo1');
    dump('pdf-piezo1', parsed.doc, {
      pageCount: parsed.pageCount,
      charsPerPage: parsed.charsPerPage,
    });

    expectWellFormed(parsed.doc);
    expect(parsed.pageCount).toBe(34);
    expect(parsed.charsPerPage).toBeGreaterThan(1000);

    const text = allSentences(parsed.doc).join(' ');
    expect(text).toContain('PIEZO1');
    expect(text.length).toBeGreaterThan(100_000);
  });
});

describe.skipIf(!existsSync(NMC_PDF))('real PDF: NMC MD Pharmacology guidelines (wide leading)', () => {
  it('keeps a paragraph that wraps at wide leading in one block', { timeout: 120_000 }, async () => {
    const parsed = await parsePdf(read(NMC_PDF), 'md pharm');
    dump('pdf-nmc-md-pharmacology', parsed.doc, {
      pageCount: parsed.pageCount,
      charsPerPage: parsed.charsPerPage,
    });

    expectWellFormed(parsed.doc);
    expect(parsed.pageCount).toBe(12);

    const blocks = parsed.doc.chapters.flatMap((chapter) =>
      chapter.blocks.map((block) => block.sentences.map((sentence) => sentence.text).join(' ')),
    );

    // 12 pt type on a 20.6 pt step: measured against the font height, the gap is
    // 1.7× and every line used to become its own paragraph (441 blocks for 12
    // pages, one per line). The page's own leading gives one paragraph per
    // paragraph.
    expect(blocks.length).toBeLessThan(200);

    const purpose = blocks.filter((text) => text.includes('The purpose of PG education'));
    expect(purpose).toHaveLength(1);
    expect(purpose[0]).toContain(
      'high quality health care and advance the cause of science through research & training.',
    );
    expect(purpose[0]).not.toContain('Pharmacology consists');

    // The three centred title lines are one block, not one block each.
    expect(blocks.find((text) => text.startsWith('GUIDELINES FOR COMPETENCY BASED'))).toBe(
      'GUIDELINES FOR COMPETENCY BASED POSTGRADUATE TRAINING PROGRAMME FOR MD IN PHARMACOLOGY',
    );
  });
});
