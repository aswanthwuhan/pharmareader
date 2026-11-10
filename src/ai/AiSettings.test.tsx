import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../core/db';
import AiSettings from './AiSettings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function render(): Promise<void> {
  await act(async () => {
    root?.render(<AiSettings />);
  });
  await waitFor(() => container.querySelector('#ai-enabled') !== null, 'settings rendered');
}

beforeEach(async () => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await db.settings.clear();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container.remove();
  await db.settings.clear();
});

describe('AI settings', () => {
  it('keeps the provider, the key and the test action out of the way while AI is off', async () => {
    await render();
    const toggle = container.querySelector<HTMLInputElement>('#ai-enabled')!;
    expect(toggle.checked).toBe(false);
    expect(container.querySelector('#ai-preset')).toBeNull();
    expect(container.querySelector('#ai-key')).toBeNull();
    expect(container.querySelector('.ai-off-hint')?.textContent).toBe(
      'Turn AI on to choose a provider and enter a key.',
    );
  });

  it('shows the provider preset, the key field and the test action once AI is on', async () => {
    await db.settings.put({ key: 'ai.enabled', value: true });
    await render();
    await waitFor(() => container.querySelector('#ai-key') !== null, 'key field');
    const toggle = container.querySelector<HTMLInputElement>('#ai-enabled')!;
    expect(toggle.checked).toBe(true);
    const preset = container.querySelector<HTMLSelectElement>('#ai-preset')!;
    expect(preset.value).toBe('openai');
    expect(container.querySelectorAll('#ai-preset option')).toHaveLength(5);
    expect(container.querySelector('#ai-key')?.getAttribute('type')).toBe('password');
    expect(
      Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Test'),
    ).toBe(true);
  });
});
