import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import BackupPanel from '../backup/BackupPanel';
import AiActions from './AiActions';
import AiSettings from './AiSettings';

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
