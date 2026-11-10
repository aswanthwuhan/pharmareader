import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../core/db';
import { installBackBridge } from '../core/backButton';
import type { BookRecord } from '../core/types';
import ReaderView from './ReaderView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BOOK_ID = 'book-reader-test';
const LAST_POS_KEY = `reader.lastPos.${BOOK_ID}`;
/** Mirrors ReaderView's hint duration; the test only needs "shortly after". */
const IMMERSIVE_HINT_MS = 3000;

// The player drives audio; here it only records the queue it was given.
const playerMock = vi.hoisted(() => {
  interface Call {
    items: { id: string; text: string; spoken?: string }[];
    startIndex: number;
    rate: number;
    onSentence?(id: string, index?: number): void;
    onItemState?(id: string, state: string): void;
    onBuffer?(readyAhead: number): void;
    onWord?(id: string, charIndex: number): void;
    onDone?(): void;
    onError?(err: Error, id?: string): void;
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
      index: options.startIndex ?? 0,
      bufferAhead: 0,
    };
  }
  function last(): Call | undefined {
    return calls[calls.length - 1];
  }
  return { calls, createPlayer, last };
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
// stray import can never touch a real worker or canvas in jsdom. The page view
// loads the legacy build plus a worker wrapper module (see src/import/pdfWorker.ts).
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({ promise: Promise.resolve({ numPages: 1 }), destroy: () => undefined }),
}));
vi.mock('../import/pdfWorker?worker&url', () => ({ default: 'worker.js' }));
vi.mock('../ai/AiActions', () => ({ default: () => null }));
vi.mock('../syllabus/TopicPicker', () => ({ default: () => null }));

// The Android media service is native; the reader may only use this API. The
// mock records what the reader asks of it and replays button presses back.
const playbackMock = vi.hoisted(() => {
  type Action = 'play' | 'pause' | 'next' | 'previous' | 'stop';
  let listener: ((action: Action) => void) | null = null;
  const start = vi.fn(async (_meta: { title: string; subtitle?: string }) => undefined);
  const setState = vi.fn(async (_state: 'playing' | 'paused') => undefined);
  const stop = vi.fn(async () => undefined);
  const onAction = vi.fn((cb: (action: Action) => void) => {
    listener = cb;
    return () => {
      listener = null;
    };
  });
  return {
    start,
    setState,
    stop,
    onAction,
    send(action: Action) {
      listener?.(action);
    },
    listening: () => listener !== null,
  };
});
vi.mock('../tts/native/playbackPlugin', () => ({ nativePlayback: playbackMock }));

// Android immersive mode is native too: the reader asks for it and must always
// hand the system bars back.
const systemUiMock = vi.hoisted(() => ({
  setImmersive: vi.fn(async (_on: boolean) => undefined),
}));
vi.mock('../tts/native/systemUi', () => ({ setImmersive: systemUiMock.setImmersive }));

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

/** Renders at an arbitrary URL and echoes its query, to prove `play=1` is dropped. */
function renderReaderAt(path: string): Promise<void> {
  return act(async () => {
    root?.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/read/:bookId"
            element={
              <>
                <ReaderView />
                <LocationEcho />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    );
  });
}

function LocationEcho() {
  const location = useLocation();
  return <output data-testid="location">{location.search}</output>;
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

/** Open the selection bar the way a touch long-press does. */
async function longPress(id: string): Promise<void> {
  await act(async () => {
    sentence(id)?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 600));
  });
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
  playbackMock.start.mockClear();
  playbackMock.setState.mockClear();
  playbackMock.stop.mockClear();
  playbackMock.onAction.mockClear();
  systemUiMock.setImmersive.mockClear();
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

  it('changes an existing sentence highlight instead of stacking a duplicate row', async () => {
    await db.books.put(makeBook());
    await renderReader();
    await waitFor(() => sentence('0-0-0') !== null, 'first sentence');

    await longPress('0-0-0');
    await act(async () => {
      buttonByLabel('Green highlight')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(async () => (await db.highlights.count()) === 1, 'first highlight');
    const first = await db.highlights.toCollection().first();

    // Highlighting the same sentence again with another colour must update it.
    await longPress('0-0-0');
    await act(async () => {
      buttonByLabel('Blue highlight')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(async () => (await db.highlights.get(first?.id ?? ''))?.color === 'blue', 'recoloured');

    expect(await db.highlights.count()).toBe(1);
    const saved = await db.highlights.toCollection().first();
    expect(saved?.id).toBe(first?.id);
    expect(saved?.color).toBe('blue');
  });
});

/** Three sentences in one block, for stepping and playback-start tests. */
function makeListBook(texts: string[]): BookRecord {
  const book = makeBook();
  return {
    ...book,
    parsed: {
      title: book.title,
      format: 'txt',
      chapters: [
        {
          id: 'ch-0',
          title: 'One chapter',
          blocks: [
            {
              id: 'b-0-0',
              kind: 'p',
              sentences: texts.map((text, i) => ({ id: `0-0-${i}`, text })),
            },
          ],
        },
      ],
    },
  };
}

/** A PDF-backed book: three sentences, one per page. */
function makePdfBook(): BookRecord {
  const rect = (page: number) => [{ page, x: 10, y: 10, w: 40, h: 8 }];
  return {
    ...makeBook({ format: 'pdf' }),
    parsed: {
      title: 'Pharmacology Notes',
      format: 'pdf',
      chapters: [
        {
          id: 'ch-0',
          title: 'Kinetics',
          blocks: [
            {
              id: 'b-0-0',
              kind: 'p',
              sentences: [
                { id: '0-0-0', text: 'Page one begins.', pdfRects: rect(1) },
                { id: '0-0-1', text: 'Page two begins.', pdfRects: rect(2) },
                { id: '0-0-2', text: 'Page three begins.', pdfRects: rect(3) },
              ],
            },
          ],
        },
      ],
    },
  };
}

/** Give every sentence a viewport position, so "visible" means something in jsdom. */
function stubRects(tops: Record<string, number>): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const id = this.getAttribute('data-sid');
    const top = (id && tops[id] !== undefined ? tops[id] : 200) ?? 200;
    const height = 40;
    return {
      top,
      bottom: top + height,
      left: 0,
      right: 320,
      width: 320,
      height,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect;
  });
}

function generatingSpan(): string | null {
  return container.querySelector('.rd-s.generating')?.getAttribute('data-sid') ?? null;
}

describe('reader: playback start and page stepping', () => {
  it('restarts the queue at the tapped sentence, not at the one after it (B1)', async () => {
    await db.books.put(makeListBook(['One.', 'Two.', 'Three.']));
    await renderReader();
    await waitForEngine();

    await act(async () => {
      playButton()?.click();
    });
    await waitFor(() => playerMock.calls.length === 1, 'player created');
    const first = playerMock.calls[0]!;

    // The first sentence has started; tap the third one.
    await act(async () => {
      first.onSentence?.('0-0-0', 0);
    });
    await act(async () => {
      sentence('0-0-2')?.click();
    });

    expect(playerMock.calls.length).toBe(2);
    expect(first.stops).toBe(1);
    const second = playerMock.calls[1]!;
    expect(second.startIndex).toBe(2);
    expect(second.played).toBe(1);

    await act(async () => {
      second.onSentence?.('0-0-2', 2);
    });
    expect(readingId()).toBe('0-0-2');
  });

  it('starts at the top of the viewport when the cursor has scrolled away (B2)', async () => {
    await db.books.put(makeListBook(['One.', 'Two.', 'Three.']));
    // The reading sentence is above the screen; "Two." is the first visible one.
    stubRects({ '0-0-0': -300, '0-0-1': 150, '0-0-2': 400 });
    await renderReader();
    await waitForEngine();
    await waitFor(() => buttonByText('Play from here') !== null, 'play-from-here pill');

    await act(async () => {
      playButton()?.click();
    });
    await waitFor(() => playerMock.calls.length === 1, 'player created');
    expect(playerMock.calls[0]?.startIndex).toBe(1);
  });

  it('keeps resuming at the cursor while it is on screen (B2)', async () => {
    await db.books.put(makeListBook(['One.', 'Two.', 'Three.']));
    stubRects({ '0-0-0': 120, '0-0-1': 400, '0-0-2': 800 });
    await renderReader();
    await waitForEngine();
    await act(async () => {
      sentence('0-0-1')?.click();
    });

    await act(async () => {
      playButton()?.click();
    });
    await waitFor(() => playerMock.calls.length === 1, 'player created');
    expect(playerMock.calls[0]?.startIndex).toBe(1);
    expect(buttonByText('Play from here')).toBeNull();
  });

  it('steps one screen of text from the page buttons (B3)', async () => {
    await db.books.put(makeListBook(['One.', 'Two.', 'Three.']));
    stubRects({ '0-0-0': 100, '0-0-1': 400, '0-0-2': 900 });
    await renderReader();
    await waitFor(() => sentence('0-0-0') !== null, 'first sentence');

    await act(async () => {
      buttonByLabel('Next page')?.click();
    });
    expect(readingId()).toBe('0-0-2');

    await act(async () => {
      buttonByLabel('Previous page')?.click();
    });
    expect(readingId()).toBe('0-0-0');
  });

  it('turns a PDF page from the player and plays from that page (B2, B3)', async () => {
    await db.books.put(makePdfBook());
    await renderReader();
    await waitForEngine();
    await waitFor(() => container.querySelector('.rd-pages-label')?.textContent === 'Page 1 of 3', 'page label');

    await act(async () => {
      buttonByLabel('Next page')?.click();
    });
    await waitFor(
      () => container.querySelector('.rd-pages-label')?.textContent === 'Page 2 of 3',
      'page two label'
    );
    expect(readingId()).toBe('0-0-1');

    await act(async () => {
      playButton()?.click();
    });
    await waitFor(() => playerMock.calls.length === 1, 'player created');
    expect(playerMock.calls[0]?.startIndex).toBe(1);
  });
});

describe('reader: generation status, skips and word highlight', () => {
  it('shows the sentence being generated and the buffer ahead (F1)', async () => {
    await db.books.put(makeListBook(['One.', 'Two.', 'Three.']));
    await renderReader();
    await waitForEngine();
    await act(async () => {
      playButton()?.click();
    });
    await waitFor(() => playerMock.calls.length === 1, 'player created');
    const call = playerMock.calls[0]!;

    await act(async () => {
      call.onItemState?.('0-0-1', 'generating');
    });
    expect(container.textContent).toContain('Generating sentence 2…');
    expect(generatingSpan()).toBe('0-0-1');

    await act(async () => {
      call.onItemState?.('0-0-1', 'ready');
      call.onBuffer?.(2);
    });
    expect(container.textContent).toContain('2 ready ahead');
    expect(generatingSpan()).toBeNull();
  });

  it('shows a failed sentence and retries it in place (F1)', async () => {
    await db.books.put(makeListBook(['One.', 'Two.', 'Three.']));
    await renderReader();
    await waitForEngine();
    await act(async () => {
      playButton()?.click();
    });
    await waitFor(() => playerMock.calls.length === 1, 'player created');

    await act(async () => {
      playerMock.calls[0]?.onError?.(new Error('Synthesis failed.'), '0-0-1');
    });
    expect(container.textContent).toContain('Synthesis failed.');

    await act(async () => {
      buttonByText('Try again')?.click();
    });
    expect(playerMock.calls.length).toBe(2);
    expect(playerMock.calls[1]?.startIndex).toBe(1);
    expect(container.textContent).not.toContain('Synthesis failed.');
  });

  it('leaves skipped blocks visible but out of the queue (F2)', async () => {
    const book = makeBook();
    book.parsed.chapters[0]!.blocks.push({
      id: 'b-0-1',
      kind: 'table',
      sentences: [{ id: '0-1-0', text: 'Dose: 5 mg twice daily.' }],
    });
    await db.books.put(book);
    await renderReader();
    await waitForEngine();
    await waitFor(() => sentence('0-1-0') !== null, 'table sentence rendered');
    expect(container.querySelector('.is-skipped')).not.toBeNull();
    expect(container.textContent).toContain('skipped while reading');

    await act(async () => {
      playButton()?.click();
    });
    await waitFor(() => playerMock.calls.length === 1, 'player created');
    expect(playerMock.calls[0]?.items.map((item) => item.id)).toEqual(['0-0-0', '0-0-1']);
  });

  it('speaks a sentence without its citation but keeps the original text (F2)', async () => {
    await db.books.put(makeListBook(['Used for pain [12].']));
    await renderReader();
    await waitForEngine();
    await act(async () => {
      playButton()?.click();
    });
    await waitFor(() => playerMock.calls.length === 1, 'player created');
    const item = playerMock.calls[0]?.items[0];
    expect(item?.text).toBe('Used for pain [12].');
    expect(item?.spoken).toBe('Used for pain.');
  });

  it('dims the current word inside the spoken sentence (F3)', async () => {
    await db.books.put(makeListBook(['Absorption is the first step.']));
    await renderReader();
    await waitForEngine();
    await act(async () => {
      playButton()?.click();
    });
    await waitFor(() => playerMock.calls.length === 1, 'player created');
    const call = playerMock.calls[0]!;

    await act(async () => {
      call.onSentence?.('0-0-0', 0);
      call.onWord?.('0-0-0', 12);
    });
    const mark = container.querySelector('[data-sid="0-0-0"] .rd-word');
    expect(mark?.textContent).toBe('is');
  });

  it('does not highlight words when the setting is off (F3)', async () => {
    await db.books.put(makeListBook(['Absorption is the first step.']));
    await act(async () => {
      await db.settings.put({ key: 'read.wordHighlight', value: false });
    });
    await renderReader();
    await waitForEngine();
    await act(async () => {
      playButton()?.click();
    });
    await waitFor(() => playerMock.calls.length === 1, 'player created');
    const call = playerMock.calls[0]!;

    await act(async () => {
      call.onSentence?.('0-0-0', 0);
      call.onWord?.('0-0-0', 12);
    });
    expect(container.querySelector('.rd-word')).toBeNull();
  });
});

describe('reader: playing a selection', () => {
  async function pick(ids: string[]): Promise<void> {
    await longPress(ids[0]!);
    await waitFor(() => container.querySelector('[role="dialog"]') !== null, 'selection actions');
    for (const id of ids.slice(1)) {
      await act(async () => {
        buttonByLabel('Extend selection by one sentence')?.click();
      });
      await waitFor(() => container.querySelector(`[data-sid="${id}"].selected`) !== null, 'sentence added');
    }
    await waitFor(() => buttonByLabel('Play selection') !== null, 'play selection offered');
  }

  it('plays only the picked sentences', async () => {
    await db.books.put(makeListBook(['One.', 'Two.', 'Three.']));
    await renderReader();
    await waitForEngine();
    await pick(['0-0-1']);

    await act(async () => {
      buttonByLabel('Play selection')?.click();
    });
    await waitFor(() => playerMock.calls.length === 1, 'player created');
    expect(playerMock.calls[0]?.items.map((item) => item.id)).toEqual(['0-0-1']);
    expect(playerMock.calls[0]?.startIndex).toBe(0);
    expect(playerMock.calls[0]?.played).toBe(1);
    expect(container.textContent).toContain('Selection: sentence 1 of 1');
  });

  it('plays a run of sentences in reading order', async () => {
    await db.books.put(makeListBook(['One.', 'Two.', 'Three.']));
    await renderReader();
    await waitForEngine();
    await pick(['0-0-0', '0-0-1']);

    await act(async () => {
      buttonByLabel('Play selection')?.click();
    });
    await waitFor(() => playerMock.calls.length === 1, 'player created');
    expect(playerMock.calls[0]?.items.map((item) => item.id)).toEqual(['0-0-0', '0-0-1']);

    await act(async () => {
      playerMock.calls[0]?.onSentence?.('0-0-1', 1);
    });
    expect(container.textContent).toContain('Selection: sentence 2 of 2');
  });

  it('stops at the end and offers continue and replay', async () => {
    await db.books.put(makeListBook(['One.', 'Two.', 'Three.']));
    await renderReader();
    await waitForEngine();
    await pick(['0-0-0']);

    await act(async () => {
      buttonByLabel('Play selection')?.click();
    });
    await waitFor(() => playerMock.calls.length === 1, 'player created');
    await act(async () => {
      playerMock.calls[0]?.onDone?.();
    });

    expect(container.textContent).toContain('Selection finished');
    expect(buttonByText('Continue from here')).not.toBeNull();
    expect(buttonByText('Replay')).not.toBeNull();
    expect(playerMock.calls[0]?.stops).toBe(0);
  });

  it('replays the same selection', async () => {
    await db.books.put(makeListBook(['One.', 'Two.', 'Three.']));
    await renderReader();
    await waitForEngine();
    await pick(['0-0-1']);

    await act(async () => {
      buttonByLabel('Play selection')?.click();
    });
    await waitFor(() => playerMock.calls.length === 1, 'player created');
    await act(async () => {
      playerMock.calls[0]?.onDone?.();
    });
    await act(async () => {
      buttonByText('Replay')?.click();
    });

    expect(playerMock.calls.length).toBe(2);
    expect(playerMock.calls[1]?.items.map((item) => item.id)).toEqual(['0-0-1']);
  });

  it('continues from the sentence after the selection', async () => {
    await db.books.put(makeListBook(['One.', 'Two.', 'Three.']));
    await renderReader();
    await waitForEngine();
    await pick(['0-0-0']);

    await act(async () => {
      buttonByLabel('Play selection')?.click();
    });
    await waitFor(() => playerMock.calls.length === 1, 'player created');
    await act(async () => {
      playerMock.calls[0]?.onDone?.();
    });
    await act(async () => {
      buttonByText('Continue from here')?.click();
    });

    await waitFor(() => playerMock.calls.length === 2, 'chapter playback resumed');
    expect(playerMock.calls[1]?.items.map((item) => item.id)).toEqual(['0-0-0', '0-0-1', '0-0-2']);
    expect(playerMock.calls[1]?.startIndex).toBe(1);
    expect(container.textContent).not.toContain('Selection finished');
  });

  it('plays a skipped sentence the reader picked by hand', async () => {
    const book = makeBook();
    book.parsed.chapters[0]!.blocks.push({
      id: 'b-0-1',
      kind: 'table',
      sentences: [{ id: '0-1-0', text: 'Dose: 5 mg twice daily.' }],
    });
    await db.books.put(book);
    await renderReader();
    await waitForEngine();
    await waitFor(() => sentence('0-1-0') !== null, 'table sentence rendered');
    await pick(['0-1-0']);

    await act(async () => {
      buttonByLabel('Play selection')?.click();
    });
    await waitFor(() => playerMock.calls.length === 1, 'player created');
    expect(playerMock.calls[0]?.items.map((item) => item.id)).toEqual(['0-1-0']);
  });

  it('stops a running selection instead of playing the whole chapter', async () => {
    await db.books.put(makeListBook(['One.', 'Two.', 'Three.']));
    await renderReader();
    await waitForEngine();
    await pick(['0-0-2']);

    await act(async () => {
      buttonByLabel('Play selection')?.click();
    });
    await waitFor(() => playerMock.calls.length === 1, 'player created');
    expect(container.textContent).not.toContain('Sentence 1 of 3');
    expect(container.textContent).toContain('Selection: sentence 1 of 1');
  });
});

describe('reader: the Android back key unwinds the reader', () => {
  function dialog(label: string): Element | null {
    return container.querySelector(`[role="dialog"][aria-label="${label}"]`);
  }
  function selectionDialog(): Element | null {
    return container.querySelector('[role="dialog"][aria-label^="Actions for"]');
  }

  it('closes the type sheet first, then asks the app to leave the book', async () => {
    await db.books.put(makeBook());
    await renderReader();
    await waitForEngine();
    const navigate = vi.fn();
    const dispose = installBackBridge(navigate, () => `/read/${BOOK_ID}`);

    try {
      await act(async () => {
        buttonByLabel('Text size and spacing')?.click();
      });
      expect(dialog('Text size and spacing')).not.toBeNull();

      await act(async () => {
        window.__pharmaBack?.();
      });
      expect(dialog('Text size and spacing')).toBeNull();
      expect(navigate).not.toHaveBeenCalled();

      // Nothing is open now: the press falls through to the library.
      await act(async () => {
        window.__pharmaBack?.();
      });
      expect(navigate).toHaveBeenCalledWith('/');
    } finally {
      dispose();
    }
  });

  it('closes the drawer before leaving the book', async () => {
    await db.books.put(makeBook());
    await renderReader();
    await waitForEngine();
    const navigate = vi.fn();
    const dispose = installBackBridge(navigate, () => `/read/${BOOK_ID}`);

    try {
      await act(async () => {
        buttonByLabel('Contents')?.click();
      });
      expect(dialog('Chapters, notes and topics')).not.toBeNull();

      await act(async () => {
        window.__pharmaBack?.();
      });
      expect(dialog('Chapters, notes and topics')).toBeNull();
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it('closes the selection sheet before leaving the book', async () => {
    await db.books.put(makeBook());
    await renderReader();
    await waitForEngine();
    const navigate = vi.fn();
    const dispose = installBackBridge(navigate, () => `/read/${BOOK_ID}`);

    try {
      await longPress('0-0-0');
      expect(selectionDialog()).not.toBeNull();

      await act(async () => {
        window.__pharmaBack?.();
      });
      expect(selectionDialog()).toBeNull();
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });
});

describe('reader: the Android media service', () => {
  it('starts with the book and chapter, then reflects pause', async () => {
    await db.books.put(makeBook());
    await renderReader();
    await waitForEngine();
    playbackMock.start.mockClear();
    playbackMock.setState.mockClear();

    await act(async () => {
      playButton()?.click();
    });
    await waitFor(() => playbackMock.start.mock.calls.length > 0, 'service started');
    expect(playbackMock.start).toHaveBeenCalledWith({
      title: 'Pharmacology Notes',
      subtitle: 'Kinetics',
    });

    await act(async () => {
      playButton()?.click();
    });
    await waitFor(() => playbackMock.setState.mock.calls.length > 0, 'service paused');
    expect(playbackMock.setState).toHaveBeenLastCalledWith('paused');
  });

  it('refreshes the notification when the chapter changes while playing', async () => {
    await db.books.put(makeBook());
    await renderReader();
    await waitForEngine();

    await act(async () => {
      playButton()?.click();
    });
    await waitFor(() => playerMock.calls.length === 1, 'player created');
    playbackMock.start.mockClear();

    // The chapter finishes: the reader auto-advances, so the service must now
    // name the new chapter.
    await act(async () => {
      playerMock.last()?.onDone?.();
    });
    await waitFor(
      () => playbackMock.start.mock.calls.some(([meta]) => meta.subtitle === 'Dynamics'),
      'service refreshed'
    );
  });

  it('maps notification and headset actions onto the same player', async () => {
    await db.books.put(makeBook());
    await renderReader();
    await waitForEngine();

    await act(async () => {
      playButton()?.click();
    });
    await waitFor(() => playButton()?.getAttribute('aria-label') === 'Pause', 'playing');
    expect(playbackMock.listening()).toBe(true);

    await act(async () => {
      playbackMock.send('pause');
    });
    expect(playButton()?.getAttribute('aria-label')).toBe('Resume');

    await act(async () => {
      playbackMock.send('play');
    });
    expect(playButton()?.getAttribute('aria-label')).toBe('Pause');

    await act(async () => {
      playbackMock.send('next');
    });
    await waitFor(() => playerMock.calls.length === 2, 'stepped to the next sentence');
    expect(playerMock.calls[1]?.startIndex).toBe(1);

    await act(async () => {
      playbackMock.send('stop');
    });
    expect(playButton()?.getAttribute('aria-label')).toBe('Play');
  });
});

describe('reader: continue listening', () => {
  it('records reader.lastBook so the library can offer to continue', async () => {
    await db.books.put(makeBook());
    await renderReader();
    await waitFor(async () => {
      const row = await db.settings.get('reader.lastBook');
      const value = row?.value as { bookId?: string } | undefined;
      return value?.bookId === BOOK_ID;
    }, 'last book saved');
  });

  it('starts from the restored sentence with ?play=1 and drops the parameter', async () => {
    await db.books.put(makeBook());
    await db.settings.put({ key: LAST_POS_KEY, value: { chapterId: 'ch-0', sentenceId: '0-0-1' } });
    await renderReaderAt(`/read/${BOOK_ID}?play=1`);

    await waitFor(() => playerMock.calls.length === 1, 'autoplay started');
    expect(playerMock.calls[0]?.startIndex).toBe(1);
    await waitFor(
      () => container.querySelector('[data-testid="location"]')?.textContent === '',
      'play parameter removed'
    );
  });

  it('stays paused at the saved position when autoplay is refused', async () => {
    await db.books.put(makeBook());
    await renderReaderAt(`/read/${BOOK_ID}?play=1`);
    await waitFor(() => playerMock.calls.length === 1, 'autoplay attempted');

    await act(async () => {
      playerMock.last()?.onError?.(new Error('NotAllowedError: play() failed without a gesture'));
    });

    expect(playButton()?.getAttribute('aria-label')).toBe('Play');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(readingId()).toBe('0-0-0');
  });
});

function bookChrome(): Element | null {
  return container.querySelector('.rd-bar');
}

function selectionDialog(): Element | null {
  return container.querySelector('[role="dialog"][aria-label^="Actions for"]');
}

/** Tap the blank page around the text, the way the immersive hint expects. */
async function tapBlankSpace(): Promise<void> {
  await act(async () => {
    (container.querySelector('section.page') as HTMLElement | null)?.click();
  });
}

async function enterFullscreen(): Promise<void> {
  await act(async () => {
    buttonByLabel('Full screen')?.click();
  });
  await waitFor(() => bookChrome() === null, 'full screen entered');
}

describe('reader: full-screen reading', () => {
  it('hides the bar, dock and chapter nav, asks Android, and restores on leave', async () => {
    await db.books.put(makeBook());
    await renderReader();
    await waitFor(() => sentence('0-0-0') !== null, 'first sentence');

    await enterFullscreen();

    expect(bookChrome()).toBeNull();
    expect(container.querySelector('.rd-dock')).toBeNull();
    expect(container.querySelector('.rd-chapter-nav')).toBeNull();
    // The book stays: only the chrome goes away.
    expect(sentence('0-0-0')).not.toBeNull();
    expect(systemUiMock.setImmersive).toHaveBeenLastCalledWith(true);
    // A screen reader can always reach a way out, faded or not.
    expect(buttonByLabel('Exit full screen')).not.toBeNull();
    await waitFor(
      async () => (await db.settings.get('reader.fullscreen'))?.value === true,
      'choice remembered'
    );

    await act(async () => {
      root?.unmount();
    });
    root = null;
    expect(systemUiMock.setImmersive).toHaveBeenLastCalledWith(false);
  });

  it('re-enters full screen on the next open', async () => {
    await db.books.put(makeBook());
    await db.settings.put({ key: 'reader.fullscreen', value: true });
    await renderReader();

    await waitFor(() => bookChrome() === null, 're-entered full screen');
    expect(systemUiMock.setImmersive).toHaveBeenLastCalledWith(true);
  });

  it('brings the controls back on a tap and leaves from the floating button', async () => {
    await db.books.put(makeBook());
    await renderReader();
    await waitFor(() => sentence('0-0-0') !== null, 'first sentence');
    await enterFullscreen();

    await tapBlankSpace();
    await waitFor(() => bookChrome() !== null, 'controls back');
    expect(container.querySelector('.rd-dock')).not.toBeNull();

    // A sentence tap is still a sentence tap, not a request for the controls.
    await act(async () => {
      sentence('0-0-1')?.click();
    });
    expect(readingId()).toBe('0-0-1');
    expect(bookChrome()).not.toBeNull();

    // The floating control (the last button with that label) leaves the mode.
    const exits = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Exit full screen"]')];
    await act(async () => {
      exits[exits.length - 1]?.click();
    });
    await waitFor(() => bookChrome() !== null, 'back to the normal reader');
    expect(container.querySelector('.rd-page--fullscreen')).toBeNull();
    expect(systemUiMock.setImmersive).toHaveBeenLastCalledWith(false);
  });

  it('shows the way out for a moment, then after any tap again', async () => {
    await db.books.put(makeBook());
    await renderReader();
    await waitFor(() => sentence('0-0-0') !== null, 'first sentence');
    await enterFullscreen();

    const pill = (): Element | null => container.querySelector('.rd-immersive-exit');
    expect(pill()?.className).toContain('is-shown');

    // The hint fades on its own (the pill itself stays in the tab order).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, IMMERSIVE_HINT_MS + 100));
    });
    expect(pill()?.className).not.toContain('is-shown');

    // A sentence tap still re-surfaces it, without toggling the chrome.
    await act(async () => {
      sentence('0-0-0')?.click();
    });
    expect(pill()?.className).toContain('is-shown');
    expect(bookChrome()).toBeNull();
  });

  it('steps the floating exit aside while the bars are back, so it cannot cover them', async () => {
    await db.books.put(makeBook());
    await renderReader();
    await waitFor(() => sentence('0-0-0') !== null, 'first sentence');
    await enterFullscreen();

    const pill = (): Element | null => container.querySelector('.rd-immersive-exit');
    expect(pill()?.className).toContain('is-shown');

    await tapBlankSpace();
    await waitFor(() => bookChrome() !== null, 'controls back');
    // The bar has its own exit button; two on top of each other would make the
    // text-size button next to it unhittable.
    expect(pill()?.className).not.toContain('is-shown');
  });

  it('gives the back key first refusal while full screen', async () => {
    await db.books.put(makeBook());
    await renderReader();
    await waitFor(() => sentence('0-0-0') !== null, 'first sentence');
    const navigate = vi.fn();
    const dispose = installBackBridge(navigate, () => `/read/${BOOK_ID}`);

    try {
      await enterFullscreen();

      await act(async () => {
        window.__pharmaBack?.();
      });
      await waitFor(() => bookChrome() !== null, 'back left full screen');
      expect(systemUiMock.setImmersive).toHaveBeenLastCalledWith(false);
      expect(navigate).not.toHaveBeenCalled();

      // Nothing is open now, so a second press leaves the book.
      await act(async () => {
        window.__pharmaBack?.();
      });
      expect(navigate).toHaveBeenCalledWith('/');
    } finally {
      dispose();
    }
  });
});

describe('reader: fixes around leaving, chapter jumps and paused stepping', () => {
  it('saves a move made just before the reader closes, in both places', async () => {
    await db.books.put(makeBook());
    await renderReader();
    await waitFor(() => sentence('0-0-1') !== null, 'second sentence');

    await act(async () => {
      sentence('0-0-1')?.click();
    });
    // No debounce wait: this is the "leave within 700 ms" case that used to
    // lose the position.
    await act(async () => {
      root?.unmount();
    });
    root = null;

    await waitFor(async () => (await savedPos())?.sentenceId === '0-0-1', 'setting flushed');
    expect((await db.books.get(BOOK_ID))?.lastPos).toEqual({
      chapterId: 'ch-0',
      sentenceId: '0-0-1',
    });
  });

  it('clears an open selection when the chapter changes', async () => {
    await db.books.put(makeBook());
    await renderReader();
    await waitFor(() => sentence('0-0-0') !== null, 'first sentence');

    await longPress('0-0-0');
    await waitFor(() => selectionDialog() !== null, 'selection open');

    await act(async () => {
      buttonByText('Next chapter')?.click();
    });

    expect(selectionDialog()).toBeNull();
    expect(container.querySelector('.rd-s.selected')).toBeNull();
    expect(readingId()).toBe('1-0-0');
  });

  it('steps the notification to the neighbour while paused without dropping it', async () => {
    await db.books.put(makeBook());
    await renderReader();
    await waitForEngine();

    await act(async () => {
      playButton()?.click();
    });
    await waitFor(() => playerMock.calls.length === 1, 'player created');
    await act(async () => {
      playbackMock.send('pause');
    });
    expect(playButton()?.getAttribute('aria-label')).toBe('Resume');
    playbackMock.stop.mockClear();
    playbackMock.setState.mockClear();

    await act(async () => {
      playbackMock.send('next');
    });

    // The marker moved, the old clip is gone, but the reader is still paused
    // and the service still shows the notification.
    expect(readingId()).toBe('0-0-1');
    expect(playerMock.calls[0]?.stops).toBe(1);
    expect(playButton()?.getAttribute('aria-label')).toBe('Resume');
    expect(playbackMock.stop).not.toHaveBeenCalled();
    expect(playbackMock.setState).not.toHaveBeenCalled();

    // Play starts at the neighbour rather than resuming the dropped clip.
    await act(async () => {
      playButton()?.click();
    });
    await waitFor(() => playerMock.calls.length === 2, 'play starts at the neighbour');
    expect(playerMock.calls[1]?.startIndex).toBe(1);
    expect(playButton()?.getAttribute('aria-label')).toBe('Pause');
  });

  it('writes the heavy book position when the app goes away, not when it comes back', async () => {
    await db.books.put(makeBook());
    await renderReader();
    await waitFor(() => sentence('0-0-1') !== null, 'second sentence');
    await act(async () => {
      sentence('0-0-1')?.click();
    });

    const setVisibility = (state: DocumentVisibilityState): void => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => state,
      });
    };
    try {
      // Coming back is not leaving: the record (file blob included) must not be
      // rewritten for a position that is already in settings.
      setVisibility('visible');
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect((await db.books.get(BOOK_ID))?.lastPos).toBeUndefined();

      setVisibility('hidden');
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await waitFor(
        async () => (await db.books.get(BOOK_ID))?.lastPos !== undefined,
        'book position written'
      );
    } finally {
      delete (document as unknown as { visibilityState?: unknown }).visibilityState;
    }
  });

  it('leaves full screen when the browser ends it on its own', async () => {
    await db.books.put(makeBook());
    await renderReader();
    await waitFor(() => sentence('0-0-0') !== null, 'first sentence');
    await enterFullscreen();

    // Escape, an edge swipe, the system taking the screen: the browser is out, so
    // the reader has to follow instead of staying chromeless for ever.
    await act(async () => {
      document.dispatchEvent(new Event('fullscreenchange'));
    });

    await waitFor(() => bookChrome() !== null, 'the normal reader is back');
    expect(container.querySelector('.rd-page--fullscreen')).toBeNull();
    expect((await db.settings.get('reader.fullscreen'))?.value).toBe(false);
    expect(systemUiMock.setImmersive).toHaveBeenLastCalledWith(false);
  });
});
