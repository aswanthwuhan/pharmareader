/**
 * Settings → Reading aloud.
 *
 * Two questions, in the order a reader asks them: what should the voice read,
 * and how should it pause. Every switch here changes only what is spoken — the
 * text on the page keeps every table, figure and footnote, dimmed with a note
 * that the voice passes over it.
 *
 * Self-contained: it renders its own settings section, so the settings page
 * mounts it with one line and nothing else has to know its shape.
 */
import { useSetting, setSetting } from '../core/settings';
import {
  DEFAULT_PAUSE_MS,
  DEFAULT_SKIP,
  PAUSE_KEY,
  SKIP_KEY,
  WORD_HIGHLIGHT_KEY,
  type SkipOptions,
} from './reading';
import './reader.css';

/** The order the switches appear in: prose structure first, then notation. */
const SKIP_ROWS: { key: keyof SkipOptions; label: string; hint?: string }[] = [
  { key: 'tables', label: 'Tables', hint: 'Dose tables stay on the page, unread.' },
  { key: 'figures', label: 'Figures & charts', hint: 'Their captions are a separate switch.' },
  { key: 'captions', label: 'Captions' },
  { key: 'formulas', label: 'Formulas', hint: 'Equations and structures.' },
  { key: 'headersFooters', label: 'Running headers & footers' },
  { key: 'footnotes', label: 'Footnotes' },
  { key: 'references', label: 'References', hint: 'The bibliography at the end of a chapter.' },
  { key: 'citations', label: 'Citations', hint: '“[12]” and “(Smith et al., 2019)” are not spoken.' },
  { key: 'brackets', label: 'Parenthetical asides', hint: 'Side remarks in brackets, e.g. “(see Fig. 2)”.' },
];

function pauseLabel(ms: number): string {
  if (ms === 0) return 'No pause between paragraphs.';
  const seconds = (ms / 1000).toFixed(2).replace(/0$/, '');
  return `${seconds} s of silence between paragraphs.`;
}

export default function ReadingOptions() {
  const tables = useSetting<boolean>(SKIP_KEY.tables, DEFAULT_SKIP.tables);
  const figures = useSetting<boolean>(SKIP_KEY.figures, DEFAULT_SKIP.figures);
  const captions = useSetting<boolean>(SKIP_KEY.captions, DEFAULT_SKIP.captions);
  const formulas = useSetting<boolean>(SKIP_KEY.formulas, DEFAULT_SKIP.formulas);
  const headersFooters = useSetting<boolean>(SKIP_KEY.headersFooters, DEFAULT_SKIP.headersFooters);
  const footnotes = useSetting<boolean>(SKIP_KEY.footnotes, DEFAULT_SKIP.footnotes);
  const references = useSetting<boolean>(SKIP_KEY.references, DEFAULT_SKIP.references);
  const citations = useSetting<boolean>(SKIP_KEY.citations, DEFAULT_SKIP.citations);
  const brackets = useSetting<boolean>(SKIP_KEY.brackets, DEFAULT_SKIP.brackets);
  const pauseMs = useSetting<number>(PAUSE_KEY, DEFAULT_PAUSE_MS);
  const wordHighlight = useSetting<boolean>(WORD_HIGHLIGHT_KEY, true);

  const values: Record<keyof SkipOptions, boolean> = {
    tables,
    figures,
    captions,
    formulas,
    headersFooters,
    footnotes,
    references,
    citations,
    brackets,
  };

  return (
    <section id="reading" className="settings-section rd-options" aria-labelledby="reading-h2">
      <h2 id="reading-h2" className="settings-h2">
        Reading aloud
      </h2>
      <p className="settings-sub">
        What the voice reads, and how it pauses between paragraphs. Skipped text stays on the page.
      </p>

      <div className="card">
        <fieldset className="rd-opt-group">
          <legend className="rd-opt-legend">Skip while reading</legend>
          <p className="rd-opt-hint">
            Switched-off kinds stay visible in the text, dimmed, with a note that the voice passes over
            them.
          </p>

          {SKIP_ROWS.map((row) => (
            <label className="rd-opt-row" key={row.key}>
              <span className="rd-opt-text">
                <span className="rd-opt-name">{row.label}</span>
                {row.hint ? <span className="rd-opt-note">{row.hint}</span> : null}
              </span>
              <input
                className="rd-opt-check"
                type="checkbox"
                checked={values[row.key]}
                aria-label={row.label}
                onChange={(event) => void setSetting(SKIP_KEY[row.key], event.target.checked)}
              />
            </label>
          ))}
        </fieldset>

        <div className="field rd-opt-field">
          <label className="field-label" htmlFor="rd-pause">
            Paragraph pause
          </label>
          <input
            id="rd-pause"
            className="rd-opt-range"
            type="range"
            min={0}
            max={1500}
            step={50}
            value={pauseMs}
            aria-describedby="rd-pause-hint"
            onChange={(event) => void setSetting(PAUSE_KEY, Number(event.target.value))}
          />
          <p className="field-hint" id="rd-pause-hint">
            {pauseLabel(pauseMs)}
          </p>
        </div>

        <label className="rd-opt-row rd-opt-last">
          <span className="rd-opt-text">
            <span className="rd-opt-name">Highlight the word being spoken</span>
            <span className="rd-opt-note">
              Follows the voice word by word. The phone&apos;s own voice reports timing less precisely,
              so the highlight there is estimated.
            </span>
          </span>
          <input
            className="rd-opt-check"
            type="checkbox"
            checked={wordHighlight}
            aria-label="Highlight the word being spoken"
            onChange={(event) => void setSetting(WORD_HIGHLIGHT_KEY, event.target.checked)}
          />
        </label>
      </div>
    </section>
  );
}
