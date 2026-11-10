import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../core/db';
import type { AudioCacheRecord } from '../core/types';
import TtsSettings, { TEST_SENTENCE, TTS_ENGINE_SETTING, VOICE_TIP, filterEntries, formatBytes } from './TtsSettings';
import { getSetting } from '../core/settings';
import { invalidate, listLexiconEntries } from './lexicon';
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
  // lexicon count so no state update lands after the test finished. The
  // built-in rows themselves stay unmounted until their disclosure opens.
  await waitFor(() => container.querySelector('.tts-lexicon-count')?.textContent !== 'Loading rules…');
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
  it('starts on Auto with the voice tip visible', async () => {
    await mount();
    const engine = container.querySelector<HTMLSelectElement>('#tts-engine');
    expect(engine?.value).toBe('auto');
    expect(container.textContent).toContain(VOICE_TIP);

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
    await flush();
    expect(await getSetting(TTS_ENGINE_SETTING, 'auto')).toBe('kokoro');
  });

  it('lists built-in rules and persists a toggle', async () => {
    await mount();
    const summary = [...container.querySelectorAll('summary')].find((s) =>
      s.textContent?.startsWith('Built-in rules'),
    )!;
    await openDisclosure(summary);
    await waitFor(() => container.querySelectorAll('.tts-rules-builtin .tts-rule').length > 0);

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

  it('keeps the built-in rules behind their disclosure until it opens', async () => {
    await mount();
    expect(container.querySelectorAll('.tts-rules-builtin .tts-rule')).toHaveLength(0);

    const summary = [...container.querySelectorAll('summary')].find((s) =>
      s.textContent?.startsWith('Built-in rules'),
    )!;
    expect(summary.textContent).toMatch(/^Built-in rules \(\d+\)$/);

    await openDisclosure(summary);
    await waitFor(() => container.querySelectorAll('.tts-rules-builtin .tts-rule').length > 0);
  });

  it('searches the built-in rules from their own field', async () => {
    await mount();
    const summary = [...container.querySelectorAll('summary')].find((s) =>
      s.textContent?.startsWith('Built-in rules'),
    )!;
    await openDisclosure(summary);
    await waitFor(() => container.querySelectorAll('.tts-rules-builtin .tts-rule').length > 0);
    const all = container.querySelectorAll('.tts-rules-builtin .tts-rule').length;

    const search = container.querySelector<HTMLInputElement>('#tts-lexicon-search')!;
    await act(async () => {
      setInputValue(search, 'cyp');
    });
    await flush();

    const matches = container.querySelectorAll('.tts-rules-builtin .tts-rule').length;
    expect(matches).toBeGreaterThan(0);
    expect(matches).toBeLessThan(all);
    expect(container.querySelector('.tts-lexicon-count')?.textContent).toMatch(
      /^Showing \d+ of \d+ rules$/,
    );
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

    const clear = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Clear cache')!;
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
