/**
 * "Speed test on a sample page": a synthetic page drawn on a canvas, run through
 * the real model on this device. The model sees a painted page, not a blank one,
 * so the number is the one an import will actually get — and it is measured now
 * rather than promised in copy.
 */
import { createLayoutDetector } from './detector';
import { LAYOUT_MODEL } from './model';

const PAGE = { width: 612, height: 792 };

/** Milliseconds per page on this device, from one warm run. */
export async function measureLayoutMs(): Promise<number> {
  const detector = await createLayoutDetector();
  if (!detector) throw new Error('Download the model first, then measure.');

  try {
    const canvas = samplePage();
    const read = () => canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;

    // The first run pays for session warm-up (the graph is optimised lazily), so
    // it is not the number we report. One timed run after it keeps the wait to
    // two pages: on a slow phone every extra run is another few seconds of a
    // screen that says "Measuring".
    await detector.detect(read(), PAGE.width, PAGE.height);

    const started = performance.now();
    await detector.detect(read(), PAGE.width, PAGE.height);
    return performance.now() - started;
  } finally {
    detector.dispose();
  }
}

/**
 * Two columns of text with a rule above them: enough shapes and edges that the
 * detector does the work it does on a real page, and nothing that needs a file.
 */
function samplePage(): HTMLCanvasElement {
  const size = LAYOUT_MODEL.inputSize;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('This browser cannot draw the sample page.');

  context.fillStyle = '#fffdf9';
  context.fillRect(0, 0, size, size);
  context.fillStyle = '#16211f';

  const columnWidth = size * 0.44;
  for (let column = 0; column < 2; column++) {
    const left = size * 0.06 + column * size * 0.5;
    context.font = `600 ${Math.round(size * 0.035)}px system-ui, sans-serif`;
    context.fillText(column === 0 ? 'Introduction' : 'Methods', left, size * 0.08);
    context.font = `${Math.round(size * 0.026)}px system-ui, sans-serif`;

    for (let line = 0; line < 22; line++) {
      const y = size * 0.14 + line * size * 0.036;
      // Indented first line, then a ragged right edge: plain prose shape.
      const indent = line === 0 ? size * 0.02 : 0;
      const width = columnWidth * (0.86 + ((line * 7) % 5) * 0.028);
      context.fillRect(left + indent, y, width, size * 0.012);
    }
  }

  return canvas;
}
