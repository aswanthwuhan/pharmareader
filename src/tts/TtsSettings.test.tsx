import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../core/db';
import type { AudioCacheRecord } from '../core/types';
import TtsSettings, { TEST_SENTENCE, TTS_ENGINE_SETTING, VOICE_TIP, filterEntries, formatBytes } from './TtsSettings';
import { getSetting } from '../core/settings';
import { invalidate, listLexiconEntries, saveUserEntry } from './lexicon';
import { putAudio } from './cache';

// React 19 keeps act() warnings quiet only when this flag is set.
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<TtsSettings />);
  });
  await flush();
  // Every section loads asynchronously (voices, lexicon, cache); wait for the
  // lexicon count so no state update lands after the test finished.
  await waitFor(() => container.querySelector('.tts-lexicon-count')?.textContent !== 'Loading rules…');
}

/** The "Built-in rules (N)" disclosure, which now always holds rows. */
function builtinDetails(): HTMLDetailsElement {
  return [...container.querySelectorAll<HTMLDetailsElement>('details')].find((d) =>
    d.querySelector('summary')?.textContent?.startsWith('Built-in rules'),
  )!;
}

function builtinRows(): NodeListOf<Element> {
  return container.querySelectorAll('.tts-rules-builtin .tts-rule');
}

function buttonWithText(text: string, within: ParentNode = container): HTMLButtonElement | undefined {
  return [...within.querySelectorAll('button')].find((b) => b.textContent === text);
}

/**
 * Open a native `<details>` the way a click would. jsdom does not run the
 * summary's activation behaviour, so set `open` and fire the toggle event the
 * panel listens on.
 */
async function openDisclosure(summary: Element): Promise<void> {
  const details = summary.closest('details') as HTMLDetailsElement;
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
  });
  await flush();
}

/** Let IndexedDB promises, effects and timers settle inside act(). */
async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** Poll inside act() until `check` passes: IndexedDB seeding is not instant. */
async function waitFor(check: () => boolean, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check() && Date.now() < deadline) {
    await flush(25);
  }
}

async function unmount(): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

function setInputValue(el: HTMLInputElement | HTMLSelectElement, value: string): void {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

beforeEach(() => {
  invalidate();
});

afterEach(async () => {
  if (root) await unmount();
  // Let the mount's lexicon seeding settle before wiping the database,
  // otherwise its transaction is aborted mid-flight and the next test's
  // shared seed promise rejects.
  await flush(10);
  await db.delete();
  await db.open();
  invalidate();
});

describe('formatBytes', () => {
  it('shows KB below a megabyte and MB above', () => {
    expect(formatBytes(0)).toBe('0 KB');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(3.5 * 1024 * 1024)).toBe('3.5 MB');
  });
});

describe('filterEntries', () => {
  it('matches pattern and replacement case-insensitively', () => {
    const rows = [
      { id: 'b-1', pattern: 'mg/kg', replacement: 'milligrams per kilogram', isRegex: true, source: 'builtin' as const, enabled: true },
      { id: 'b-2', pattern: 'CYP3A4', replacement: 'C Y P three eigh four', isRegex: true, source: 'builtin' as const, enabled: true },
    ];
    expect(filterEntries(rows, 'cyp')).toHaveLength(1);
    expect(filterEntries(rows, 'kilogram')).toHaveLength(1);
    expect(filterEntries(rows, '')).toHaveLength(2);
  });
});

describe('TtsSettings', () => {
  it('starts on Auto with the engine hint and the test sentence line', async () => {
    await mount();
    const engine = container.querySelector<HTMLSelectElement>('#tts-engine');
    expect(engine?.value).toBe('auto');
    expect(container.textContent).toContain(VOICE_TIP);

    // The selected engine's one-line hint sits under the select, before the link.
    const hint = container.querySelector('#tts-engine-hint');
    expect(hint?.textContent).toContain('Uses a downloaded on-device model when one is ready');
    expect(hint?.querySelector('a')?.getAttribute('href')).toBe('#voice-models');
    expect(hint?.querySelector('a')?.textContent).toBe('Manage on-device models');

    // "Speaks: …" is what the button will say, so it stays out of any disclosure.
    const speaks = container.querySelector('.tts-test-sentence');
    expect(speaks?.textContent).toBe(`Speaks: “${TEST_SENTENCE}”`);
    expect(speaks?.closest('details')).toBeNull();

    const rate = container.querySelector<HTMLInputElement>('#tts-rate');
    expect(rate?.min).toBe('0.5');
    expect(rate?.max).toBe('2');
  });

  it('writes the engine choice to settings when changed', async () => {
    await mount();
    const engine = container.querySelector<HTMLSelectElement>('#tts-engine')!;
    await act(async () => {
      setInputValue(engine, 'kokoro');
    });
    await waitFor(() => container.querySelector<HTMLSelectElement>('#tts-engine')?.value === 'kokoro');
    expect(await getSetting(TTS_ENGINE_SETTING, 'auto')).toBe('kokoro');

    // The hint follows the selection, and the system-voice hint names both engines.
    expect(container.querySelector('#tts-engine-hint')?.textContent).toContain('Kokoro-82M');
    expect(container.querySelector('#tts-voice-hint')?.textContent).toBe(
      'Used when the system engine speaks. The on-device model brings its own voices.',
    );
    expect(container.querySelector<HTMLSelectElement>('#tts-voice')?.disabled).toBe(true);
  });

  it('keeps the long voice tip inside "How this works", under its plain bold title', async () => {
    await mount();
    const tip = [...container.querySelectorAll('p')].find((p) => p.textContent === VOICE_TIP)!;
    const details = tip.closest('details')!;
    expect(details.querySelector('summary')?.textContent).toBe('How this works');
    expect(details.querySelector('.tts-note-title')?.textContent).toBe('A more natural system voice');
    // A plain line, not the old banner box.
    expect(details.querySelector('.banner')).toBeNull();
    expect(details.textContent!.indexOf('A more natural system voice')).toBeLessThan(
      details.textContent!.indexOf(VOICE_TIP),
    );
    expect(details.open).toBe(false);
    await openDisclosure(details.querySelector('summary')!);
    expect(details.open).toBe(true);
  });

  it('lists built-in rules and persists a toggle', async () => {
    await mount();
    await waitFor(() => builtinRows().length > 0);

    const boxes = container.querySelectorAll<HTMLInputElement>(
      '.tts-rules-builtin .tts-rule input[type="checkbox"]',
    );
    expect(boxes.length).toBeGreaterThan(0);
    expect(boxes[0]?.checked).toBe(true);

    await act(async () => {
      boxes[0]!.click();
    });
    await flush(20);

    const rows = await listLexiconEntries();
    const disabled = rows.filter((r) => r.source === 'builtin' && !r.enabled);
    expect(disabled.length).toBe(1);
  });

  it('mounts only the first eight built-in rules while the disclosure is closed', async () => {
    await mount();
    const details = builtinDetails();
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')?.textContent).toMatch(/^Built-in rules \(\d+\)$/);
    expect(builtinRows()).toHaveLength(8);

    const total = Number(/\((\d+)\)$/.exec(details.querySelector('summary')!.textContent!)![1]);
    expect(total).toBeGreaterThan(8);
    expect(buttonWithText(`Show all ${total} rules`, details)).toBeDefined();
    expect(buttonWithText('Show fewer', details)).toBeUndefined();
  });

  it('expands the built-in list with "Show all N rules" and collapses it again', async () => {
    await mount();
    const details = builtinDetails();
    const total = Number(/\((\d+)\)$/.exec(details.querySelector('summary')!.textContent!)![1]);

    await act(async () => {
      buttonWithText(`Show all ${total} rules`, details)!.click();
    });
    await flush();
    expect(builtinRows()).toHaveLength(total);

    await act(async () => {
      buttonWithText('Show fewer', details)!.click();
    });
    await flush();
    expect(builtinRows()).toHaveLength(8);
  });

  it('always shows the rule count, and counts while filtering', async () => {
    await mount();
    const count = () => container.querySelector('.tts-lexicon-count')?.textContent ?? '';
    expect(count()).toMatch(/^\d+ of \d+ rules$/);
    const total = Number(/^(\d+) of/.exec(count())![1]);
    expect(total).toBeGreaterThan(600);

    const search = container.querySelector<HTMLInputElement>('#tts-lexicon-search')!;
    await act(async () => {
      setInputValue(search, 'cyp');
    });
    await flush();
    expect(count()).toMatch(/^Showing \d+ of \d+ rules$/);
    expect(Number(/^Showing (\d+) of/.exec(count())![1])).toBeLessThan(total);
  });

  it('searches the own rules and the built-in rules from one field above the lists', async () => {
    await saveUserEntry({ pattern: '\\bomeprazole\\b', replacement: 'oh mep razole', isRegex: true });
    await mount();

    const search = container.querySelector<HTMLInputElement>('#tts-lexicon-search')!;
    expect(builtinRows()).toHaveLength(8);
    // The field is above both lists and outside every disclosure.
    const field = search.closest('.field')!;
    expect(field.closest('details')).toBeNull();
    expect(field.querySelector('.tts-lexicon-count')?.textContent).toMatch(/^\d+ of \d+ rules$/);

    await act(async () => {
      setInputValue(search, 'omeprazole');
    });
    await flush();

    // The reader's own rule and the built-in esomeprazole row both match.
    expect(container.querySelectorAll('.tts-rules-own .tts-rule')).toHaveLength(1);
    expect(builtinRows().length).toBeGreaterThan(0);
    expect(builtinRows().length).toBeLessThanOrEqual(8);
    expect(container.querySelector('.tts-lexicon-count')?.textContent).toMatch(
      /^Showing \d+ of \d+ rules$/,
    );

    // Results inside a disclosure must be visible, so it opens itself.
    expect(builtinDetails().open).toBe(true);
  });

  it('says so when a search matches nothing in either list', async () => {
    await mount();
    const search = container.querySelector<HTMLInputElement>('#tts-lexicon-search')!;
    await act(async () => {
      setInputValue(search, 'zzzznomatch');
    });
    await flush();

    expect(container.textContent).toContain('No rules match “zzzznomatch”.');
    expect(container.textContent).toContain('Showing 0 of');
    // Nothing matched, so the built-in list stays where it was.
    expect(builtinDetails().open).toBe(false);
  });

  it('keeps "No rules of your own yet." when the reader has no rules', async () => {
    await mount();
    const own = container.querySelector('.tts-rules-own');
    expect(own?.textContent).toBe('No rules of your own yet.');
  });

  it('previews text through the lexicon rules', async () => {
    await mount();

    const input = container.querySelector<HTMLInputElement>('#tts-lexicon-preview')!;
    await act(async () => {
      setInputValue(input, 'CYP3A4 inhibitors');
    });
    await flush(200);

    const preview = container.querySelector('.tts-preview');
    expect(preview?.textContent).toContain('C Y P three eigh four');
  });

  it('shows the cache size and clears it', async () => {
    const rec: AudioCacheRecord = {
      key: 'k1',
      engine: 'kokoro',
      audio: new Blob([new Uint8Array(4096)]),
      durationMs: 1000,
      createdAt: Date.now(),
    };
    await putAudio(rec);

    await mount();
    await waitFor(
      () => container.querySelector('[data-testid="tts-cache-size"]')?.textContent !== 'Measuring…',
    );
    const size = container.querySelector('[data-testid="tts-cache-size"]');
    expect(size?.textContent).not.toBe('Measuring…');

    const clear = buttonWithText('Clear cache')!;
    await act(async () => {
      clear.click();
    });
    await flush(20);
    expect(await db.audioCache.count()).toBe(0);
  });

  it('keeps the test sentence as specified', () => {
    expect(TEST_SENTENCE).toBe('The half-life of CYP3A4 substrates rises with ketoconazole.');
  });
});
