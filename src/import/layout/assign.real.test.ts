import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getDocument, Util } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PdfParagraph, PdfTextItem } from '../pdfLayout';
import { type AssignOptions, type PanelRect, layoutParagraphs, orderRegions, usableRegions } from './assign';
import type { LayoutBox } from './engine';

/**
 * Reading order on real Katzung pages. The regions were recorded from
 * PP-DocLayout-L int8 on the same pages, so the page's text and geometry are
 * real without needing the 33 MB model; the PDFs stay out of the repo, so these
 * cases skip when the samples are absent.
 *
 * Part 01 p10 and Part 02 p2 are the pages the model path used to get wrong: an
 * equation number read as a third column at the foot of the page, and a shaded
 * panel whose two inner columns were read as the page's own columns.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '__fixtures__');
const SAMPLES = resolve(HERE, '../../../.tmp/review-import/samples');

const PART_ONE = resolve(SAMPLES, 'katzung-ch03.pdf');
const PART_TWO = resolve(SAMPLES, 'katzung-ch03b.pdf');

/** Text items of one page, exactly as `parsePdf` builds them. */
async function pageText(path: string, pageNumber: number) {
  const task = getDocument({ data: new Uint8Array(readFileSync(path)) });
  const pdf = await task.promise;
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const items: PdfTextItem[] = [];

  for (const raw of content.items) {
    if (!('str' in raw) || !raw.str.trim()) continue;
    const matrix = Util.transform(viewport.transform, raw.transform) as number[];
    const height = Math.hypot(matrix[2], matrix[3]) || raw.height || 10;
    items.push({ str: raw.str, x: matrix[4], y: matrix[5] - height, w: raw.width ?? 0, h: height, page: pageNumber });
  }

  await task.destroy();
  return { width: viewport.width, height: viewport.height, items };
}

/** The recorded boxes of a fixture, in page units. */
function recorded(name: string, width: number, height: number): LayoutBox[] {
  const data = JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8')) as {
    boxes: { label: string; score: number; x: number; y: number; w: number; h: number }[];
  };
  return data.boxes.map((box) => ({
    label: box.label,
    score: box.score,
    x: box.x * width,
    y: box.y * height,
    w: box.w * width,
    h: box.h * height,
  }));
}

async function flow(path: string, pageNumber: number, fixture: string, options: Partial<AssignOptions> = {}) {
  const { width, height, items } = await pageText(path, pageNumber);
  return layoutParagraphs(pageNumber, width, height, items, recorded(fixture, width, height), {
    pitch: 12,
    measure: width,
    ...options,
  });
}

/** The regions of a page in reading order, without needing any text of their own. */
async function regions(path: string, pageNumber: number, fixture: string) {
  const { width, height } = await pageText(path, pageNumber);
  const boxes = usableRegions(recorded(fixture, width, height), width, height);
  return orderRegions(boxes, width).map((box) => `${box.label}:${Math.round(box.x)}:${Math.round(box.y)}`);
}

/** Position of the one paragraph whose text contains `needle`. */
function indexOf(paragraphs: PdfParagraph[], needle: string): number {
  return paragraphs.findIndex((paragraph) => paragraph.text.includes(needle));
}

describe.skipIf(!existsSync(PART_ONE))('layout model output: Katzung Part 01, equation numbers', () => {
  it('reads each equation number with the sentence it follows, not as a third column', { timeout: 120_000 }, async () => {
    const paragraphs = await flow(PART_ONE, 10, 'katzung-p10.json');

    const dosingRate = indexOf(paragraphs, 'predicts the maintenance dosing rate:');
    const equation9 = indexOf(paragraphs, '(9)');
    const next = indexOf(paragraphs, 'Thus, if the desired target concentration');
    const equation10 = indexOf(paragraphs, '(10)');
    const oral = indexOf(paragraphs, 'For oral dosing:');
    const intermittent = indexOf(paragraphs, 'If intermittent doses are given');
    const equation11 = indexOf(paragraphs, '(11)');

    // The number sits between the sentence it completes and the one that follows:
    // it used to be read at the foot of the page, in a column of its own.
    expect(dosingRate).toBeGreaterThanOrEqual(0);
    expect(equation9).toBeGreaterThan(dosingRate);
    expect(equation9).toBeLessThan(next);
    expect(oral).toBeGreaterThan(equation9);
    expect(equation10).toBeGreaterThan(oral);
    expect(equation10).toBeLessThan(intermittent);
    expect(equation11).toBeGreaterThan(intermittent);
    // And down the right column in printed order.
    expect(equation9).toBeLessThan(equation10);
    expect(equation10).toBeLessThan(equation11);
  });
});

describe.skipIf(!existsSync(PART_ONE))('layout model output: Katzung Part 01, a formula in its own column', () => {
  it('reads a right-column formula where it is printed, not after the whole column', { timeout: 120_000 }, async () => {
    const order = await regions(PART_ONE, 2, 'katzung-p2.json');
    const formula = order.indexOf('formula:395:606');

    expect(formula).toBeGreaterThanOrEqual(0);
    // Between the paragraph above it and the one below, both in the same column,
    // and not at the end of the page after both columns are read.
    expect(order[formula - 1]).toBe('text:321:552');
    expect(order[formula + 1]).toBe('text:321:647');
    // The left column's formula keeps its place the same way.
    expect(order[order.indexOf('formula:125:618') - 1]).toBe('text:57:576');
    expect(order[order.indexOf('formula:125:618') + 1]).toBe('text:57:659');
  });

  it('keeps four stacked right-column formulas in vertical order between two paragraphs', { timeout: 120_000 }, async () => {
    const order = await regions(PART_ONE, 5, 'katzung-p5.json');
    // The four boxes are one printed block of equations: the model cut it into a
    // container and three lines, and the container holds no text of its own.
    const block = ['formula:360:333', 'formula:361:333', 'formula:365:364', 'formula:363:395'];
    const start = order.indexOf('formula:360:333');

    expect(order.slice(start, start + block.length)).toEqual(block);
    expect(order[start - 1]).toBe('text:304:302');
    expect(order[start + block.length]).toBe('text:303:450');
  });
});

describe.skipIf(!existsSync(PART_TWO))('layout model output: Katzung Part 02, a shaded panel', () => {
  // Measured off the page: the shaded box, title bar included.
  const panel: PanelRect = { x: 60, y: 139, w: 509, h: 170 };

  it('reads the panel as its own band: what is above it, then its two columns, then the page below', { timeout: 120_000 }, async () => {
    const paragraphs = await flow(PART_TWO, 2, 'katzung-b-p2.json', { panels: [panel] });
    const markers = [
      'clearance, and volume of distribution', // above the panel, left column
      'Diseases may modify all of these parameters', // above the panel, right column
      'Recognition of the essential role of concentration', // the panel, left column
      '1. Choose the target concentration', // the panel, right column
      '6. Repeat steps 3–5, adjusting the predicted dose',
      'Pharmacokinetic Variables', // the page flow resumes under the panel
      'This reflects the fact that hepatic disease',
      'hepatic intrinsic clearance', // the panel's right column is done: the page's right column follows
    ];
    const order = markers.map((marker) => indexOf(paragraphs, marker));
    // The title bar is a heading, and the sentence above the panel also names the
    // box ("See Box: The Target Concentration Strategy"), so match the heading.
    const title = paragraphs.findIndex((paragraph) => paragraph.text === 'The Target Concentration Strategy');

    for (const index of order) expect(index).toBeGreaterThanOrEqual(0);
    expect(title).toBeGreaterThan(order[1]);
    expect(title).toBeLessThan(order[2]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('reads the page left column then right column when it is not told where the panel is', { timeout: 120_000 }, async () => {
    // No rect: the panel's two inner columns look like the page's own, so the page
    // reads its left column to the foot (the panel's left half and everything under
    // it) and only then the right, which puts the panel's six steps after text
    // printed below the panel. `pagePanels` measures the rect from the page's own
    // vector graphics; this case pins that the page still reads without it.
    const paragraphs = await flow(PART_TWO, 2, 'katzung-b-p2.json');
    expect(paragraphs.length).toBeGreaterThan(10);
  });
});
