import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { HighlightColor } from './SelectionBar';
import SelectionBar from './SelectionBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Handler<A extends unknown[] = []> = ReturnType<typeof vi.fn<(...args: A) => void>>;

interface BarProps {
  onHighlight: Handler<[HighlightColor]>;
  onNote: Handler<[string]>;
  onBookmark: Handler;
  onCard: Handler<['qa' | 'cloze']>;
  onAi: Handler;
  onExtend: Handler;
  onClose: Handler;
}

function renderBar(overrides: Partial<BarProps> = {}): { container: HTMLDivElement; root: Root; props: BarProps } {
  const props: BarProps = {
    onHighlight: vi.fn(),
    onNote: vi.fn(),
    onBookmark: vi.fn(),
    onCard: vi.fn(),
    onAi: vi.fn(),
    onExtend: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(<SelectionBar text="Absorption is the first step." count={1} {...props} />);
  });
  return { container, root, props };
}

describe('SelectionBar', () => {
  it('focuses the toolbar and labels every action', () => {
    const { container, root } = renderBar();
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-label')).toBe('Actions for 1 selected sentence');
    expect(document.activeElement).toBe(dialog);

    const labels = [...container.querySelectorAll<HTMLButtonElement>('button')].map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual(expect.arrayContaining(['Yellow highlight', 'Green highlight', 'Blue highlight', 'Pink highlight', 'Close actions']));
    act(() => root.unmount());
  });

  it('closes on Escape', () => {
    const { container, root, props } = renderBar();
    const dialog = container.querySelector('[role="dialog"]');
    act(() => {
      dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(props.onClose).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it('reports the chosen colour and then the note', () => {
    const { container, root, props } = renderBar();

    act(() => {
      container.querySelector<HTMLButtonElement>('[aria-label="Green highlight"]')?.click();
    });
    expect(props.onHighlight).toHaveBeenCalledWith('green');

    act(() => {
      [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Note')?.click();
    });
    const note = container.querySelector<HTMLTextAreaElement>('#rd-note');
    expect(note).not.toBeNull();
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    act(() => {
      setValue?.call(note, '  remember this  ');
      note?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(props.onNote).toHaveBeenCalledWith('remember this');
    act(() => root.unmount());
  });
});
