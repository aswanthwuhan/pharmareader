import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BackupPanel from '../backup/BackupPanel';
import { db } from '../core/db';
import AiActions from './AiActions';
import AiSettings from './AiSettings';

const h = vi.hoisted(() => ({ summary: 'Aspirin blocks COX-1 in platelets.' }));

// The summary path is the one under test here; the network call is not.
vi.mock('./tasks', () => ({
  generateCards: async () => [],
  summarize: async () => h.summary,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Render-only checks: the Settings page is wired by the lead, so these two
 * components must not crash and must show the right empty state.
 */
describe('AI panels', () => {
  it('keeps the privacy line and the switch while AI is off', () => {
    const html = renderToStaticMarkup(<AiSettings />);
    expect(html).toContain('Selected text is sent to the provider you choose.');
    expect(html).toContain('Enable AI');
    expect(html).toContain('Turn AI on to choose a provider and enter a key.');
    // With AI off there is nothing to fill in yet, so none of the form is there.
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('id="ai-preset"');
    expect(html).not.toContain('>Test<');
  });

  it('explains where the key goes and keeps the endpoints in the enabled state', () => {
    const html = renderToStaticMarkup(<AiSettings />);
    expect(html).toContain('<summary>How this works</summary>');
    expect(html).toContain('stored only on this device');
    // Off means no Advanced disclosure either: the two states match.
    expect(html).not.toContain('<summary>Advanced</summary>');
    expect(html).not.toContain('id="ai-base-url"');
    expect(html).not.toContain('id="ai-model"');
  });

  it('explains that AI is off and disables the actions', () => {
    const html = renderToStaticMarkup(
      <AiActions text="Aspirin inhibits COX-1." onClose={() => {}} />,
    );
    expect(html).toContain('Turn on AI in Settings');
    expect(html).toContain('disabled');
    expect(html).toContain('Make cards');
    expect(html).toContain('Summarize');
  });
});

describe('backup panel', () => {
  it('says the API key never travels in a backup', () => {
    const html = renderToStaticMarkup(<BackupPanel />);
    expect(html).toContain('API key are never written into a backup');
  });

  it('spells out what replace deletes', () => {
    const html = renderToStaticMarkup(<BackupPanel />);
    expect(html).toContain('pronunciations and settings first');
  });
});

/**
 * The Copy button. Safari rejects `navigator.clipboard.writeText` once the click
 * gesture has expired, so the legacy path must be what saves a summary that took
 * a long await to make — and a real failure must still be reported.
 */
describe('AiActions copy', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = null;
    }
    container?.remove();
    container = null;
    delete (document as { execCommand?: unknown }).execCommand;
    delete (navigator as { clipboard?: unknown }).clipboard;
    await db.settings.clear();
  });

  function button(label: string): HTMLButtonElement | undefined {
    return [...(container?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (found) => found.textContent?.trim() === label,
    );
  }

  async function waitFor(check: () => boolean, label: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (check()) return;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  /** Mount with AI on, build the summary, then press Copy. */
  async function copyTheSummary(): Promise<void> {
    await db.settings.put({ key: 'ai.enabled', value: true });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<AiActions text="Aspirin inhibits COX-1." onClose={() => {}} />);
    });
    await waitFor(() => button('Summarize')?.disabled === false, 'AI to be on');

    await act(async () => {
      button('Summarize')?.click();
    });
    await waitFor(() => button('Copy') !== undefined, 'the summary');

    await act(async () => {
      button('Copy')?.click();
    });
    await waitFor(
      () => button('Copied') !== undefined || container?.textContent?.includes('Could not copy') === true,
      'the copy result',
    );
  }

  it('falls back to the legacy copy when the browser rejects the clipboard', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('NotAllowedError');
    });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });

    await copyTheSummary();

    expect(writeText).toHaveBeenCalledWith(h.summary);
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(button('Copied')).toBeTruthy();
    expect(container?.textContent).not.toContain('Could not copy');
  });

  it('reports a failure only when both paths fail', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });

    await copyTheSummary();

    expect(container?.textContent).toContain('Could not copy');
  });
});
