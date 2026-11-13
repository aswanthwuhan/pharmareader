/**
 * Settings → Reading aloud.
 *
 * Two questions, in the order a reader asks them: what should the voice read,
 * and how should it pause. Every switch here changes only what is spoken — the
 * text on the page keeps every table, figure and footnote, dimmed with a note
 * that the voice passes over it.
 *
 * The Settings page supplies this panel's section, its id and its h2, so the
 * panel is a plain block. What the page does not show until asked (the notes
 * behind each skipped kind) sits in a nested disclosure.
 */
import { useSetting, setSetting } from '../core/settings';
import { TTS_ENGINE_SETTING } from '../tts/TtsSettings';
import { WHISPER_READY_SETTING } from '../tts/align/whisperModel';
import {
  BRACKET_KEY,
  DEFAULT_PAUSE_MS,
  DEFAULT_SKIP,
  HEAT_WARNING,
  PAUSE_KEY,
  PREFETCH_AHEAD_KEY,
  PREFETCH_CHOICES,
  SKIP_KEY,
  WORD_HIGHLIGHT_KEY,
  isNeuralVoice,
  useBracketMode,
  usePrefetchAhead,
  type SkipOptions,
} from './reading';
import type { BracketMode } from './spoken';
import ReadAlongGroup from './ReadAlongGroup';
import './reader.css';

/** Keys that are a plain on/off switch. */
type SwitchKey = Exclude<keyof SkipOptions, 'brackets'>;

/** The order the chips appear in: prose structure first, then notation. */
const SKIP_ROWS: { key: SwitchKey; label: string; hint?: string }[] = [
  { key: 'tables', label: 'Tables', hint: 'Dose tables stay on the page, unread.' },
  { key: 'figures', label: 'Figures & charts', hint: 'Their captions are a separate switch.' },
  { key: 'captions', label: 'Captions' },
  { key: 'formulas', label: 'Formulas', hint: 'Equations and structures.' },
  { key: 'headersFooters', label: 'Running headers & footers' },
  { key: 'footnotes', label: 'Footnotes' },
  { key: 'references', label: 'References', hint: 'The bibliography at the end of a chapter.' },
  { key: 'citations', label: 'Citations', hint: '“[12]” and “(Smith et al., 2019)” are not spoken.' },
];

/** Ways to speak "(ANS)", "(see Fig. 2)" — words in brackets carry meaning. */
const BRACKET_ROWS: { value: BracketMode; label: string; hint: string }[] = [
  {
    value: 'pause',
    label: 'Pause around them (recommended)',
    hint: '“Autonomic nervous system (ANS) controls” → “autonomic nervous system, ANS, controls”, with a short pause each side.',
  },
  {
    value: 'announce',
    label: 'Say “in brackets”',
    hint: '“Autonomic nervous system (ANS)” → “autonomic nervous system, ANS in brackets”.',
  },
  {
    value: 'read',
    label: 'Read normally',
    hint: 'Brackets are read as written, with no extra words.',
  },
  {
    value: 'skip',
    label: 'Skip',
    hint: 'Words in brackets are left out of the voice entirely.',
  },
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
  const brackets = useBracketMode();
  const pauseMs = useSetting<number>(PAUSE_KEY, DEFAULT_PAUSE_MS);
  const prefetchAhead = usePrefetchAhead();
  const wordHighlight = useSetting<boolean>(WORD_HIGHLIGHT_KEY, true);
  const engine = useSetting<string>(TTS_ENGINE_SETTING, 'auto');
  const whisperReady = useSetting<boolean>(WHISPER_READY_SETTING, false);

  // The neural voices and the aligner are two models on one phone: together they
  // are what makes it warm while listening.
  const heatWarning = isNeuralVoice(engine) && whisperReady === true && wordHighlight;

  const values: Record<SwitchKey, boolean> = {
    tables,
    figures,
    captions,
    formulas,
    headersFooters,
    footnotes,
    references,
    citations,
  };

  const notes = SKIP_ROWS.filter((row) => row.hint);

  return (
    <div className="rd-options">
      <p className="rd-opt-intro">
        What the voice reads, and how it pauses between paragraphs. Skipped text stays on the page.
      </p>

      <fieldset className="rd-opt-group">
        <legend className="rd-opt-legend">Skip while reading</legend>
        {/* One chip per kind: the whole decision is the label, so eight switches
            do not need eight rows. */}
        <div className="rd-opt-chips">
          {SKIP_ROWS.map((row) => (
            <button
              key={row.key}
              type="button"
              className="chip chip-tap"
              aria-pressed={values[row.key]}
              onClick={() => void setSetting(SKIP_KEY[row.key], !values[row.key])}
            >
              {row.label}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="rd-opt-group rd-opt-brackets">
        <legend className="rd-opt-legend">Text in brackets</legend>
        <p className="rd-opt-hint" id="rd-brackets-hint">
          Text in brackets is part of the sentence, so the voice can say so instead of leaving a gap:
          “(ANS)” becomes “ANS in brackets”.
        </p>
        {BRACKET_ROWS.map((row) => (
          <label className="rd-opt-row" key={row.value}>
            <span className="rd-opt-text">
              <span className="rd-opt-name">{row.label}</span>
              <span className="rd-opt-note">{row.hint}</span>
            </span>
            <input
              className="rd-opt-check rd-opt-radio"
              type="radio"
              name="rd-brackets"
              value={row.value}
              checked={brackets === row.value}
              aria-label={row.label}
              onChange={() => void setSetting(BRACKET_KEY, row.value)}
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

      <div className="field rd-opt-field">
        <label className="field-label" htmlFor="rd-prefetch">
          Prepare ahead
        </label>
        <select
          id="rd-prefetch"
          className="rd-opt-select"
          value={prefetchAhead}
          aria-describedby="rd-prefetch-hint"
          onChange={(event) => void setSetting(PREFETCH_AHEAD_KEY, Number(event.target.value))}
        >
          {PREFETCH_CHOICES.map((choice) => (
            <option key={choice} value={choice}>
              {choice} sentences
            </option>
          ))}
        </select>
        <p className="field-hint" id="rd-prefetch-hint">
          How many sentences to have ready before the voice reaches them. More avoids waiting, but uses more
          battery and storage — and a busy voice for longer. Three suits most books.
        </p>
      </div>

      <label className="rd-opt-row rd-opt-last">
        <span className="rd-opt-text">
          <span className="rd-opt-name">Highlight the word being spoken</span>
          <span className="rd-opt-note">
            Follows the voice word by word. The phone&apos;s own voice reports timing less precisely, so the
            highlight there is estimated.
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

      <ReadAlongGroup />

      {heatWarning && (
        <p className="field-hint" role="note">
          {HEAT_WARNING}
        </p>
      )}

      <details className="disc-sub">
        <summary>How this works</summary>
        <div className="disc-sub-body">
          <p>A switched-off kind is skipped by the voice and stays on the page, dimmed.</p>
          <ul className="rd-opt-notes">
            {notes.map((row) => (
              <li key={row.key}>
                <span className="rd-opt-note-name">{row.label}</span> — {row.hint}
              </li>
            ))}
          </ul>
        </div>
      </details>
    </div>
  );
}
