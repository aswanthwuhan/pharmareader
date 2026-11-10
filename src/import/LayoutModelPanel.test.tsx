// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDownload, resetDownload } from '../tts/downloads';
import LayoutModelPanel, { LAYOUT_DOWNLOAD_ID } from './LayoutModelPanel';

/** The layout model's disk and download functions, replaced by a scriptable stand-in. */
const model = vi.hoisted(() => ({
  ready: false,
  downloads: 0,
  /** The progress callback of the run in flight, so a test can report mid-download. */
  progress: null as null | ((fraction: number) => void),
  finish: null as null | (() => void),
  fail: null as null | ((error: unknown) => void),
}));

vi.mock('./layout/model', () => ({
  LAYOUT_MODEL: { label: 'PP-DocLayout-L', bytes: 33_581_278, labels: ['text'] },
  isLayoutModelReady: () => Promise.resolve(model.ready),
  downloadLayoutModel: (onProgress?: (fraction: number) => void) => {
    model.downloads += 1;
    model.progress = onProgress ?? null;
    return new Promise<void>((resolve, reject) => {
      model.finish = () => {
        model.ready = true;
        onProgress?.(1);
        resolve();
      };
      model.fail = reject;
    });
  },
  deleteLayoutModel: () => {
    model.ready = false;
    return Promise.resolve();
  },
}));

vi.mock('./layout/benchmark', () => ({
  measureLayoutMs: () => Promise.resolve(720),
}));

vi.mock('./index', () => ({
  reanalyseBook: () => Promise.reject(new Error('not used by this panel test')),
}));

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has no Cache Storage; the panel only asks whether it exists (the model
  // module itself is mocked).
  (globalThis as { caches?: unknown }).caches = {};
  model.ready = false;
  model.downloads = 0;
  model.progress = null;
  model.finish = null;
  model.fail = null;
  resetDownload(LAYOUT_DOWNLOAD_ID);
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(async () => {
  // Let work the panel started finish while it is still mounted: a pending
  // measurement or live-query update would otherwise render outside act.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  await act(async () => {
    root?.unmount();
    // Clearing the store re-renders any subscriber still attached, so it has to
    // happen inside act as well.
    resetDownload(LAYOUT_DOWNLOAD_ID);
  });
  root = null;
  container.remove();
  delete (globalThis as { caches?: unknown }).caches;
  vi.restoreAllMocks();
});

async function mount(): Promise<string> {
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(LayoutModelPanel));
    // Let the "is it on disk?" effect (Dexie + Cache Storage) settle.
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  // The first mount also opens the database; wait for the card to replace the
  // "Checking…" placeholder instead of assuming a fixed delay.
  for (let attempt = 0; attempt < 50 && text().includes('Checking the layout model'); attempt++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  return text();
}

async function unmount(): Promise<void> {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
}

async function remount(): Promise<string> {
  container = document.createElement('div');
  document.body.append(container);
  return mount();
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((element) => element.textContent === label);
}

async function click(label: string): Promise<void> {
  await act(async () => {
    button(label)!.click();
    // The handler awaits IndexedDB and the store, so one tick is not enough.
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
}

function text(): string {
  return container.textContent ?? '';
}

/** Flush work the panel started on its own (a measurement, a live-query update). */
async function waitForText(needle: string, attempts = 50): Promise<string> {
  for (let attempt = 0; attempt < attempts && !text().includes(needle); attempt++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  return text();
}

describe('LayoutModelPanel', () => {
  it('offers the download before anything is installed', async () => {
    const initial = await mount();

    expect(initial).toContain('PP-DocLayout-L');
    expect(initial).toContain('Not downloaded');
    expect(initial).toContain('~32 MB');
    expect(button('Download')?.disabled).toBe(false);
    expect(button('Delete')).toBeUndefined();
    // Nothing is installed, so measuring would only fail.
    expect(button('Measure speed')?.disabled).toBe(true);
  });

  it('keeps the download and its progress when the panel is unmounted mid-way', async () => {
    await mount();
    await click('Download');
    expect(model.downloads).toBe(1);

    await act(async () => {
      model.progress?.(0.4);
    });
    expect(text()).toContain('Downloading 40%');
    expect(text()).toContain('13 of 32 MB');

    // The bug: leaving Settings threw this progress away and the return visit
    // showed an error.
    await unmount();
    const again = await remount();

    expect(again).toContain('Downloading 40%');
    expect(text()).not.toContain('The layout model is not working');
    expect(button('Download')?.disabled).toBe(true);
    expect(model.downloads).toBe(1);

    await act(async () => {
      model.finish!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(text()).toContain('Ready');
    expect(button('Download')).toBeUndefined();
    expect(model.downloads).toBe(1);
  });

  it('shows Ready after a download that finished while the panel was away', async () => {
    await mount();
    await click('Download');
    await act(async () => {
      model.progress?.(0.5);
    });
    await unmount();

    // The store keeps going without any panel subscribed.
    await act(async () => {
      model.finish!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const again = await remount();

    expect(again).toContain('Ready');
    expect(again).not.toContain('The layout model is not working');
    expect(button('Download')).toBeUndefined();
    expect(button('Delete')?.disabled).toBe(false);
    expect(model.downloads).toBe(1);
    // The measurement the old panel would have run is made up on return.
    expect(await waitForText('720 ms a page')).toContain('720 ms a page');
  });

  it('keeps the failure message and its stage across a remount', async () => {
    await mount();
    await click('Download');

    await act(async () => {
      model.fail!(new Error('Failed to fetch'));
    });
    // The store records the failure from a promise chain, so let its render land.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(text()).toContain('The layout model is not working');
    expect(text()).toContain('Failed to fetch');
    expect(button('Delete')).toBeDefined();

    const again = await remount();

    expect(again).toContain('The layout model is not working');
    expect(again).toContain('Failed to fetch');
    expect(again).toContain('Error');
    // A failed attempt may have left partial files behind, so Delete stays offered.
    expect(button('Delete')).toBeDefined();
    expect(model.downloads).toBe(1);
  });

  it('says so where the browser cannot store the model', async () => {
    delete (globalThis as { caches?: unknown }).caches;

    const initial = await mount();

    expect(initial).toContain('Not available here');
    expect(initial).toContain('read with the text-only layout');
    expect(button('Download')).toBeUndefined();
  });

  it('forgets the finished download when the model is deleted', async () => {
    model.ready = true;
    expect(await mount()).toContain('Ready');

    await click('Delete');

    expect(text()).toContain('Not downloaded');
    expect(button('Download')?.disabled).toBe(false);
    expect(getDownload(LAYOUT_DOWNLOAD_ID).status).toBe('idle');
  });
});
