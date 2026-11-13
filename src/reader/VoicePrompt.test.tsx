import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../core/db';
import { getSetting } from '../core/settings';
import { resetDownload, startDownload } from '../tts/downloads';
import VoicePrompt from './VoicePrompt';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const offer = vi.hoisted(() => ({ start: vi.fn<() => Promise<void>>() }));
// The real module keeps the copy in one place; only the download is replaced.
vi.mock('../tts/kokoroOffer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tts/kokoroOffer')>();
  return { ...actual, startKokoroDownload: offer.start };
});

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const DESKTOP_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function useUserAgent(userAgent: string): void {
  Object.defineProperty(navigator, 'userAgent', { value: userAgent, configurable: true });
}

let container: HTMLDivElement;
let root: Root | null = null;
const onClose = vi.fn();

async function mount(open = true): Promise<void> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<VoicePrompt open={open} onClose={onClose} />);
  });
}

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

function buttonWithText(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((b) => b.textContent === text);
}

beforeEach(() => {
  onClose.mockClear();
  offer.start.mockReset();
  resetDownload('kokoro');
  useUserAgent(DESKTOP_UA);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  container.remove();
  resetDownload('kokoro');
  await flush(10);
  await db.delete();
  await db.open();
});

describe('VoicePrompt', () => {
  it('explains the offer with the size from the code and a way out', async () => {
    await mount();

    const sheet = container.querySelector('[role="dialog"]');
    expect(sheet).not.toBeNull();
    expect(sheet!.textContent).toContain('Kokoro is a higher quality voice than the phone voice');
    expect(sheet!.textContent).toContain('Download it once (320 MB)');
    expect(sheet!.textContent).toContain(
      'Every downloadable voice is listed and can be tested in Settings → On-device voice models.'
    );
    expect(buttonWithText('Download Kokoro')).toBeDefined();
    expect(buttonWithText('Not now')).toBeDefined();

    await act(async () => {
      buttonWithText('Not now')!.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows progress with a text value and closes without cancelling the download', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    offer.start.mockImplementation(() =>
      startDownload('kokoro', async (report) => {
        report({ fraction: 0.42 });
        await gate;
      })
    );
    await mount();

    await act(async () => {
      buttonWithText('Download Kokoro')!.click();
    });
    await waitFor(() => container.textContent?.includes('Downloading Kokoro — 42%') === true);

    const bar = container.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('42');
    expect(container.textContent).toContain('You can close this and keep reading');

    await act(async () => {
      buttonWithText('Close')!.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    finish();
    await flush(10);
  });

  it('switches the engine to Kokoro when the download finishes', async () => {
    offer.start.mockImplementation(() =>
      startDownload('kokoro', async () => {
        // The real path prepares the model here; the sheet only watches `done`.
      })
    );
    await mount();

    await act(async () => {
      buttonWithText('Download Kokoro')!.click();
    });
    await waitFor(() => container.textContent?.includes('Kokoro is ready') === true, 4000);

    expect(await getSetting('tts.engine', 'auto')).toBe('kokoro');
    expect(container.textContent).toContain('It will read from here');
  });

  it('keeps the phone voice when the download fails and offers a retry', async () => {
    offer.start.mockImplementation(() =>
      startDownload('kokoro', async () => {
        throw new Error('The connection dropped.');
      })
    );
    await mount();

    await act(async () => {
      buttonWithText('Download Kokoro')!.click();
    });
    await waitFor(() => container.textContent?.includes('Kokoro didn’t finish downloading') === true);

    expect(container.textContent).toContain('The connection dropped.');
    expect(container.textContent).toContain('The phone voice is still reading your book');
    expect(await getSetting('tts.engine', 'auto')).toBe('auto');
    expect(buttonWithText('Retry')).toBeDefined();

    await act(async () => {
      buttonWithText('Retry')!.click();
    });
    expect(offer.start).toHaveBeenCalledTimes(2);
  });

  it('adds the iPhone line about the phone voice, above the buttons', async () => {
    useUserAgent(IPHONE_UA);
    await mount();

    const sheet = container.querySelector('[role="dialog"]')!;
    expect(sheet.textContent).toContain(
      'The phone voice may not start on iPhone and iPad, so Kokoro is recommended.'
    );
    // Above the buttons, and inside the sheet's own copy.
    const line = sheet.querySelector('.voice-prompt-ios');
    const actions = sheet.querySelector('.voice-prompt-actions');
    expect(line).not.toBeNull();
    expect(actions).not.toBeNull();
    expect(
      line!.compareDocumentPosition(actions!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('keeps the sheet copy unchanged away from iOS', async () => {
    await mount();

    expect(container.querySelector('.voice-prompt-ios')).toBeNull();
  });
});

