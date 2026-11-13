import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installBackBridge } from '../core/backButton';
import { db } from '../core/db';
import { getSetting, setSetting } from '../core/settings';
import { resetDownload, startDownload } from '../tts/downloads';
import PlayerBar from './PlayerBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The Kokoro offer behind the pill and the first-Play prompt. */
const kokoroOffer = vi.hoisted(() => ({
  canRun: true,
  ready: false,
  prompted: false,
  mark: vi.fn(),
}));
vi.mock('../tts/kokoroOffer', () => ({
  canRunKokoro: () => kokoroOffer.canRun,
  kokoroIsReady: async () => kokoroOffer.ready,
  wasKokoroPrompted: async () => kokoroOffer.prompted,
  markKokoroPrompted: async () => {
    kokoroOffer.prompted = true;
    kokoroOffer.mark();
  },
}));
// The sheet itself is covered by VoicePrompt.test.tsx; here only its presence matters.
vi.mock('./VoicePrompt', () => ({
  default: ({ open }: { open: boolean }) =>
    open ? <div data-testid="voice-prompt" /> : null,
}));

let container: HTMLDivElement;
let root: Root | null = null;

function makeProps(overrides: Partial<Parameters<typeof PlayerBar>[0]> = {}) {
  return {
    state: 'playing' as const,
    engineName: 'Phone voice',
    fallback: false,
    rate: 1,
    canPrerender: true,
    progress: null,
    cached: false,
    sentenceNumber: 1,
    sentenceTotal: 5,
    generating: null,
    readyAhead: 0,
    pages: null,
    fromHere: false,
    selection: null,
    onToggle: vi.fn(),
    onStop: vi.fn(),
    onPrev: vi.fn(),
    onNext: vi.fn(),
    onRate: vi.fn(),
    onPrerender: vi.fn(),
    onPrerenderMore: vi.fn(),
    onCancelPrerender: vi.fn(),
    onPlayFromHere: vi.fn(),
    onSleepEnd: vi.fn(),
    onSleepAtChapterEndChange: vi.fn(),
    ...overrides,
  };
}

async function renderBar(props: ReturnType<typeof makeProps>): Promise<void> {
  await act(async () => {
    root?.render(
      <MemoryRouter>
        <PlayerBar {...props} />
      </MemoryRouter>
    );
  });
}

function buttonByLabel(label: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
}

function noteText(): string {
  return container.querySelector('.rd-sleep-note')?.textContent?.trim() ?? '';
}

function pressed(label: string): boolean {
  return buttonByLabel(label)?.getAttribute('aria-pressed') === 'true';
}

/** The popovers stay mounted; `hidden` is what actually closes them. */
function popoversHidden(): boolean {
  const pop = container.querySelector('.rd-pop');
  return pop === null ? true : pop.hasAttribute('hidden');
}

async function choose(label: string): Promise<void> {
  await act(async () => {
    buttonByLabel(label)?.click();
  });
}

/** The bar re-checks on a 15 s tick; advance far enough to fire it. */
async function tick(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(async () => {
  // Fake timers (used by the sleep-timer tests) can leave the IndexedDB connection
  // mid-open; reopen it so setting reads and writes resolve on real scheduling.
  if (db.isOpen()) db.close();
  await db.open();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  kokoroOffer.canRun = true;
  kokoroOffer.ready = false;
  kokoroOffer.prompted = false;
  kokoroOffer.mark.mockClear();
  resetDownload('kokoro');
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
    });
    root = null;
  }
  container.remove();
  resetDownload('kokoro');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function waitFor(check: () => boolean, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check() && Date.now() < deadline) {
    await flush(20);
  }
}

describe('PlayerBar sleep timer', () => {
  it('pauses the voice when the timer runs out and clears itself', async () => {
    vi.useFakeTimers();
    const props = makeProps();
    await renderBar(props);

    await choose('Sleep timer 10 minutes');
    expect(pressed('Sleep timer 10 minutes')).toBe(true);
    expect(noteText()).toBe('Pauses in 10 minutes');

    await tick(10 * 60_000);

    expect(props.onSleepEnd).toHaveBeenCalledTimes(1);
    expect(pressed('Sleep timer off')).toBe(true);
    expect(noteText()).toBe('');
  });

  it('shows the minutes left as the timer runs down', async () => {
    vi.useFakeTimers();
    const props = makeProps();
    await renderBar(props);

    await choose('Sleep timer 20 minutes');
    expect(noteText()).toBe('Pauses in 20 minutes');

    await tick(5 * 60_000);
    expect(noteText()).toBe('Pauses in 15 minutes');

    await tick(14 * 60_000);
    expect(props.onSleepEnd).not.toHaveBeenCalled();
    expect(noteText()).toBe('Pauses in 1 minute');

    await tick(60_000);
    expect(props.onSleepEnd).toHaveBeenCalledTimes(1);
  });

  it('"End of chapter" arms the reader once and spends itself on the next stop', async () => {
    const props = makeProps();
    await renderBar(props);

    await choose('Sleep timer end of chapter');
    expect(props.onSleepAtChapterEndChange).toHaveBeenLastCalledWith(true);
    expect(noteText()).toBe('Pauses at the end of this chapter');

    // The chapter ends: the bar goes idle and the one-shot choice is spent.
    await renderBar({ ...props, state: 'idle' });
    expect(props.onSleepAtChapterEndChange).toHaveBeenLastCalledWith(false);
    expect(pressed('Sleep timer off')).toBe(true);
  });

  it('Off cancels a running timer', async () => {
    vi.useFakeTimers();
    const props = makeProps();
    await renderBar(props);

    await choose('Sleep timer 30 minutes');
    await choose('Sleep timer off');
    expect(noteText()).toBe('');
    expect(pressed('Sleep timer off')).toBe(true);

    await tick(31 * 60_000);
    expect(props.onSleepEnd).not.toHaveBeenCalled();
  });

  it('offers every choice from the playback options sheet', async () => {
    const props = makeProps();
    await renderBar(props);

    await act(async () => {
      buttonByLabel('Playback options')?.click();
    });

    expect(container.textContent).toContain('Sleep timer');
    for (const label of [
      'Sleep timer off',
      'Sleep timer 10 minutes',
      'Sleep timer 20 minutes',
      'Sleep timer 30 minutes',
      'Sleep timer end of chapter',
    ]) {
      expect(buttonByLabel(label)).not.toBeNull();
    }
  });

  it('keeps "End of chapter" armed when a picked passage finishes first', async () => {
    const selection = { at: 1, total: 3, done: false, onContinue: vi.fn(), onReplay: vi.fn() };
    const props = makeProps({ state: 'playing', selection });
    await renderBar(props);

    await choose('Sleep timer end of chapter');
    expect(props.onSleepAtChapterEndChange).toHaveBeenLastCalledWith(true);

    // The passage is over (the bar goes idle) but the chapter is not.
    await renderBar({ ...props, state: 'idle', selection: { ...selection, at: 3, done: true } });
    expect(props.onSleepAtChapterEndChange).toHaveBeenCalledTimes(1);
    expect(pressed('Sleep timer end of chapter')).toBe(true);

    // "Continue from here" then plays to the chapter end, which spends it.
    await renderBar({ ...props, state: 'playing', selection: null });
    await renderBar({ ...props, state: 'idle', selection: null });
    expect(props.onSleepAtChapterEndChange).toHaveBeenLastCalledWith(false);
    expect(pressed('Sleep timer off')).toBe(true);
  });
});

describe('PlayerBar and the Android back key', () => {
  it('closes the open popover instead of leaving the book', async () => {
    const navigate = vi.fn();
    const dispose = installBackBridge(navigate, () => '/read/book-1');
    try {
      const props = makeProps();
      await renderBar(props);
      await act(async () => {
        buttonByLabel('Playback options')?.click();
      });
      expect(popoversHidden()).toBe(false);

      let handled = false;
      await act(async () => {
        handled = window.__pharmaBack?.() ?? false;
      });
      expect(handled).toBe(true);
      expect(navigate).not.toHaveBeenCalled();
      expect(popoversHidden()).toBe(true);

      // Nothing of the bar's own is open now, so the press must reach the book.
      await act(async () => {
        handled = window.__pharmaBack?.() ?? false;
      });
      expect(handled).toBe(true);
      expect(navigate).toHaveBeenCalledWith('/');
    } finally {
      dispose();
    }
  });
});

describe('PlayerBar saved audio', () => {
  function popButton(text: string): HTMLButtonElement | null {
    return (
      [...container.querySelectorAll<HTMLButtonElement>('.rd-pop button')].find(
        (candidate) => (candidate.textContent ?? '').trim() === text,
      ) ?? null
    );
  }

  async function openMenu(): Promise<void> {
    await act(async () => {
      buttonByLabel('Playback options')?.click();
    });
  }

  it('offers both save actions only when the voice can pre-render', async () => {
    await renderBar(makeProps({ canPrerender: false }));
    await openMenu();
    expect(popButton('Save chapter audio')).toBeNull();
    expect(popButton('Save audio for more…')).toBeNull();

    await renderBar(makeProps());
    await openMenu();
    expect(popButton('Save chapter audio')).not.toBeNull();
    expect(popButton('Save audio for more…')).not.toBeNull();
  });

  it('closes the menu and asks for the queue', async () => {
    const props = makeProps();
    await renderBar(props);
    await openMenu();

    await act(async () => {
      popButton('Save audio for more…')?.click();
    });

    expect(props.onPrerenderMore).toHaveBeenCalledTimes(1);
    expect(popoversHidden()).toBe(true);
  });

  it('keeps the single-chapter labels and line', async () => {
    await renderBar(makeProps({ progress: { done: 3, total: 9 } }));
    await openMenu();
    expect(popButton('Cancel')).not.toBeNull();
    expect(container.textContent).toContain('Saving chapter audio 3 of 9');

    await renderBar(makeProps({ cached: true }));
    await openMenu();
    expect(popButton('Save this chapter again')).not.toBeNull();
  });

  it('shows a queue line in the same slot and cancels it', async () => {
    const props = makeProps({
      progress: { done: 14, total: 120, status: 'Saving chapter 2 of 5 — 14 of 120 sentences' },
    });
    await renderBar(props);
    await openMenu();

    expect(container.textContent).toContain('Saving chapter 2 of 5 — 14 of 120 sentences');
    // While a queue runs the menu cannot start a second one.
    expect(popButton('Save chapter audio')).toBeNull();

    await act(async () => {
      popButton('Cancel')?.click();
    });
    expect(props.onCancelPrerender).toHaveBeenCalledTimes(1);
  });
});

describe('PlayerBar voice pill', () => {
  it('opens the Kokoro offer in place of the Settings link while the phone voice reads', async () => {
    await setSetting('tts.engine', 'auto');
    await renderBar(makeProps({ state: 'paused', engineId: 'system' }));

    const pill = container.querySelector('.rd-engine');
    expect(pill?.tagName).toBe('BUTTON');
    expect(pill?.classList.contains('rd-engine--phone')).toBe(true);
    expect(pill?.getAttribute('data-engine-state')).toBe('phone');
    expect(pill?.textContent).toContain('Phone voice');
    expect(pill?.querySelector('.rd-engine-glyph')).not.toBeNull();

    await act(async () => {
      (pill as HTMLButtonElement).click();
    });
    expect(container.querySelector('[data-testid="voice-prompt"]')).not.toBeNull();
  });

  it('keeps the Settings voice link when Kokoro is reading', async () => {
    await renderBar(makeProps({ state: 'paused', engineId: 'kokoro', engineName: 'Kokoro' }));

    const pill = container.querySelector('a.rd-engine');
    expect(pill?.getAttribute('href')).toBe('/settings#voice-models');
    expect(pill?.classList.contains('rd-engine--phone')).toBe(false);
    expect(pill?.textContent).toContain('Kokoro');
  });

  it('shows the download progress in the pill and opens the sheet', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const task = startDownload('kokoro', async (report) => {
      report({ fraction: 0.42 });
      await gate;
    });
    await renderBar(makeProps({ state: 'paused', engineId: 'system' }));

    const pill = container.querySelector('.rd-engine');
    await waitFor(() => pill?.textContent?.includes('Kokoro · 42%') === true);
    expect(pill?.getAttribute('data-engine-state')).toBe('downloading');
    expect(pill?.getAttribute('aria-label')).toContain('Kokoro download 42%');

    await act(async () => {
      (pill as HTMLButtonElement).click();
    });
    expect(container.querySelector('[data-testid="voice-prompt"]')).not.toBeNull();

    finish();
    await task;
  });

  it('asks for Kokoro on the first Play with the phone voice, and only once', async () => {
    await setSetting('tts.engine', 'auto');
    const props = makeProps({ state: 'playing', engineId: 'system' });
    await renderBar(props);

    await waitFor(() => container.querySelector('[data-testid="voice-prompt"]') !== null);
    expect(kokoroOffer.mark).toHaveBeenCalledTimes(1);
    expect(kokoroOffer.prompted).toBe(true);

    await act(async () => {
      root?.unmount();
    });
    root = createRoot(container);
    await renderBar(props);
    await flush(60);
    expect(container.querySelector('[data-testid="voice-prompt"]')).toBeNull();
    expect(kokoroOffer.mark).toHaveBeenCalledTimes(1);
  });

  it('does not ask when the reader already chose the phone voice', async () => {
    await setSetting('tts.engine', 'system');
    try {
      await renderBar(makeProps({ state: 'playing', engineId: 'system' }));
      await flush(80);
      expect(container.querySelector('[data-testid="voice-prompt"]')).toBeNull();
      expect(kokoroOffer.mark).not.toHaveBeenCalled();
    } finally {
      await setSetting('tts.engine', 'auto');
    }
  });

  it('does not ask when Kokoro cannot run on this device', async () => {
    kokoroOffer.canRun = false;
    await setSetting('tts.engine', 'auto');
    await renderBar(makeProps({ state: 'playing', engineId: 'system' }));
    await flush(80);

    expect(container.querySelector('[data-testid="voice-prompt"]')).toBeNull();
    // The pill also stays a Settings link, so nothing promises a download here.
    const pill = container.querySelector('a.rd-engine.rd-engine--phone');
    expect(pill?.getAttribute('data-engine-state')).toBe('phone');
    expect(await getSetting('tts.engine', 'auto')).toBe('auto');
  });
});


