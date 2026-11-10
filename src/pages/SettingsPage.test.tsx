import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import packageJson from '../../package.json';
import SettingsPage, { scrollToHash } from './SettingsPage';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const REPO_URL = 'https://github.com/aswanthwuhan/pharmareader';

/** The ids in the order the test has always asserted them. */
const SECTION_IDS = ['voice', 'voice-models', 'pronunciation', 'cached-audio', 'storage', 'ai', 'backup', 'about'];

/** Every row of the index, in document order. */
const ROW_IDS = [
  'voice',
  'reading',
  'voice-models',
  'pdf-layout',
  'pronunciation',
  'cached-audio',
  'storage',
  'ai',
  'backup',
  'about',
];

const SECTION_TITLES = [
  'Voice',
  'Reading aloud',
  'On-device voice models',
  'PDF layout',
  'Pronunciation',
  'Cached audio',
  'Storage',
  'AI (bring your own key)',
  'Backup',
  'About',
];

const html = renderToStaticMarkup(<SettingsPage />);

/** The static page as a DOM, for the assertions that are easier that way. */
function parse(source: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = source;
  return host;
}

const page = parse(html);

function flush(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function settle(ms = 20): Promise<void> {
  await act(async () => {
    await flush(ms);
  });
}

let live: { host: HTMLElement; root: Root } | null = null;

async function mountPage(): Promise<{ host: HTMLElement; root: Root }> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<SettingsPage />);
  });
  await settle();
  live = { host, root };
  return { host, root };
}

function row(host: HTMLElement, id: string): HTMLElement {
  const section = host.querySelector<HTMLElement>(`#${id}`);
  if (!section) throw new Error(`no row #${id}`);
  return section;
}

function head(host: HTMLElement, id: string): HTMLButtonElement {
  const button = row(host, id).querySelector<HTMLButtonElement>('.disc-head');
  if (!button) throw new Error(`no button in #${id}`);
  return button;
}

function body(host: HTMLElement, id: string): HTMLElement {
  const element = row(host, id).querySelector<HTMLElement>('.disc-body');
  if (!element) throw new Error(`no body in #${id}`);
  return element;
}

async function press(host: HTMLElement, id: string): Promise<void> {
  await act(async () => {
    head(host, id).click();
  });
}

afterEach(async () => {
  if (live) {
    const { root } = live;
    live = null;
    await act(async () => root.unmount());
  }
  document.body.innerHTML = '';
  window.history.replaceState(null, '', window.location.pathname);
});

describe('SettingsPage', () => {
  it('renders one page heading', () => {
    expect(html.match(/<h1\b/g)?.length).toBe(1);
  });

  it('puts the section ids in the order the section list uses', () => {
    const positions = SECTION_IDS.map((id) => html.indexOf(`id="${id}"`));
    expect(positions).not.toContain(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('gives every row a heading with its title, in order', () => {
    const headings = [...page.querySelectorAll<HTMLElement>('h2.disc-h .disc-title')].map(
      (title) => title.textContent,
    );
    expect(headings).toEqual(SECTION_TITLES);
  });

  it('renders the index rows as disclosure sections', () => {
    const rows = [...page.querySelectorAll<HTMLElement>('section.disc')];
    expect(rows.map((section) => section.id)).toEqual(ROW_IDS);
    for (const section of rows) {
      expect(section.getAttribute('aria-labelledby')).toBe(`${section.id}-h2`);
      // The heading must contain the button: the whole row is the tap target.
      expect(section.querySelector(`#${section.id}-h2 .disc-head`)).not.toBeNull();
      expect(section.querySelector('.disc-head')?.getAttribute('aria-controls')).toBe(`${section.id}-body`);
    }
    // The panel no longer renders its own section, so no id appears twice.
    for (const id of ROW_IDS) {
      expect(page.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
    }
  });

  it('names the version, licence and credits in About', () => {
    expect(html).toContain(packageJson.version);
    expect(html).toContain('GNU GPL-3.0');

    for (const credit of ['Pocket TTS', 'Kyutai', 'Kokoro-82M', 'hexgrad', 'sherpa-onnx', 'espeak-ng', 'Literata']) {
      expect(html).toContain(credit);
    }

    expect(html).toContain(REPO_URL);
    expect(html).toContain(`${REPO_URL}/issues/new`);
  });

  it('keeps the credits one press away, under their own summary', () => {
    const details = page.querySelector<HTMLDetailsElement>('#about details.disc-sub');
    expect(details).not.toBeNull();
    expect(details!.querySelector('summary')?.textContent).toBe('Credits and licences');
    expect(details!.querySelector('.disc-sub-body')?.textContent).toContain('Literata');
    // Not a closed <details> only: the strings are in the markup for tests and search.
    expect(details!.textContent).toContain('Pocket TTS');
  });

  it('links the table of contents to every row', () => {
    const hrefs = [...page.querySelectorAll<HTMLAnchorElement>('.settings-toc a')].map((a) =>
      a.getAttribute('href'),
    );
    expect(hrefs).toEqual(ROW_IDS.map((id) => `#${id}`));
  });

  it('summarises only the rows whose value is cheap to read', () => {
    expect(page.querySelector('#voice .disc-summary')?.textContent).toMatch(/· 1\.0×$/);
    expect(page.querySelector('#ai .disc-summary')?.textContent).toBe('Off');
    expect(page.querySelector('#about .disc-summary')?.textContent).toContain(`v${packageJson.version}`);
    expect(page.querySelector('#backup .disc-summary')?.textContent).toContain('Last backup');
    expect(page.querySelector('#reading .disc-summary')?.textContent).toContain('Pause');
    // These would need a probe, a walk or a query, so they stay quiet.
    for (const id of ['voice-models', 'pdf-layout', 'pronunciation', 'cached-audio', 'storage']) {
      expect(page.querySelector(`#${id} .disc-summary`)).toBeNull();
    }
  });
});

describe('SettingsPage disclosure rows', () => {
  it('starts with every row closed and its body mounted but hidden', () => {
    for (const id of ROW_IDS) {
      expect(head(page, id).getAttribute('aria-expanded')).toBe('false');
      expect(body(page, id).hidden).toBe(true);
      expect(body(page, id).childNodes.length).toBeGreaterThan(0);
    }
    expect(page.querySelector('#about details.disc-sub')?.hasAttribute('open')).toBe(false);
  });

  it('opens a row on a click and closes the previous one', async () => {
    const { host } = await mountPage();

    await press(host, 'voice');
    expect(head(host, 'voice').getAttribute('aria-expanded')).toBe('true');
    expect(body(host, 'voice').hidden).toBe(false);

    await press(host, 'backup');
    expect(head(host, 'voice').getAttribute('aria-expanded')).toBe('false');
    expect(body(host, 'voice').hidden).toBe(true);
    expect(head(host, 'backup').getAttribute('aria-expanded')).toBe('true');
    expect(body(host, 'backup').hidden).toBe(false);

    // Pressing the open row closes it again.
    await press(host, 'backup');
    expect(head(host, 'backup').getAttribute('aria-expanded')).toBe('false');
    expect(body(host, 'backup').hidden).toBe(true);
  });

  it('opens a row from the section list', async () => {
    const { host } = await mountPage();
    const link = host.querySelector<HTMLAnchorElement>('.settings-toc a[href="#storage"]');
    expect(link).not.toBeNull();

    await act(async () => {
      link!.click();
    });
    await settle();

    expect(head(host, 'storage').getAttribute('aria-expanded')).toBe('true');
  });

  it('opens the row named by the hash on mount', async () => {
    window.history.replaceState(null, '', '#voice-models');
    const { host } = await mountPage();
    expect(head(host, 'voice-models').getAttribute('aria-expanded')).toBe('true');
    expect(head(host, 'voice').getAttribute('aria-expanded')).toBe('false');
  });

  it('opens the row named by a later hash change', async () => {
    const { host } = await mountPage();
    expect(head(host, 'backup').getAttribute('aria-expanded')).toBe('false');

    await act(async () => {
      window.history.replaceState(null, '', '#backup');
      window.dispatchEvent(new Event('hashchange'));
    });
    await settle();

    expect(head(host, 'backup').getAttribute('aria-expanded')).toBe('true');
  });
});

describe('scrollToHash', () => {
  afterEach(() => {
    window.history.replaceState(null, '', window.location.pathname);
    document.body.innerHTML = '';
  });

  it('scrolls to the element named by the hash', () => {
    const section = document.createElement('section');
    section.id = 'voice-models';
    const scrollIntoView = vi.fn();
    section.scrollIntoView = scrollIntoView;
    document.body.append(section);

    window.history.replaceState(null, '', '#voice-models');
    scrollToHash();

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
  });

  it('does nothing without a hash', () => {
    const section = document.createElement('section');
    section.id = 'storage';
    const scrollIntoView = vi.fn();
    section.scrollIntoView = scrollIntoView;
    document.body.append(section);

    scrollToHash();

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('stays quiet when the hash names nothing on the page', () => {
    expect(() => {
      window.history.replaceState(null, '', '#nope');
      scrollToHash();
    }).not.toThrow();
  });
});
