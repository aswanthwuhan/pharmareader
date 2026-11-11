import './pdfPolyfill';
import { describe, expect, it } from 'vitest';
import type { PDFPageProxy } from 'pdfjs-dist';
import { OPS as PDF_OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { pagePanels, panelRects, type VectorOps } from './panels';
import type { PdfTextItem } from './pdfLayout';

/**
 * Small, readable stand-ins for the pdf.js operator numbers: `panelRects` takes
 * the constants as an argument, so a test does not need a real page.
 */
const OPS: VectorOps = {
  save: 1,
  restore: 2,
  transform: 3,
  setLineWidth: 4,
  constructPath: 5,
  paintFormXObjectBegin: 6,
  paintFormXObjectEnd: 7,
  fill: 8,
  eoFill: 9,
  stroke: 10,
  closeStroke: 11,
  fillStroke: 12,
  eoFillStroke: 13,
  closeFillStroke: 14,
  closeEOFillStroke: 15,
};

const WIDTH = 600;
const HEIGHT = 800;

/** The page space of a 600x800 page: PDF y grows up, page y grows down. */
const VIEWPORT = [1, 0, 0, -1, 0, HEIGHT];

type Step = readonly [number, readonly unknown[]];

/** A `constructPath` arg list: [paintOp, path data, bounding box]. */
function path(paint: number, minX: number, minY: number, maxX: number, maxY: number): Step {
  return [OPS.constructPath, [paint, null, new Float32Array([minX, minY, maxX, maxY])]];
}

function operatorList(steps: readonly Step[]) {
  return { fnArray: steps.map(([fn]) => fn), argsArray: steps.map(([, args]) => args) };
}

function item(str: string, x: number, y: number, w = 200): PdfTextItem {
  return { str, x, y, w, h: 12 };
}

/** Text in both page columns, inside the panel at page y 500..700. */
const BOTH_SIDES = [item('left', 70, 550), item('right', 330, 550), item('left', 70, 660), item('right', 330, 660)];

/** A shaded panel: PDF box x 60..540, y 100..300 -> page x 60..540, y 500..700. */
const SHADED_PANEL = path(OPS.fill, 60, 100, 540, 300);

function panels(steps: readonly Step[], items: readonly PdfTextItem[] = BOTH_SIDES, width = WIDTH) {
  const { fnArray, argsArray } = operatorList(steps);
  return panelRects(fnArray, argsArray, OPS, VIEWPORT, width, HEIGHT, items);
}

describe('panelRects', () => {
  it('finds a shaded box that spans both columns', () => {
    expect(panels([SHADED_PANEL])).toEqual([{ x: 60, y: 500, w: 480, h: 200 }]);
  });

  it('merges a title bar painted as a thick rule into its box', () => {
    // The bar is stroked 6.5 pt above the box: that is one panel on the page.
    const bar: Step = [OPS.setLineWidth, [20]];
    const rule: Step = path(OPS.stroke, 60, 313, 540, 313);
    const found = panels([SHADED_PANEL, [OPS.save, []], bar, rule, [OPS.restore, []]]);

    expect(found).toHaveLength(1);
    expect(found[0].y).toBeCloseTo(477);
    expect(found[0].h).toBeCloseTo(223);
  });

  it('leaves two boxes apart that are stacked with a real gap', () => {
    const upper = path(OPS.fill, 60, 400, 540, 500); // page y 300..400
    const lower = path(OPS.fill, 60, 100, 540, 200); // page y 600..700
    const texts = [...BOTH_SIDES, item('left', 70, 350), item('right', 330, 350)];
    expect(panels([upper, lower], texts)).toHaveLength(2);
  });

  it('ignores a painted page background', () => {
    const background = path(OPS.fill, -18, -18, 618, 818);
    expect(panels([background])).toEqual([]);
  });

  it('ignores a box that covers part of the width only', () => {
    const narrow = path(OPS.fill, 60, 100, 260, 300);
    expect(panels([narrow])).toEqual([]);
  });

  it('ignores a box that stops short of the page middle', () => {
    const left = path(OPS.fill, 60, 100, 295, 300);
    expect(panels([left])).toEqual([]);
  });

  it('ignores a box with text on one side of the middle only', () => {
    const oneSide = [item('left', 70, 550), item('left', 70, 660)];
    expect(panels([SHADED_PANEL], oneSide)).toEqual([]);
  });

  it('ignores a path that paints nothing', () => {
    // 28 is `endPath`: the path was only built to clip or measure.
    expect(panels([path(28, 60, 100, 540, 300)])).toEqual([]);
  });

  it('follows the CTM through save, transform and restore', () => {
    const shifted = panels([
      [OPS.save, []],
      [OPS.transform, [1, 0, 0, 1, 60, 0]],
      path(OPS.fill, 0, 100, 480, 300),
      [OPS.restore, []],
      // Painted after the restore, so it keeps the page transform: too narrow.
      path(OPS.fill, 0, 100, 100, 300),
    ]);

    expect(shifted).toEqual([{ x: 60, y: 500, w: 480, h: 200 }]);
  });

  it('applies a form XObject matrix until the form ends', () => {
    const scaled = panels([
      [OPS.paintFormXObjectBegin, [[2, 0, 0, 2, 0, 0], null]],
      path(OPS.fill, 30, 50, 270, 350),
      [OPS.paintFormXObjectEnd, []],
    ]);

    expect(scaled).toEqual([{ x: 60, y: 100, w: 480, h: 600 }]);
  });

  it('reads nothing from an operator list it cannot follow', () => {
    const broken = [
      [OPS.constructPath, []],
      [OPS.constructPath, [OPS.fill]],
      [OPS.constructPath, [OPS.fill, null, 'not a box']],
      [OPS.transform, [1, 2]],
      [OPS.setLineWidth, ['wide']],
    ] as const;

    expect(panels(broken)).toEqual([]);
  });

  it('returns nothing for a page with no size', () => {
    const { fnArray, argsArray } = operatorList([SHADED_PANEL]);
    expect(panelRects(fnArray, argsArray, OPS, VIEWPORT, 0, 0, BOTH_SIDES)).toEqual([]);
  });
});

describe('pagePanels', () => {
  const fakePage = (getOperatorList: () => Promise<unknown>) => ({ getOperatorList }) as unknown as PDFPageProxy;

  it('reads the panels of a page', async () => {
    // `pagePanels` passes the real pdf.js OPS, so this list uses its numbers.
    const list = {
      fnArray: [PDF_OPS.constructPath],
      argsArray: [[PDF_OPS.fill, null, new Float32Array([60, 100, 540, 300])]],
    };
    const viewport = { transform: VIEWPORT, width: WIDTH, height: HEIGHT };

    expect(await pagePanels(fakePage(async () => list), viewport, BOTH_SIDES)).toEqual([
      { x: 60, y: 500, w: 480, h: 200 },
    ]);
  });

  it('returns nothing when the page cannot produce an operator list', async () => {
    const viewport = { transform: VIEWPORT, width: WIDTH, height: HEIGHT };
    const failing = fakePage(async () => {
      throw new Error('no graphics');
    });

    expect(await pagePanels(failing, viewport, BOTH_SIDES)).toEqual([]);
  });
});
