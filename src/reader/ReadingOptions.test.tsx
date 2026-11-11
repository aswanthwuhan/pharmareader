import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../core/db';
import { TTS_ENGINE_SETTING } from '../tts/TtsSettings';
import { WHISPER_READY_SETTING } from '../tts/align/whisperModel';
import {
  BRACKET_KEY,
  DEFAULT_PAUSE_MS,
  DEFAULT_PREFETCH_AHEAD,
  DEFAULT_SKIP,
  LEGACY_BRACKET_KEY,
  PAUSE_KEY,
  PREFETCH_AHEAD_KEY,
  PREFETCH_CHOICES,
  SKIP_KEY,
  WORD_HIGHLIGHT_KEY,
} from './reading';
import ReadingOptions from './ReadingOptions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ANNOUNCE_LABEL = 'Pause around them (recommended)';

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
  await waitFor(() => container.querySelector('button.chip') !== null, 'options rendered');
}

function box(label: string): HTMLInputElement {
  return container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
}

/** The skip kinds are toggle chips, not checkboxes: label, then aria-pressed. */
function chip(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button.chip')].find(
    (button) => button.textContent === label,
  );
  if (!found) throw new Error(`no chip labelled ${label}`);
  return found;
}

function pressed(label: string): boolean {
  return chip(label).getAttribute('aria-pressed') === 'true';
}

async function stored(key: string): Promise<unknown> {
  return (await db.settings.get(key))?.value;
}

/** Let Dexie's live query deliver a settings change to React. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
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
  it('renders the panel with every skip kind held to its default and the pause at 300 ms', async () => {
    await render();

    expect(container.querySelector('.rd-options')).not.toBeNull();
    expect(container.querySelector('#reading-h2')).toBeNull();
    expect(pressed('Tables')).toBe(DEFAULT_SKIP.tables);
    expect(pressed('Citations')).toBe(DEFAULT_SKIP.citations);
    expect(box(ANNOUNCE_LABEL).checked).toBe(true);
    expect(box('Highlight the word being spoken').checked).toBe(true);

    const pause = container.querySelector<HTMLInputElement>('#rd-pause')!;
    expect(pause.value).toBe(String(DEFAULT_PAUSE_MS));
    expect(container.textContent).toContain('0.3 s of silence between paragraphs');
  });

  it('offers exactly four ways to read brackets', async () => {
    await render();

    const radios = [...container.querySelectorAll<HTMLInputElement>('input[name="rd-brackets"]')];
    expect(radios.map((radio) => radio.getAttribute('aria-label'))).toEqual([
      ANNOUNCE_LABEL,
      'Say “in brackets”',
      'Read normally',
      'Skip',
    ]);
    expect(container.querySelector('#rd-brackets-hint')?.textContent).toContain('(ANS)');
  });

  it('stores the bracket mode when another option is picked', async () => {
    await render();

    await act(async () => {
      box('Skip').click();
    });
    await waitFor(async () => (await stored(BRACKET_KEY)) === 'skip', 'skip mode stored');
    await waitFor(() => box('Skip').checked === true, 'skip radio checked');
    await waitFor(() => box(ANNOUNCE_LABEL).checked === false, 'announce radio unchecked');
  });

  it('migrates the old on/off parenthetical switch', async () => {
    await db.settings.put({ key: LEGACY_BRACKET_KEY, value: true });
    await render();

    await waitFor(() => box('Skip').checked === true, 'legacy switch shown as skip');
    expect(box(ANNOUNCE_LABEL).checked).toBe(false);
  });

  it('prefers the new setting over the old one', async () => {
    await db.settings.put({ key: LEGACY_BRACKET_KEY, value: true });
    await db.settings.put({ key: BRACKET_KEY, value: 'read' });
    await render();

    await waitFor(() => box('Read normally').checked === true, 'stored mode wins');
  });

  it('turns a skipped kind back on in the settings store', async () => {
    await render();

    await act(async () => {
      chip('Tables').click();
    });
    await waitFor(async () => (await stored(SKIP_KEY.tables)) === false, 'tables stored off');
    await waitFor(() => pressed('Tables') === false, 'tables chip released');

    await act(async () => {
      chip('Tables').click();
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

  it('offers how many sentences to prepare ahead and stores the choice', async () => {
    await render();

    const select = container.querySelector<HTMLSelectElement>('#rd-prefetch')!;
    expect(select.value).toBe(String(DEFAULT_PREFETCH_AHEAD));
    expect([...select.options].map((option) => option.value)).toEqual(
      PREFETCH_CHOICES.map(String)
    );
    expect(container.querySelector('#rd-prefetch-hint')?.textContent).toContain(
      'uses more battery and storage'
    );

    await act(async () => {
      // React reads the value from the event target on change.
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, '20');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitFor(async () => (await stored(PREFETCH_AHEAD_KEY)) === 20, 'prefetch ahead stored');
  });

  it('shows the 50-sentence look-ahead of an older install as the largest offered', async () => {
    await db.settings.put({ key: PREFETCH_AHEAD_KEY, value: 50 });
    await render();

    // The live query lands a moment after the first paint.
    await waitFor(
      () => (container.querySelector('#rd-prefetch') as HTMLSelectElement).value === '20',
      'the old 50 shown as 20',
    );
  });

  it('warns about heat only when the neural voice, the aligner and word highlight run together', async () => {
    const warned = () => (container.textContent ?? '').includes('runs a second model next to the voice');

    // The phone voice with the aligner installed: one model on the phone, no warning.
    await db.settings.put({ key: TTS_ENGINE_SETTING, value: 'system' });
    await db.settings.put({ key: WHISPER_READY_SETTING, value: true });
    await render();
    expect(warned()).toBe(false);

    // The on-device voice is the second model: now they run together.
    await db.settings.put({ key: TTS_ENGINE_SETTING, value: 'kokoro' });
    await flush();
    expect(warned()).toBe(true);

    // The phone voice is one of the two ways out the warning offers.
    await db.settings.put({ key: TTS_ENGINE_SETTING, value: 'system' });
    await flush();
    expect(warned()).toBe(false);

    await db.settings.put({ key: TTS_ENGINE_SETTING, value: 'kokoro' });
    await flush();
    expect(warned()).toBe(true);

    // Nothing downloaded: word highlighting is an estimate, not a model.
    await db.settings.put({ key: WHISPER_READY_SETTING, value: false });
    await flush();
    expect(warned()).toBe(false);

    await db.settings.put({ key: WHISPER_READY_SETTING, value: true });
    await flush();
    expect(warned()).toBe(true);

    // The other way out: stop following words.
    await act(async () => {
      box('Highlight the word being spoken').click();
    });
    await waitFor(async () => (await stored(WORD_HIGHLIGHT_KEY)) === false, 'word highlight off');
    await flush();
    expect(warned()).toBe(false);
  });
});
