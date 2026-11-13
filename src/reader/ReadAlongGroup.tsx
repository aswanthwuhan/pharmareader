/**
 * The read-along controls: style, colour and strength for the sentence, and
 * the spoken word's own mark and strength, over a live preview of the real
 * thing. The reader's "Aa" sheet and Settings → Reading aloud both render
 * this, so the two places never drift apart.
 */
import { useId } from 'react';
import { setSetting, useSetting } from '../core/settings';
import { WORD_HIGHLIGHT_KEY } from './reading';
import {
  READ_ALONG_COLOUR_KEY,
  READ_ALONG_COLOURS,
  READ_ALONG_STRENGTH_KEY,
  READ_ALONG_STRENGTH_MAX,
  READ_ALONG_STRENGTH_MIN,
  READ_ALONG_STRENGTH_STEP,
  READ_ALONG_STYLE_KEY,
  READ_ALONG_WORD_STRENGTH_KEY,
  READ_ALONG_WORD_STRENGTH_MAX,
  READ_ALONG_WORD_STRENGTH_MIN,
  READ_ALONG_WORD_STRENGTH_STEP,
  READ_ALONG_WORD_STYLE_KEY,
  clampStrength,
  clampWordStrength,
  readAlongStyle,
  useReadAlong,
  type ReadAlongColour,
} from './readAlong';

const COLOUR_LABEL: Record<ReadAlongColour, string> = {
  yellow: 'Yellow',
  green: 'Green',
  blue: 'Blue',
  pink: 'Pink',
  teal: 'Teal',
};

const SWATCH_CLASS: Record<ReadAlongColour, string> = {
  yellow: 'rd-swatch-yellow',
  green: 'rd-swatch-green',
  blue: 'rd-swatch-blue',
  pink: 'rd-swatch-pink',
  teal: 'rd-swatch-teal',
};

export default function ReadAlongGroup() {
  const { style, colour, strength, wordStyle, wordStrength } = useReadAlong();
  const wordHighlight = useSetting<boolean>(WORD_HIGHLIGHT_KEY, true);
  const id = useId();
  const styleLabelId = `${id}style`;
  const colourLabelId = `${id}colour`;
  const strengthId = `${id}strength`;
  const wordStyleLabelId = `${id}word-style`;
  const wordStrengthId = `${id}word-strength`;

  return (
    <fieldset
      className="rd-opt-group rd-ra"
      data-ra-style={style}
      data-ra-word={wordStyle}
      style={readAlongStyle(colour, strength, wordStrength)}
    >
      <legend className="rd-opt-legend">Read-along highlight</legend>
      <p className="rd-opt-hint">
        Fill washes the sentence behind the words; Underline draws a 2px line under it. The words keep
        their full colour either way.
      </p>

      {/* Both marks in one sentence, so the two layers can be judged together. */}
      <div className="rd-ra-preview">
        <span className="rd-s reading">
          The <mark className="rd-word">sentence</mark> being read looks like this.
        </span>
      </div>

      <div className="rd-opt-row rd-ra-row">
        <span className="rd-opt-text">
          <span className="rd-opt-name" id={styleLabelId}>
            Sentence style
          </span>
        </span>
        <div className="rd-seg rd-seg-wide" role="group" aria-labelledby={styleLabelId}>
          <button
            type="button"
            className="rd-seg-btn"
            aria-pressed={style === 'fill'}
            onClick={() => void setSetting(READ_ALONG_STYLE_KEY, 'fill')}
          >
            Fill
          </button>
          <button
            type="button"
            className="rd-seg-btn"
            aria-pressed={style === 'underline'}
            onClick={() => void setSetting(READ_ALONG_STYLE_KEY, 'underline')}
          >
            Underline
          </button>
        </div>
      </div>

      <div className="rd-opt-row rd-ra-row">
        <span className="rd-opt-text">
          <span className="rd-opt-name" id={colourLabelId}>
            Colour
          </span>
        </span>
        <div className="rd-colors rd-ra-colours" role="group" aria-labelledby={colourLabelId}>
          {READ_ALONG_COLOURS.map((entry) => (
            <button
              key={entry}
              type="button"
              className={`rd-swatch ${SWATCH_CLASS[entry]}`}
              aria-label={`${COLOUR_LABEL[entry]} read-along colour`}
              aria-pressed={colour === entry}
              title={`${COLOUR_LABEL[entry]} read-along colour`}
              onClick={() => void setSetting(READ_ALONG_COLOUR_KEY, entry)}
            >
              <span aria-hidden="true" />
              <span className="visually-hidden">{COLOUR_LABEL[entry]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="rd-opt-field rd-ra-strength">
        <div className="rd-ra-strength-head">
          <label className="field-label" htmlFor={strengthId}>
            Sentence strength
          </label>
          <span className="rd-ra-value">{strength}%</span>
        </div>
        <input
          id={strengthId}
          className="rd-opt-range"
          type="range"
          min={READ_ALONG_STRENGTH_MIN}
          max={READ_ALONG_STRENGTH_MAX}
          step={READ_ALONG_STRENGTH_STEP}
          value={strength}
          onChange={(event) =>
            void setSetting(READ_ALONG_STRENGTH_KEY, clampStrength(Number(event.target.value)))
          }
        />
      </div>

      <p className="rd-ra-subhead">Spoken word</p>
      <p className="rd-opt-hint">
        Highlight runs a more opaque patch of the same colour over the sentence as each word is
        spoken; Underline marks it with a 2px line instead.
      </p>

      <div className="rd-opt-row rd-ra-row">
        <span className="rd-opt-text">
          <span className="rd-opt-name" id={wordStyleLabelId}>
            Word mark
          </span>
        </span>
        <div className="rd-seg rd-seg-wide" role="group" aria-labelledby={wordStyleLabelId}>
          <button
            type="button"
            className="rd-seg-btn"
            aria-pressed={wordStyle === 'highlight'}
            onClick={() => void setSetting(READ_ALONG_WORD_STYLE_KEY, 'highlight')}
          >
            Highlight
          </button>
          <button
            type="button"
            className="rd-seg-btn"
            aria-pressed={wordStyle === 'underline'}
            onClick={() => void setSetting(READ_ALONG_WORD_STYLE_KEY, 'underline')}
          >
            Underline
          </button>
        </div>
      </div>

      <div className="rd-opt-field rd-ra-strength">
        <div className="rd-ra-strength-head">
          <label className="field-label" htmlFor={wordStrengthId}>
            Spoken word strength
          </label>
          <span className="rd-ra-value">{wordStrength}%</span>
        </div>
        <input
          id={wordStrengthId}
          className="rd-opt-range"
          type="range"
          min={READ_ALONG_WORD_STRENGTH_MIN}
          max={READ_ALONG_WORD_STRENGTH_MAX}
          step={READ_ALONG_WORD_STRENGTH_STEP}
          value={wordStrength}
          onChange={(event) =>
            void setSetting(
              READ_ALONG_WORD_STRENGTH_KEY,
              clampWordStrength(Number(event.target.value)),
            )
          }
        />
      </div>

      {wordHighlight ? null : (
        <p className="rd-opt-hint rd-ra-off">
          Word marking is off: turn on “Highlight the word being spoken” in Reading options.
        </p>
      )}
    </fieldset>
  );
}
