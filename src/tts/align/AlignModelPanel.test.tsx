// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDownload } from '../downloads';
import AlignModelPanel, { WHISPER_DOWNLOAD_ID } from './AlignModelPanel';

/** The aligner's worker client, replaced by a scriptable stand-in. */
const whisper = vi.hoisted(() => ({
  available: false,
  support: true,
  fail: false,
  prepares: 0,
}));

vi.mock('./whisper', () => ({
  hasWhisperSupport: () => whisper.support,
  isWhisperAvailable: () => Promise.resolve(whisper.available),
  isWhisperLoaded: () => false,
  prepareWhisper: () => {
    whisper.prepares++;
    return whisper.fail ? Promise.reject(new Error('Failed to fetch')) : Promise.resolve();
  },
  resetWhisperWorker: () => undefined,
  deleteWhisperModel: () => Promise.resolve(),
  measureWhisper: () => Promise.reject(new Error('no clip')),
}));

vi.mock('../neural/clipboard', () => ({ copyText: () => Promise.resolve(true) }));

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  whisper.available = false;
  whisper.support = true;
  whisper.fail = false;
  whisper.prepares = 0;
  resetDownload(WHISPER_DOWNLOAD_ID);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
});

async function renderPanel(): Promise<string> {
  await act(async () => {
    root!.render(createElement(AlignModelPanel));
    // Let the "is it downloaded?" effect (Dexie + Cache Storage) settle.
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container.textContent ?? '';
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((element) => element.textContent === label);
}

describe('AlignModelPanel', () => {
  it('offers the download and says what it buys', async () => {
    const text = await renderPanel();

    expect(text).toContain('Word-by-word highlighting');
    expect(text).toContain('~42 MB');
    expect(text).toContain('Not downloaded');
    // The estimate keeps working without it — say so instead of hiding the card.
    expect(text).toContain('estimate from each word');
    expect(button('Download')?.disabled).toBe(false);
    // The row's actions are secondary: teal is the screen's one primary action.
    expect(button('Download')?.classList.contains('btn-secondary')).toBe(true);
    expect(container.querySelectorAll('.btn-primary')).toHaveLength(0);
    // One disclosure per model: the controls and the explanation share a row.
    const summaries = [...container.querySelectorAll('details.disc-sub > summary')].map(
      (summary) => summary.textContent
    );
    expect(summaries).toEqual(['Details']);
    // The qualifier has its own muted line, so it carries no separator dot.
    expect(text).toContain('on-device Whisper, English');
    expect(text).not.toContain('· on-device');
    expect(button('Delete')).toBeUndefined();
    // Nothing is installed, so measuring would silently download 42 MB.
    expect(button('Measure speed')?.disabled).toBe(true);
  });

  it('downloads when asked and reports Ready', async () => {
    await renderPanel();

    await act(async () => {
      button('Download')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(whisper.prepares).toBe(1);
    const text = container.textContent ?? '';
    expect(text).toContain('Ready');
    expect(button('Download')).toBeUndefined();
    expect(button('Delete')?.disabled).toBe(false);
    expect(button('Measure speed')?.disabled).toBe(false);
  });

  it('shows the failure with the step it happened in', async () => {
    whisper.fail = true;
    await renderPanel();

    await act(async () => {
      button('Download')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const text = container.textContent ?? '';
    expect(text).toContain('Failed while');
    expect(text).toContain('Failed to fetch');
    // A failed attempt may have left partial files behind, so Delete stays offered.
    expect(button('Delete')).toBeDefined();
  });

  it('says so where the aligner cannot run at all', async () => {
    whisper.support = false;
    const text = await renderPanel();

    expect(text).toContain('Not available here');
    expect(text).toContain('words are highlighted by an estimate');
    expect(button('Download')).toBeUndefined();
  });
});
