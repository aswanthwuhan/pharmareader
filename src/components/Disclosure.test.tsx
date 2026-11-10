import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Disclosure from './Disclosure';

// React 19 keeps act() warnings quiet only when this flag is set.
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  document.body.innerHTML = '';
});

function Harness({ onToggle }: { onToggle: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Disclosure
      id="demo"
      title="Demo row"
      summary="One line"
      open={open}
      onToggle={() => {
        onToggle();
        setOpen((value) => !value);
      }}
    >
      <p>Panel contents</p>
    </Disclosure>
  );
}

describe('Disclosure', () => {
  const closed = renderToStaticMarkup(
    <Disclosure id="demo" title="Demo row" summary="One line" open={false} onToggle={() => undefined}>
      <p>Panel contents</p>
    </Disclosure>,
  );

  it('keeps the body mounted and hidden while closed', () => {
    expect(closed).toContain('id="demo"');
    expect(closed).toContain('aria-labelledby="demo-h2"');
    expect(closed).toContain('<div class="disc-body" id="demo-body" hidden="">');
    expect(closed).toContain('Panel contents');
  });

  it('points the heading button at its body and starts collapsed', () => {
    expect(closed).toContain('id="demo-h2"');
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).toContain('aria-controls="demo-body"');
    expect(closed).toContain('stroke-width="1.7"');
  });

  it('shows the title and the one-line summary on the row', () => {
    expect(closed).toContain('Demo row');
    expect(closed).toContain('One line');
  });

  it('toggles aria-expanded, reveals the body and fires onToggle', async () => {
    const onToggle = vi.fn();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<Harness onToggle={onToggle} />));

    const button = container.querySelector<HTMLButtonElement>('.disc-head');
    const body = container.querySelector<HTMLElement>('.disc-body');
    expect(button).not.toBeNull();
    expect(body).not.toBeNull();
    expect(button!.getAttribute('aria-expanded')).toBe('false');
    expect(body!.hidden).toBe(true);

    await act(async () => {
      button!.click();
    });

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(button!.getAttribute('aria-expanded')).toBe('true');
    expect(body!.hidden).toBe(false);
    expect(body!.textContent).toContain('Panel contents');
  });
});
