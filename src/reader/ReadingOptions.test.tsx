import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../core/db';
import { DEFAULT_PAUSE_MS, DEFAULT_SKIP, PAUSE_KEY, SKIP_KEY, WORD_HIGHLIGHT_KEY } from './reading';
import ReadingOptions from './ReadingOptions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;

async function waitFor(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function render(): Promise<void> {
  await act(async () => {
    root?.render(<ReadingOptions />);
  });
  await waitFor(() => container.querySelector('input[aria-label="Tables"]') !== null, 'options rendered');
}

function box(label: string): HTMLInputElement {
  return container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
}

async function stored(key: string): Promise<unknown> {
  return (await db.settings.get(key))?.value;
}

beforeEach(async () => {
  await db.delete();
  await db.open();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
    });
    root = null;
  }
  container.remove();
  await db.delete();
  await db.open();
});

describe('ReadingOptions', () => {
  it('renders the section with every switch on its default and the pause at 300 ms', async () => {
    await render();

    expect(container.querySelector('#reading-h2')?.textContent).toBe('Reading aloud');
    expect(box('Tables').checked).toBe(DEFAULT_SKIP.tables);
    expect(box('Citations').checked).toBe(DEFAULT_SKIP.citations);
    expect(box('Parenthetical asides').checked).toBe(DEFAULT_SKIP.brackets);
    expect(box('Highlight the word being spoken').checked).toBe(true);

    const pause = container.querySelector<HTMLInputElement>('#rd-pause')!;
    expect(pause.value).toBe(String(DEFAULT_PAUSE_MS));
    expect(container.textContent).toContain('0.3 s of silence between paragraphs');
  });

  it('turns a skipped kind back on in the settings store', async () => {
    await render();

    await act(async () => {
      box('Tables').click();
    });
    await waitFor(async () => (await stored(SKIP_KEY.tables)) === false, 'tables stored off');
    await waitFor(() => box('Tables').checked === false, 'tables switch off');

    await act(async () => {
      box('Tables').click();
    });
    await waitFor(async () => (await stored(SKIP_KEY.tables)) === true, 'tables stored on');
  });

  it('stores the paragraph pause from the slider', async () => {
    await render();

    const pause = container.querySelector<HTMLInputElement>('#rd-pause')!;
    await act(async () => {
      // React reads the value from the event target on change.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(pause, '900');
      pause.dispatchEvent(new Event('input', { bubbles: true }));
      pause.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitFor(async () => (await stored(PAUSE_KEY)) === 900, 'pause stored');
    await waitFor(() => (container.textContent ?? '').includes('0.9 s of silence'), 'pause label updated');
  });

  it('stores the word-highlight choice', async () => {
    await render();

    await act(async () => {
      box('Highlight the word being spoken').click();
    });
    await waitFor(async () => (await stored(WORD_HIGHLIGHT_KEY)) === false, 'word highlight off');
  });
});
