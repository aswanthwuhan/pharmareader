// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../core/db';
import { getSetting } from '../core/settings';
import type { BookRecord } from '../core/types';
import { getDownload, resetDownload } from '../tts/downloads';
import LayoutModelPanel, { LAYOUT_DOWNLOAD_ID } from './LayoutModelPanel';
import { IMPORT_LAYOUT_KEY } from './importLayout';

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

/** `reanalyseBook`, scriptable so a test can report progress and choose the outcome. */
const run = vi.hoisted(() => ({
  calls: [] as string[],
  progress: null as null | ((note: string) => void),
  resolve: null as null | ((result: ReanalyseResult) => void),
  reject: null as null | ((error: unknown) => void),
}));

vi.mock('./index', () => ({
  reanalyseBook: (id: string, onProgress?: (note: string) => void) => {
    run.calls.push(id);
    run.progress = onProgress ?? null;
    return new Promise((resolve, reject) => {
      run.resolve = resolve;
      run.reject = reject;
    });
  },
}));

type ReanalyseResult = Awaited<ReturnType<typeof import('./index').reanalyseBook>>;

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has no Cache Storage; the panel only asks whether it exists (the model
  // module itself is mocked).
  (globalThis as { caches?: unknown }).caches = {};
  model.ready = false;
  model.downloads = 0;
  model.progress = null;
  model.finish = null;
  model.fail = null;
  run.calls = [];
  run.progress = null;
  run.resolve = null;
  run.reject = null;
  resetDownload(LAYOUT_DOWNLOAD_ID);
  await db.delete();
  await db.open();
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
    // The measurement the old panel would have run is made up on return; Delete
    // is disabled while that runs.
    expect(await waitForText('720 ms a page')).toContain('720 ms a page');
    expect(button('Delete')?.disabled).toBe(false);
    expect(model.downloads).toBe(1);
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
    // No model can run, so there is no question to store an answer for.
    expect(fieldSelect('Ask when a PDF is imported')).toBeUndefined();
  });

  it('forgets the finished download when the model is deleted', async () => {
    model.ready = true;
    expect(await mount()).toContain('Ready');

    await click('Delete');

    expect(text()).toContain('Not downloaded');
    expect(button('Download')?.disabled).toBe(false);
    expect(getDownload(LAYOUT_DOWNLOAD_ID).status).toBe('idle');
  });

  it('asks for the model before re-reading a book, and lists only PDFs', async () => {
    await db.books.put(book('pdf-1', 'Katzung', 'pdf', 'heuristic'));
    await db.books.put(book('notes-1', 'Pharmacology notes', 'txt'));

    await mount();

    const chooseBook = fieldSelect('Book');
    expect(chooseBook).toBeDefined();
    const options = [...chooseBook!.querySelectorAll('option')].map((option) => option.textContent ?? '');
    expect(options).toContain('Katzung — text layout only');
    expect(options.some((label) => label.includes('Pharmacology notes'))).toBe(false);
    // The warning about what re-reading does sits above the button that runs it.
    expect(text()).toContain('Highlights and bookmarks move to the same text where it is still there');
    expect(text()).toContain('Cards are not changed');
    expect(button('Run layout detection')?.disabled).toBe(true);
    expect(text()).toContain('Download the layout model above first.');
  });

  it('reads the chosen book again with the model and reports what survived', async () => {
    model.ready = true;
    await db.books.put(book('pdf-1', 'Katzung', 'pdf', 'heuristic'));

    await mount();
    await choose(fieldSelect('Book')!, 'pdf-1');

    const runButton = button('Run layout detection');
    expect(runButton?.disabled).toBe(false);
    await click('Run layout detection');
    expect(run.calls).toEqual(['pdf-1']);

    await act(async () => {
      run.progress?.('Analysing layout: page 3 of 9');
    });
    expect(text()).toContain('Katzung — Analysing layout: page 3 of 9');

    await act(async () => {
      run.resolve?.({
        layout: 'model',
        modelPages: 12,
        sentencesBefore: 10,
        sentencesAfter: 11,
        highlightsKept: 2,
        highlightsUnlinked: 1,
        bookmarksKept: 1,
        bookmarksMoved: 1,
        positionKept: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    expect(text()).toContain('“Katzung” read again');
    expect(text()).toContain('with the model, which laid out 12 pages');
    expect(text()).toContain('2 highlights carried across, 1 could not be found again and is kept in your notes');
    expect(text()).toContain('1 bookmark moved to the nearest text that is still there');
    expect(text()).toContain('the reading position was moved');
  });

  it('keeps the book as it was when the re-read fails', async () => {
    model.ready = true;
    await db.books.put(book('pdf-1', 'Katzung', 'pdf', 'heuristic'));

    await mount();
    await choose(fieldSelect('Book')!, 'pdf-1');
    await click('Run layout detection');

    await act(async () => {
      run.reject?.(new Error('That book is no longer in the library.'));
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    expect(text()).toContain('That book is no longer in the library.');
    // The re-read writes in one transaction, so nothing changed and it can be tried again.
    expect(button('Run layout detection')?.disabled).toBe(false);
  });

  it('shows the answer to the import question and stores a change', async () => {
    await mount();

    const ask = fieldSelect('Ask when a PDF is imported');
    expect(ask?.value).toBe('ask');
    expect(await getSetting(IMPORT_LAYOUT_KEY, 'ask')).toBe('ask');

    await choose(ask!, 'simple');

    expect(await getSetting(IMPORT_LAYOUT_KEY, 'ask')).toBe('simple');
  });

  it('says why detection cannot run when the model is turned off', async () => {
    model.ready = true;
    await db.settings.put({ key: 'import.layout', value: 'heuristic' });
    await db.books.put(book('pdf-1', 'Katzung', 'pdf', 'heuristic'));

    await mount();

    expect(text()).toContain('Set Layout for new PDFs to Automatic to run detection.');
    expect(button('Run layout detection')?.disabled).toBe(true);
  });
});

function book(id: string, title: string, format: 'pdf' | 'txt', layout?: 'model' | 'heuristic'): BookRecord {
  return {
    id,
    title,
    format,
    addedAt: 1,
    fileBlob: new Blob(['x']),
    parsed: { title, format, chapters: [] },
    topicIds: [],
    layout,
  };
}

/** The `select` of the field whose visible label is `label`. */
function fieldSelect(label: string): HTMLSelectElement | undefined {
  const field = [...container.querySelectorAll('label')].find(
    (candidate) => candidate.querySelector('.field-label')?.textContent === label,
  );
  return field?.querySelector('select') ?? undefined;
}

/** Change a native select the way a pointer would, so React's onChange runs. */
async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  setter?.call(select, value);
  await act(async () => {
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
}
