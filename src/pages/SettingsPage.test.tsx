import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import packageJson from '../../package.json';
import SettingsPage, { scrollToHash } from './SettingsPage';

const SECTION_IDS = ['voice', 'voice-models', 'pronunciation', 'cached-audio', 'ai', 'backup', 'about'];
const SECTION_TITLES = [
  'Voice',
  'Reading aloud',
  'On-device voice models',
  'Pronunciation',
  'Cached audio',
  'AI (bring your own key)',
  'Backup',
  'About',
];

describe('SettingsPage', () => {
  const html = renderToStaticMarkup(<SettingsPage />);

  it('renders one page title and the briefed section order', () => {
    expect(html.match(/<h1\b/g)?.length).toBe(1);
    const positions = SECTION_IDS.map((id) => html.indexOf(`id="${id}"`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('gives every section exactly one page-level heading', () => {
    const headings = [...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((match) => match[1]);
    expect(headings).toEqual(SECTION_TITLES);
  });

  it('shows the version, license and model credits in About', () => {
    expect(html).toContain(packageJson.version);
    expect(html).toContain('GNU GPL-3.0');
    for (const credit of ['Pocket TTS', 'Kyutai', 'Kokoro-82M', 'hexgrad', 'sherpa-onnx', 'espeak-ng', 'Literata']) {
      expect(html).toContain(credit);
    }
    expect(html).toContain('https://github.com/aswanthwuhan/pharmareader');
    expect(html).toContain('https://github.com/aswanthwuhan/pharmareader/issues/new');
  });

  it('links the section list to every section id', () => {
    for (const id of SECTION_IDS) {
      expect(html).toContain(`href="#${id}"`);
    }
  });
});

describe('scrollToHash', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    window.history.replaceState(null, '', window.location.pathname);
  });

  it('scrolls to the element named in the hash', () => {
    const target = document.createElement('section');
    target.id = 'voice-models';
    const scrollIntoView = vi.fn();
    target.scrollIntoView = scrollIntoView;
    document.body.append(target);
    window.history.replaceState(null, '', '#voice-models');

    scrollToHash();

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
  });

  it('stays quiet when there is no hash or no matching element', () => {
    window.history.replaceState(null, '', '#no-such-section');
    expect(() => scrollToHash()).not.toThrow();
    window.history.replaceState(null, '', window.location.pathname);
    expect(() => scrollToHash()).not.toThrow();
  });
});
