import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './clipboard';

const realNavigator = navigator;

function setClipboard(writeText: ((text: string) => Promise<void>) | undefined) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  });
}

afterEach(() => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: realNavigator.clipboard });
  Reflect.deleteProperty(document, 'execCommand');
  vi.restoreAllMocks();
});

describe('copyText', () => {
  it('uses the Clipboard API when it works', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);

    await expect(copyText('engine: pocket')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('engine: pocket');
  });

  it('falls back to a temporary textarea when the Clipboard API refuses', async () => {
    setClipboard(vi.fn().mockRejectedValue(new Error('NotAllowedError')));
    const exec = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: exec });

    await expect(copyText('stage: downloading model files')).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('reports failure instead of claiming a copy', async () => {
    setClipboard(undefined);
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn().mockReturnValue(false),
    });

    await expect(copyText('details')).resolves.toBe(false);
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('survives a WebView without document.execCommand', async () => {
    setClipboard(undefined);

    await expect(copyText('details')).resolves.toBe(false);
  });
});
