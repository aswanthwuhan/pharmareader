import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../core/db';
import TopicPicker from './TopicPicker';
import { ensureSyllabusSeeded } from './seed';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;

// Let Dexie's liveQuery deliver the seeded topics and React commit the update.
const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
};

beforeEach(async () => {
  await db.delete();
  await db.open();
  await ensureSyllabusSeeded();
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
    root = null;
  }
  container.remove();
  await db.delete();
  await db.open();
});

describe('TopicPicker', () => {
  it('opens the domain list on focus and toggles a topic with Enter', async () => {
    const onChange = vi.fn();
    root = createRoot(container);
    await act(async () => {
      root!.render(<TopicPicker value={[]} onChange={onChange} />);
    });
    await flush();

    const input = container.querySelector<HTMLInputElement>('input[role="combobox"]');
    expect(input).not.toBeNull();
    expect(input!.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).toContain('Topics');

    await act(async () => input!.focus());
    await flush();
    expect(input!.getAttribute('aria-expanded')).toBe('true');

    const options = container.querySelectorAll('[role="option"]');
    expect(options).toHaveLength(26);

    await act(async () => {
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    const chosen = onChange.mock.calls[0][0] as string[];
    expect(chosen).toHaveLength(1);
    const active = input!.getAttribute('aria-activedescendant') ?? '';
    expect(active.endsWith(`-opt-${chosen[0]}`)).toBe(true);
  });

  it('opens on the first row when ArrowDown is pressed while closed', async () => {
    const onChange = vi.fn();
    root = createRoot(container);
    await act(async () => {
      root!.render(<TopicPicker value={[]} onChange={onChange} />);
    });
    await flush();

    const input = container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    expect(input.getAttribute('aria-expanded')).toBe('false');

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    await flush();

    expect(input.getAttribute('aria-expanded')).toBe('true');
    const first = container.querySelector('[role="option"]');
    expect(first?.textContent).toContain('General Pharmacology');
    expect(input.getAttribute('aria-activedescendant')).toBe(first?.id);
  });

  it('matches descendants when the query names a parent domain', async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(<TopicPicker value={[]} onChange={() => {}} />);
    });
    await flush();

    const input = container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(input, 'Pharmacy Practice');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();

    const text = container.textContent ?? '';
    expect(text).toContain('Dispensing & Pharmaceutical Calculations');
    expect(text).toContain('Drugs & Therapeutics Committee');
    expect(text).not.toContain('Antihypertensives');
  });

  it('shows chosen topics as removable chips', async () => {
    const onChange = vi.fn();
    root = createRoot(container);
    await act(async () => {
      root!.render(<TopicPicker value={['cvs-antihypertensives']} onChange={onChange} />);
    });
    await flush();

    const chip = container.querySelector('.tp-chip');
    expect(chip?.textContent).toContain('Antihypertensives');

    await act(async () => {
      chip!.querySelector('button')!.click();
    });
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
