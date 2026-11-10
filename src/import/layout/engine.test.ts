import { describe, expect, it } from 'vitest';
import { LABELS, decodeDetections, dedupeBoxes, packInput, regionKind } from './engine';

describe('regionKind', () => {
  it('maps the vocabulary the model was trained on to the reader kinds', () => {
    expect(regionKind('table')).toBe('table');
    expect(regionKind('figure_title')).toBe('caption');
    expect(regionKind('chart_title')).toBe('caption');
    expect(regionKind('chart')).toBe('figure');
    expect(regionKind('paragraph_title')).toBe('h');
    expect(regionKind('number')).toBe('footer');
    expect(regionKind('footer_image')).toBe('figure');
    expect(regionKind('aside_text')).toBe('p');
  });

  it('ignores labels it has no block for', () => {
    expect(regionKind('vision_footnote')).toBeNull();
    expect(regionKind('nonsense')).toBeNull();
  });
});

describe('decodeDetections', () => {
  const rows = (values: number[]) => Float32Array.from(values);

  it('turns model-space rows into page boxes and drops weak ones', () => {
    const detections = decodeDetections(
      rows([
        LABELS.indexOf('table'), 0.9, 64, 128, 640, 320, // half the width, half the height
        LABELS.indexOf('text'), 0.2, 0, 0, 10, 10, // below the threshold
      ]),
      400,
      800,
      640,
      0.5,
    );

    expect(detections).toHaveLength(1);
    const [box] = detections;
    expect({ ...box, score: Math.round(box.score * 100) / 100 }).toEqual({
      x: 40,
      y: 160,
      w: 360,
      h: 240,
      label: 'table',
      score: 0.9,
    });
  });

  it('never returns a box outside the page', () => {
    const [box] = decodeDetections(rows([LABELS.indexOf('text'), 0.9, 600, 600, 900, 900]), 400, 800, 640, 0.5);
    expect(box.x + box.w).toBeLessThanOrEqual(400);
    expect(box.y + box.h).toBeLessThanOrEqual(800);
  });
});

describe('packInput', () => {
  it('writes planar RGB in 0..1, ignoring alpha', () => {
    // Four pixels for a 2x2 page: white, green, blue, white.
    const rgba = new Uint8ClampedArray([
      255, 0, 51, 255,
      0, 255, 0, 0,
      0, 0, 255, 255,
      255, 255, 255, 255,
    ]);
    const input = packInput(rgba, 2);

    // R plane, then G plane, then B plane: four pixels each.
    expect(Array.from(input).map((value) => Math.round(value * 100) / 100)).toEqual([
      1, 0, 0, 1,
      0, 1, 0, 1,
      0.2, 0, 1, 1,
    ]);
  });
});

describe('dedupeBoxes', () => {
  it('keeps the best box when two labels cover the same area', () => {
    const kept = dedupeBoxes([
      { x: 0, y: 0, w: 100, h: 100, label: 'image', score: 0.54 },
      { x: 2, y: 2, w: 100, h: 100, label: 'chart', score: 0.65 },
      { x: 300, y: 0, w: 100, h: 100, label: 'text', score: 0.9 },
    ]);

    expect(kept.map((box) => box.label)).toEqual(['text', 'chart']);
  });
});
