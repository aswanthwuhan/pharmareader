import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installBackBridge } from '../core/backButton';
import PlayerBar from './PlayerBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

beforeEach(() => {
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
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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
