import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import AiActions from './AiActions';
import AiSettings from './AiSettings';

/**
 * Render-only checks: the Settings page is wired by the lead, so these two
 * components must not crash and must show the right empty state.
 */
describe('AI panels', () => {
  it('shows the privacy notice and the key field in settings', () => {
    const html = renderToStaticMarkup(<AiSettings />);
    expect(html).toContain('Selected text is sent to the provider you choose.');
    expect(html).toContain('type="password"');
    expect(html).toContain('>Test<');
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
