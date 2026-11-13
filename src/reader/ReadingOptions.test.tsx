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
import {
  READ_ALONG_COLOUR_KEY,
  READ_ALONG_COLOUR_VARS,
  READ_ALONG_STRENGTH_KEY,
  READ_ALONG_STYLE_KEY,
  READ_ALONG_WORD_STRENGTH_KEY,
  READ_ALONG_WORD_STYLE_KEY,
} from './readAlong';

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

describe('ReadingOptions: the read-along mark', () => {
  function group(): HTMLElement {
    return container.querySelector<HTMLElement>('fieldset.rd-ra')!;
  }

  /** The segmented control in the row with this label ("Sentence style", "Word mark"). */
  function segRow(rowLabel: string): HTMLElement {
    const rows = [...group().querySelectorAll<HTMLElement>('.rd-ra-row')];
    const found = rows.find((row) => row.querySelector('.rd-opt-name')?.textContent === rowLabel);
    if (!found) throw new Error(`no row labelled ${rowLabel}`);
    return found;
  }

  function rowButton(rowLabel: string, label: string): HTMLButtonElement {
    const found = [...segRow(rowLabel).querySelectorAll<HTMLButtonElement>('button.rd-seg-btn')].find(
      (button) => button.textContent === label
    );
    if (!found) throw new Error(`no ${label} button in the ${rowLabel} row`);
    return found;
  }

  /** Two sliders: the sentence's, then the spoken word's. */
  function strength(index: number): HTMLInputElement {
    return group().querySelectorAll<HTMLInputElement>('input[type="range"]')[index]!;
  }

  async function setStrength(input: HTMLInputElement, value: string): Promise<void> {
    await act(async () => {
      // React reads the value from the event target on change.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  it('shows the sentence and word controls with their defaults and a live preview', async () => {
    await render();

    expect(group().querySelector('legend')?.textContent).toBe('Read-along highlight');
    expect(group().getAttribute('data-ra-style')).toBe('fill');
    expect(group().getAttribute('data-ra-word')).toBe('highlight');
    expect(group().style.getPropertyValue('--ra-color')).toBe(READ_ALONG_COLOUR_VARS.yellow.fill);
    expect(group().style.getPropertyValue('--ra-alpha')).toBe('30');
    expect(group().style.getPropertyValue('--ra-word-alpha')).toBe('70');
    expect(rowButton('Sentence style', 'Fill').getAttribute('aria-pressed')).toBe('true');
    expect(rowButton('Word mark', 'Highlight').getAttribute('aria-pressed')).toBe('true');
    expect(
      group().querySelector('[aria-label="Yellow read-along colour"]')?.getAttribute('aria-pressed')
    ).toBe('true');

    // The preview is the real sentence span with a real word mark, so it shows
    // both layers as the reader will see them.
    expect(group().querySelector('.rd-ra-preview .rd-s.reading')?.textContent).toContain(
      'sentence being read'
    );
    expect(group().querySelector('.rd-ra-preview .rd-word')?.textContent).toBe('sentence');

    const sentence = strength(0);
    expect(sentence.min).toBe('10');
    expect(sentence.max).toBe('60');
    expect(sentence.step).toBe('5');
    expect(sentence.value).toBe('30');
    expect(group().textContent).toContain('30%');

    const word = strength(1);
    expect(word.min).toBe('30');
    expect(word.max).toBe('100');
    expect(word.step).toBe('5');
    expect(word.value).toBe('70');
    expect(group().textContent).toContain('70%');
  });

  it('stores the style, the colour and the strength from the controls', async () => {
    await render();

    await act(async () => {
      rowButton('Sentence style', 'Underline').click();
    });
    await waitFor(async () => (await stored(READ_ALONG_STYLE_KEY)) === 'underline', 'style stored');
    await waitFor(() => group().getAttribute('data-ra-style') === 'underline', 'preview underlined');
    expect(rowButton('Sentence style', 'Underline').getAttribute('aria-pressed')).toBe('true');

    await act(async () => {
      group().querySelector<HTMLButtonElement>('[aria-label="Blue read-along colour"]')!.click();
    });
    await waitFor(async () => (await stored(READ_ALONG_COLOUR_KEY)) === 'blue', 'colour stored');
    await waitFor(
      () => group().style.getPropertyValue('--ra-color') === READ_ALONG_COLOUR_VARS.blue.fill,
      'preview recoloured'
    );
    expect(
      group().querySelector('[aria-label="Blue read-along colour"]')?.getAttribute('aria-pressed')
    ).toBe('true');

    await setStrength(strength(0), '55');
    await waitFor(async () => (await stored(READ_ALONG_STRENGTH_KEY)) === 55, 'strength stored');
    await waitFor(() => group().style.getPropertyValue('--ra-alpha') === '55', 'preview stronger');
    expect(group().textContent).toContain('55%');
  });

  it('stores the word mark and the word strength from the controls', async () => {
    await render();

    await act(async () => {
      rowButton('Word mark', 'Underline').click();
    });
    await waitFor(
      async () => (await stored(READ_ALONG_WORD_STYLE_KEY)) === 'underline',
      'word mark stored'
    );
    await waitFor(() => group().getAttribute('data-ra-word') === 'underline', 'preview ruled');
    expect(rowButton('Word mark', 'Underline').getAttribute('aria-pressed')).toBe('true');
    // The sentence keeps its own mark while the word changes.
    expect(rowButton('Sentence style', 'Fill').getAttribute('aria-pressed')).toBe('true');

    await setStrength(strength(1), '90');
    await waitFor(
      async () => (await stored(READ_ALONG_WORD_STRENGTH_KEY)) === 90,
      'word strength stored'
    );
    await waitFor(() => group().style.getPropertyValue('--ra-word-alpha') === '90', 'word stronger');
    expect(group().textContent).toContain('90%');
  });

  it('points at the word-highlight switch when word marking is off', async () => {
    await db.settings.put({ key: WORD_HIGHLIGHT_KEY, value: false });
    await render();

    await waitFor(
      () => (group().textContent ?? '').includes('Word marking is off'),
      'the off note shown'
    );
    expect(group().textContent).toContain('Highlight the word being spoken');
    // The controls stay usable while it is off.
    expect(rowButton('Word mark', 'Highlight')).toBeTruthy();
    expect(strength(1).disabled).toBe(false);
  });

  it('shows a stored value outside the range as the nearest allowed one', async () => {
    await db.settings.put({ key: READ_ALONG_STRENGTH_KEY, value: 200 });
    await db.settings.put({ key: READ_ALONG_COLOUR_KEY, value: 'purple' });
    await render();

    await waitFor(() => group().style.getPropertyValue('--ra-alpha') === '60', 'strength clamped');
    await waitFor(
      () => group().style.getPropertyValue('--ra-color') === READ_ALONG_COLOUR_VARS.yellow.fill,
      'colour fallback'
    );
  });
});
