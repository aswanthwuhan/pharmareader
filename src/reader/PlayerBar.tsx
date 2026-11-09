/**
 * The docked player. It replaces the app's tab bar while reading, so it is the
 * one piece of chrome a thumb can always reach: where she is in the chapter on
 * top, then speed, stepping, play and the voice that will speak.
 *
 * The two popovers keep the sheet itself to a single row of controls; both are
 * dismissable with Escape, a tap outside, or the same button that opened them.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Glyph, icons } from './Icon';

export type PlayState = 'idle' | 'playing' | 'paused';

interface Props {
  state: PlayState;
  /** "Kokoro" / "Pocket TTS" / "Phone voice" — never an engine class name. */
  engineName: string;
  /** True when the chosen engine was unavailable and the phone voice took over. */
  fallback: boolean;
  rate: number;
  canPrerender: boolean;
  progress: { done: number; total: number } | null;
  cached: boolean;
  /** 1-based position of the spoken sentence inside the chapter. */
  sentenceNumber: number;
  sentenceTotal: number;
  onToggle(): void;
  onStop(): void;
  onPrev(): void;
  onNext(): void;
  onRate(rate: number): void;
  onPrerender(): void;
  onCancelPrerender(): void;
}

const RATE_MIN = 0.5;
const RATE_MAX = 2;
const RATE_STEP = 0.05;
/** The speeds most listeners actually use. Everything else lives on the slider. */
const RATE_PRESETS = [0.75, 1, 1.25, 1.5, 2];

function rateLabel(rate: number): string {
  return `${rate.toFixed(2).replace(/0$/, '')}×`;
}

export default function PlayerBar({
  state,
  engineName,
  fallback,
  rate,
  canPrerender,
  progress,
  cached,
  sentenceNumber,
  sentenceTotal,
  onToggle,
  onStop,
  onPrev,
  onNext,
  onRate,
  onPrerender,
  onCancelPrerender,
}: Props) {
  const playing = state === 'playing';
  const busy = progress !== null;
  const [open, setOpen] = useState<'none' | 'speed' | 'more'>('none');

  useEffect(() => {
    if (open === 'none') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen('none');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const percent = sentenceTotal > 0 ? Math.round((sentenceNumber / sentenceTotal) * 100) : 0;

  function togglePanel(panel: 'speed' | 'more'): void {
    setOpen((current) => (current === panel ? 'none' : panel));
  }

  return (
    <div className="rd-dock">
      <div className="rd-player" role="group" aria-label="Read aloud">
        <div
          className="rd-player-track"
          role="progressbar"
          aria-label="Chapter progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <span style={{ width: `${percent}%` }} />
        </div>

        <div className="rd-player-caption">
          <p className="rd-player-count" aria-live="polite">
            {sentenceTotal > 0 ? `Sentence ${sentenceNumber} of ${sentenceTotal}` : 'No sentences here'}
            {cached && !busy ? <span className="rd-player-saved"> · audio saved</span> : null}
          </p>
          <button
            type="button"
            className="rd-icon-btn"
            aria-label="Playback options"
            aria-expanded={open === 'more'}
            onClick={() => togglePanel('more')}
          >
            <Glyph>{icons.more}</Glyph>
          </button>
        </div>

        <div className="rd-player-controls">
          <button
            type="button"
            className="rd-speed"
            aria-label={`Playback speed ${rateLabel(rate)}`}
            aria-expanded={open === 'speed'}
            onClick={() => togglePanel('speed')}
          >
            {rateLabel(rate)}
          </button>

          <button type="button" className="rd-icon-btn" aria-label="Previous sentence" onClick={onPrev}>
            <Glyph>{icons.prev}</Glyph>
          </button>
          <button
            type="button"
            className="rd-play"
            aria-label={playing ? 'Pause' : state === 'paused' ? 'Resume' : 'Play'}
            aria-pressed={playing}
            onClick={onToggle}
          >
            <Glyph>{playing ? icons.pause : icons.play}</Glyph>
          </button>
          <button type="button" className="rd-icon-btn" aria-label="Next sentence" onClick={onNext}>
            <Glyph>{icons.next}</Glyph>
          </button>

          <Link
            className={fallback ? 'rd-engine is-warning' : 'rd-engine'}
            to="/settings#voice-models"
            title={
              fallback
                ? 'Your chosen voice model is not ready, so the phone voice is reading. Change it in Settings.'
                : `Voice: ${engineName}. Change it in Settings.`
            }
          >
            <span className="rd-engine-dot" aria-hidden="true" />
            <span className="rd-engine-name">{engineName}</span>
          </Link>
        </div>
      </div>

      {open !== 'none' ? <div className="rd-pop-scrim" aria-hidden="true" onClick={() => setOpen('none')} /> : null}

      {/* Both popovers stay mounted: the speed slider keeps its position and
          focus between openings, and nothing about playback is re-created. */}
      <div className="rd-pop" hidden={open === 'none'}>
        <div className="rd-pop-section" role="group" aria-label="Playback speed" hidden={open !== 'speed'}>
          <div className="rd-pop-head">
            <span className="rd-pop-title">Speed</span>
            <span className="rd-pop-value">{rateLabel(rate)}</span>
          </div>
          <input
            className="rd-pop-range"
            type="range"
            min={RATE_MIN}
            max={RATE_MAX}
            step={RATE_STEP}
            value={rate}
            aria-label="Playback speed"
            onChange={(event) => onRate(Number(event.target.value))}
          />
          <div className="rd-presets">
            {RATE_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className="rd-preset"
                aria-pressed={Math.abs(rate - preset) < 0.001}
                onClick={() => onRate(preset)}
              >
                {rateLabel(preset)}
              </button>
            ))}
          </div>
        </div>

        <div className="rd-pop-section" role="group" aria-label="Playback options" hidden={open !== 'more'}>
          <div className="rd-pop-head">
            <span className="rd-pop-title">Playback</span>
          </div>
          <button
            type="button"
            className="rd-pop-action"
            aria-label="Stop"
            onClick={() => {
              setOpen('none');
              onStop();
            }}
          >
            <Glyph>{icons.stop}</Glyph>
            <span>Stop and save my place</span>
          </button>
          {busy ? (
            <div className="rd-pop-slot">
              <div className="progress">
                <span style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }} />
              </div>
              <p className="rd-pop-note" role="status">
                Saving chapter audio {progress.done} of {progress.total}
              </p>
              <button type="button" className="rd-pop-action" onClick={onCancelPrerender}>
                Cancel
              </button>
            </div>
          ) : canPrerender ? (
            <div className="rd-pop-slot">
              <button
                type="button"
                className="rd-pop-action"
                onClick={() => {
                  setOpen('none');
                  onPrerender();
                }}
              >
                <Glyph>{icons.spacing}</Glyph>
                <span>{cached ? 'Save this chapter again' : 'Save chapter audio'}</span>
              </button>
              <p className="rd-pop-note">Plays back with no waiting, and keeps working offline.</p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
