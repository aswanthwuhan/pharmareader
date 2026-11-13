import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installBackBridge } from '../core/backButton';
import AudioQueueSheet, { type AudioQueueSheetProps } from './AudioQueueSheet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;

/** Kinetics is already saved for this voice; the third chapter has nothing to read. */
const CHAPTERS = [
  { index: 0, title: 'Kinetics', sentences: 2, saved: true },
  { index: 1, title: 'Dynamics', sentences: 3, saved: false },
  { index: 2, title: 'Appendix', sentences: 0, saved: false },
];

function makeProps(overrides: Partial<AudioQueueSheetProps> = {}): AudioQueueSheetProps {
  return {
    chapters: CHAPTERS,
    progress: null,
    onSave: vi.fn(),
    onCancelQueue: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

async function renderSheet(props: AudioQueueSheetProps): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(<AudioQueueSheet {...props} />);
  });
}

async function rerender(props: AudioQueueSheetProps): Promise<void> {
  await act(async () => {
    root?.render(<AudioQueueSheet {...props} />);
  });
}

function rows(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('.aq-row')];
}

function row(title: string): HTMLElement {
  const found = rows().find((candidate) => candidate.querySelector('.aq-title')?.textContent === title);
  if (!found) throw new Error(`no chapter row "${title}"`);
  return found;
}

function box(title: string): HTMLInputElement {
  const found = row(title).querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!found) throw new Error(`no checkbox for "${title}"`);
  return found;
}

function buttonByText(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => (candidate.textContent ?? '').trim() === text,
  );
  if (!found) throw new Error(`no button "${text}"`);
  return found;
}

function primary(): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>('.aq-actions .btn-primary');
  if (!found) throw new Error('no primary action');
  return found;
}

function hint(): string {
  return container.querySelector('.aq-hint')?.textContent?.trim() ?? '';
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
}

/** React reads `onChange` from the input event; a direct `.value` write is ignored. */
async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container.remove();
  vi.restoreAllMocks();
});

describe('AudioQueueSheet', () => {
  it('lists each chapter with its sentence count and a Saved mark', async () => {
    await renderSheet(makeProps());

    expect(rows()).toHaveLength(3);
    expect(row('Kinetics').textContent).toContain('2 sentences');
    expect(row('Kinetics').textContent).toContain('Saved');
    expect(row('Dynamics').textContent).toContain('3 sentences');
    expect(row('Dynamics').textContent).not.toContain('Saved');
    // A chapter with nothing to read cannot be picked.
    expect(box('Appendix').disabled).toBe(true);
  });

  it('starts with nothing chosen, then Select all and Clear drive the button', async () => {
    const props = makeProps();
    await renderSheet(props);

    expect(primary().disabled).toBe(true);
    expect(primary().textContent).toBe('Save chapters');

    await click(buttonByText('Select all'));
    // Only the chapters that have sentences are selected.
    expect(box('Kinetics').checked).toBe(true);
    expect(box('Dynamics').checked).toBe(true);
    expect(box('Appendix').checked).toBe(false);
    expect(primary().disabled).toBe(false);
    expect(primary().textContent).toBe('Save 2 chapters');

    await click(buttonByText('Clear'));
    expect(primary().disabled).toBe(true);
    expect(primary().textContent).toBe('Save chapters');

    await click(box('Dynamics'));
    expect(primary().textContent).toBe('Save 1 chapter');
  });

  it('saves the chosen chapters in book order and shows queue progress', async () => {
    const props = makeProps();
    await renderSheet(props);

    // Chosen in reverse: the queue still follows the book.
    await click(box('Dynamics'));
    await click(box('Kinetics'));
    await click(primary());

    expect(props.onSave).toHaveBeenCalledWith({ kind: 'chapters', chapterIndexes: [0, 1] });

    await rerender({
      ...props,
      progress: { done: 14, total: 20, status: 'Saving chapter 2 of 2 — 14 of 20 sentences' },
    });

    expect(container.textContent).toContain('Saving chapter 2 of 2 — 14 of 20 sentences');
    const bar = container.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('14');
    expect(bar?.getAttribute('aria-valuemax')).toBe('20');

    await click(buttonByText('Stop saving'));
    expect(props.onCancelQueue).toHaveBeenCalledTimes(1);

    await click(buttonByText('Close'));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('offers a page range for PDF books and validates it against the page count', async () => {
    const props = makeProps({ pageCount: 4, pageSentences: [1, 2, 0, 3] });
    await renderSheet(props);

    await click(buttonByText('Pages'));
    const inputs = [...container.querySelectorAll<HTMLInputElement>('.aq-page-input')];
    expect(inputs).toHaveLength(2);

    // Nothing entered yet.
    expect(primary().disabled).toBe(true);
    expect(hint()).toBe('Enter the first and last page.');

    await type(inputs[0]!, '5');
    await type(inputs[1]!, '6');
    expect(hint()).toBe('Enter pages 1 to 4.');
    expect(primary().disabled).toBe(true);

    await type(inputs[0]!, '3');
    await type(inputs[1]!, '2');
    expect(hint()).toBe('The last page must not come before the first.');

    // Page 3 has no sentences that the voice would read.
    await type(inputs[0]!, '3');
    await type(inputs[1]!, '3');
    expect(hint()).toBe('No sentences to read on those pages.');
    expect(primary().disabled).toBe(true);

    await type(inputs[0]!, '2');
    await type(inputs[1]!, '4');
    expect(hint()).toBe('5 sentences on pages 2–4.');
    expect(primary().textContent).toBe('Save pages 2–4');

    await click(primary());
    expect(props.onSave).toHaveBeenCalledWith({ kind: 'pages', from: 2, to: 4 });
  });

  it('does not offer pages for a text book', async () => {
    await renderSheet(makeProps());
    expect(container.textContent).not.toContain('Pages');
  });

  it('closes on Escape, the backdrop and the back key without touching the queue', async () => {
    const navigate = vi.fn();
    const dispose = installBackBridge(navigate, () => '/read/book-1');
    try {
      const props = makeProps();
      await renderSheet(props);

      await act(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
      });
      expect(props.onClose).toHaveBeenCalledTimes(1);
      expect(props.onCancelQueue).not.toHaveBeenCalled();

      await click(container.querySelector<HTMLElement>('.sheet-backdrop')!);
      expect(props.onClose).toHaveBeenCalledTimes(2);

      let handled = false;
      await act(async () => {
        handled = window.__pharmaBack?.() ?? false;
      });
      expect(handled).toBe(true);
      expect(props.onClose).toHaveBeenCalledTimes(3);
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it('names the chapters a run could not save and keeps the pickers', async () => {
    await renderSheet(makeProps({ failed: ['Dynamics'] }));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not save Dynamics.');
    expect(rows()).toHaveLength(3);
  });
});
