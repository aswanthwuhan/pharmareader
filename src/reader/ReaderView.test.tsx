import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../core/db';
import type { BookRecord } from '../core/types';
import ReaderView from './ReaderView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BOOK_ID = 'book-reader-test';
const LAST_POS_KEY = `reader.lastPos.${BOOK_ID}`;

// The player drives audio; here it only records the queue it was given.
const playerMock = vi.hoisted(() => {
  interface Call {
    items: { id: string; text: string }[];
    startIndex: number;
    rate: number;
    onSentence?(id: string): void;
    onDone?(): void;
    played: number;
    stops: number;
  }
  const calls: Call[] = [];
  function createPlayer(options: Omit<Call, 'played' | 'stops'>) {
    const call: Call = { ...options, played: 0, stops: 0 };
    calls.push(call);
    return {
      play() {
        call.played += 1;
      },
      pause() {},
      resume() {},
      stop() {
        call.stops += 1;
      },
      seek() {},
    };
  }
  return { calls, createPlayer };
});

vi.mock('../tts/player', () => ({ createPlayer: playerMock.createPlayer }));

vi.mock('../tts/registry', () => ({
  ENGINE_SETTING: 'tts.engine',
  describeEngine: async () => ({
    preferred: true,
    engine: {
      id: 'system',
      label: 'System voices',
      capabilities: { streaming: true, prerender: false, wordBoundaries: true, needsDownload: false },
      isReady: async () => true,
      prepare: async () => undefined,
      listVoices: async () => [],
      speak: async () => undefined,
      stop() {},
      pause() {},
      resume() {},
    },
  }),
}));

// pdfjs is only reached through the lazily loaded page view, but mock it so a
// stray import can never touch a real worker or canvas in jsdom.
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({ promise: Promise.resolve({ numPages: 1 }), destroy: () => undefined }),
}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'worker.js' }));
vi.mock('../ai/AiActions', () => ({ default: () => null }));
vi.mock('../syllabus/TopicPicker', () => ({ default: () => null }));

let container: HTMLDivElement;
let root: Root | null = null;

function makeBook(overrides: Partial<BookRecord> = {}): BookRecord {
  return {
    id: BOOK_ID,
    title: 'Pharmacology Notes',
    author: 'A. Student',
    format: 'txt',
    addedAt: 1,
    fileBlob: new Blob(['notes'], { type: 'text/plain' }),
    topicIds: [],
    parsed: {
      title: 'Pharmacology Notes',
      format: 'txt',
      chapters: [
        {
          id: 'ch-0',
          title: 'Kinetics',
          blocks: [
            {
              id: 'b-0-0',
              kind: 'p',
              sentences: [
                { id: '0-0-0', text: 'Absorption is the first step.' },
                { id: '0-0-1', text: 'Bioavailability matters.' },
              ],
            },
          ],
        },
        {
          id: 'ch-1',
          title: 'Dynamics',
          blocks: [{ id: 'b-1-0', kind: 'p', sentences: [{ id: '1-0-0', text: 'Receptors bind drugs.' }] }],
        },
      ],
    },
    ...overrides,
  };
}

/** A chapter long enough that the reader must render it windowed. */
function makeLongBook(total: number): BookRecord {
  const blocks = [];
  const perBlock = 50;
  for (let start = 0; start < total; start += perBlock) {
    const sentences = [];
    for (let i = start; i < Math.min(total, start + perBlock); i += 1) {
      sentences.push({ id: `0-0-${i}`, text: `Sentence number ${i} about pharmacokinetics.` });
    }
    blocks.push({ id: `b-${start}`, kind: 'p' as const, sentences });
  }
  const book = makeBook();
  return {
    ...book,
    parsed: {
      title: book.title,
      format: 'txt',
      chapters: [{ id: 'ch-0', title: 'Long chapter', blocks }],
    },
  };
}

async function waitFor(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  throw new Error(`timed out waiting for ${label}`);
}

function renderReader(): Promise<void> {
  return act(async () => {
    root?.render(
      <MemoryRouter initialEntries={[`/read/${BOOK_ID}`]}>
        <Routes>
          <Route path="/read/:bookId" element={<ReaderView />} />
        </Routes>
      </MemoryRouter>
    );
  });
}

function sentence(id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-sid="${id}"]`);
}

function readingId(): string | null {
  return container.querySelector('.reading')?.getAttribute('data-sid') ?? null;
}

function buttonByLabel(label: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
}

function buttonByText(text: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      (button.textContent ?? '').includes(text)
    ) ?? null
  );
}

function playButton(): HTMLButtonElement | null {
  return buttonByLabel('Play') ?? buttonByLabel('Pause') ?? buttonByLabel('Resume');
}

function engineLabel(): string {
  return container.querySelector('.rd-engine')?.textContent?.trim() ?? '';
}

async function savedPos(): Promise<{ chapterId?: string; sentenceId?: string } | undefined> {
  const row = await db.settings.get(LAST_POS_KEY);
  return row?.value as { chapterId?: string; sentenceId?: string } | undefined;
}

async function waitForEngine(): Promise<void> {
  await waitFor(() => engineLabel() !== '' && !engineLabel().startsWith('Resolving voice'), 'engine resolved');
}

beforeEach(async () => {
  await db.delete();
  await db.open();
  playerMock.calls.length = 0;
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await db.delete();
  await db.open();
});

describe('ReaderView reflow', () => {
  it('renders the chapter as tappable sentences', async () => {
    await db.books.put(makeBook());
    await renderReader();
    await waitFor(() => sentence('0-0-0') !== null, 'first sentence');

    const text = container.textContent ?? '';
    expect(text).toContain('Absorption is the first step.');
    expect(text).toContain('Bioavailability matters.');
    expect(text).toContain('Kinetics');
    // One chapter at a time: the second chapter is not rendered.
    expect(sentence('1-0-0')).toBeNull();
  });

  it('restores lastPos and marks that sentence as reading', async () => {
    await db.books.put(makeBook({ lastPos: { chapterId: 'ch-1', sentenceId: '1-0-0' } }));
    await renderReader();
    await waitFor(() => readingId() === '1-0-0', 'restored cursor');
    expect(container.textContent).toContain('Dynamics');
  });

  it('moves the cursor to a tapped sentence', async () => {
    await db.books.put(makeBook());
    await renderReader();
    await waitFor(() => sentence('0-0-0') !== null, 'first sentence');

    const second = sentence('0-0-1');
    expect(second).not.toBeNull();
    await act(async () => {
      second?.click();
    });

    expect(readingId()).toBe('0-0-1');
  });

  it('starts the player from the cursor with the rest of the chapter', async () => {
    await db.books.put(makeBook());
    await renderReader();
    await waitForEngine();

    await act(async () => {
      playButton()?.click();
    });
    await waitFor(() => playerMock.calls.length === 1, 'player created');

    const call = playerMock.calls[0];
    expect(call?.items.map((item) => item.id)).toEqual(['0-0-0', '0-0-1']);
    expect(call?.startIndex).toBe(0);
    expect(call?.played).toBe(1);

    // The spoken sentence becomes the cursor.
    await act(async () => {
      call?.onSentence?.('0-0-1');
    });
    expect(readingId()).toBe('0-0-1');
  });

  it('calls play synchronously inside the tap gesture', async () => {
    await db.books.put(makeBook());
    await renderReader();
    await waitForEngine();

    // No awaited work between the click and player.play(): a microtask gap
    // would leave the queue empty here (and would lose the autoplay gesture).
    act(() => {
      playButton()?.click();
    });

    expect(playerMock.calls.length).toBe(1);
    expect(playerMock.calls[0]?.played).toBe(1);
  });

  it('saves the reading position in settings, not by rewriting the book', async () => {
    await db.books.put(makeBook());
    const getSpy = vi.spyOn(db.books, 'get');
    await renderReader();
    await waitFor(() => sentence('0-0-1') !== null, 'second sentence');

    await act(async () => {
      sentence('0-0-1')?.click();
    });
    await waitFor(async () => (await savedPos())?.sentenceId === '0-0-1', 'lastPos saved');

    // The debounce must not have re-read the record (the parsed doc is huge).
    const readsBeforeUnmount = getSpy.mock.calls.length;
    expect(readsBeforeUnmount).toBe(1);
    expect((await db.books.get(BOOK_ID))?.lastPos).toBeUndefined();
  });

  it('flushes books.lastPos for the library when the reader closes', async () => {
    await db.books.put(makeBook());
    await renderReader();
    await waitFor(() => sentence('0-0-1') !== null, 'second sentence');

    await act(async () => {
      sentence('0-0-1')?.click();
    });
    await waitFor(async () => (await savedPos())?.sentenceId === '0-0-1', 'lastPos saved');

    await act(async () => {
      root?.unmount();
    });
    root = null;

    const stored = await db.books.get(BOOK_ID);
    expect(stored?.lastPos).toEqual({ chapterId: 'ch-0', sentenceId: '0-0-1' });
  });

  it('stops the player when the chapter changes', async () => {
    await db.books.put(makeBook());
    await renderReader();
    await waitForEngine();
    await act(async () => {
      playButton()?.click();
    });
    await waitFor(() => playerMock.calls.length === 1, 'player created');

    await act(async () => {
      buttonByText('Next chapter')?.click();
    });

    expect(playerMock.calls[0]?.stops).toBe(1);
    expect(playerMock.calls.length).toBe(1);
    expect(readingId()).toBe('1-0-0');
  });

  it('stops the player on unmount', async () => {
    await db.books.put(makeBook());
    await renderReader();
    await waitForEngine();
    await act(async () => {
      playButton()?.click();
    });
    await waitFor(() => playerMock.calls.length === 1, 'player created');

    await act(async () => {
      root?.unmount();
    });
    root = null;

    expect(playerMock.calls[0]?.stops).toBe(1);
  });

  it('auto-advances to the next chapter exactly once', async () => {
    await db.books.put(makeBook());
    await renderReader();
    await waitForEngine();
    await act(async () => {
      playButton()?.click();
    });
    await waitFor(() => playerMock.calls.length === 1, 'player created');

    await act(() => {
      playerMock.calls[0]?.onDone?.();
    });

    expect(playerMock.calls.length).toBe(2);
    expect(playerMock.calls[0]?.stops).toBe(1);
    expect(playerMock.calls[1]?.items.map((item) => item.id)).toEqual(['1-0-0']);
    expect(playerMock.calls[1]?.played).toBe(1);
    expect(readingId()).toBe('1-0-0');

    // Last chapter: finishing leaves the bar idle, and no third player exists.
    await act(() => {
      playerMock.calls[1]?.onDone?.();
    });
    expect(playerMock.calls.length).toBe(2);
    expect(buttonByLabel('Play')).not.toBeNull();
  });

  it('restarts playback once after a speed change settles', async () => {
    await db.books.put(makeBook());
    await renderReader();
    await waitForEngine();
    await act(async () => {
      playButton()?.click();
    });
    await waitFor(() => playerMock.calls.length === 1, 'player created');

    const slider = container.querySelector<HTMLInputElement>('input[aria-label="Playback speed"]');
    expect(slider).not.toBeNull();
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      // A drag fires many of these; only one restart may follow.
      for (const value of ['1.1', '1.25', '1.5']) {
        setValue?.call(slider, value);
        slider?.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    expect(playerMock.calls.length).toBe(1);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450));
    });

    expect(playerMock.calls.length).toBe(2);
    expect(playerMock.calls[1]?.rate).toBe(1.5);
    expect(playerMock.calls[1]?.startIndex).toBe(0);
  });

  it('applies a speed change made while paused on the next Play', async () => {
    await db.books.put(makeBook());
    await renderReader();
    await waitForEngine();
    await act(async () => {
      playButton()?.click();
    });
    await waitFor(() => playerMock.calls.length === 1, 'player created');

    await act(async () => {
      buttonByLabel('Pause')?.click();
    });
    expect(playerMock.calls[0]?.stops).toBe(0);

    const slider = container.querySelector<HTMLInputElement>('input[aria-label="Playback speed"]');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setValue?.call(slider, '1.5');
      slider?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // The paused clip already baked in the old rate: it must be dropped.
    expect(playerMock.calls[0]?.stops).toBe(1);
    expect(buttonByLabel('Play')).not.toBeNull();

    await act(async () => {
      playButton()?.click();
    });
    expect(playerMock.calls.length).toBe(2);
    expect(playerMock.calls[1]?.rate).toBe(1.5);
  });

  it('clears Media Session handlers on unmount', async () => {
    const setActionHandler = vi.fn();
    Object.defineProperty(navigator, 'mediaSession', {
      configurable: true,
      value: { metadata: null, playbackState: 'none', setActionHandler },
    });
    class FakeMetadata {
      constructor(init: Record<string, unknown>) {
        Object.assign(this, init);
      }
    }
    vi.stubGlobal('MediaMetadata', FakeMetadata);

    await db.books.put(makeBook());
    await renderReader();
    await waitFor(() => setActionHandler.mock.calls.some(([action]) => action === 'play'), 'media handlers');

    await act(async () => {
      root?.unmount();
    });
    root = null;

    const cleared = setActionHandler.mock.calls.filter(([, handler]) => handler === null).map(([action]) => action);
    expect(cleared).toEqual(expect.arrayContaining(['play', 'pause', 'stop', 'nexttrack', 'previoustrack']));
  });

  it('windows a long chapter and expands on demand', async () => {
    await db.books.put(makeLongBook(500));
    await renderReader();
    await waitFor(() => sentence('0-0-0') !== null, 'first sentence');

    const rendered = container.querySelectorAll('[data-sid]').length;
    expect(rendered).toBeGreaterThan(200);
    expect(rendered).toBeLessThan(500);

    await act(async () => {
      buttonByText('Show more')?.click();
    });
    expect(container.querySelectorAll('[data-sid]').length).toBe(500);
  });

  it('grows the rendered window as the reader scrolls toward its end', async () => {
    await db.books.put(makeLongBook(900));
    await renderReader();
    await waitFor(() => sentence('0-0-0') !== null, 'first sentence');

    const before = container.querySelectorAll('[data-sid]').length;
    expect(before).toBeLessThan(900);

    await act(async () => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(container.querySelectorAll('[data-sid]').length).toBeGreaterThan(before);
  });

  it('maps a native drag selection across spans to the right sentence ids', async () => {
    await db.books.put(makeBook());
    await renderReader();
    await waitFor(() => sentence('0-0-1') !== null, 'sentences');

    const first = sentence('0-0-0');
    const second = sentence('0-0-1');
    expect(first?.firstChild).not.toBeNull();
    expect(second?.firstChild).not.toBeNull();
    const range = document.createRange();
    range.setStart(first?.firstChild as Node, 2);
    range.setEnd(second?.firstChild as Node, 5);
    const native = window.getSelection();
    await act(async () => {
      native?.removeAllRanges();
      native?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    const tools = container.querySelector('[role="dialog"][aria-label="Actions for 2 selected sentences"]');
    expect(tools).not.toBeNull();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Yellow highlight"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(async () => (await db.highlights.count()) === 1, 'highlight saved');
    const saved = await db.highlights.toCollection().first();
    expect(saved?.sentenceIds).toEqual(['0-0-0', '0-0-1']);
  });

  it('creates a highlight from a long-press selection', async () => {
    await db.books.put(makeBook());
    await renderReader();
    await waitFor(() => sentence('0-0-0') !== null, 'first sentence');

    await act(async () => {
      sentence('0-0-0')?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });

    const swatch = container.querySelector<HTMLButtonElement>('[aria-label="Yellow highlight"]');
    expect(swatch).not.toBeNull();
    await act(async () => {
      swatch?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(async () => (await db.highlights.count()) === 1, 'highlight saved');
    const saved = await db.highlights.toCollection().first();
    expect(saved?.sentenceIds).toEqual(['0-0-0']);
    expect(saved?.color).toBe('yellow');
    expect(saved?.bookId).toBe(BOOK_ID);
  });
});
