/**
 * The sticky playback bar. It sits directly above the app's bottom navigation
 * so it is always reachable with a thumb while reading. It reads as a small
 * bottom sheet: one calm surface, one primary action, the voice named quietly.
 */
import { Glyph, icons } from './Icon';

export type PlayState = 'idle' | 'playing' | 'paused';

interface Props {
  state: PlayState;
  engineLabel: string;
  /** True when the chosen engine was unavailable and the system voices took over. */
  fallback: boolean;
  rate: number;
  canPrerender: boolean;
  progress: { done: number; total: number } | null;
  cached: boolean;
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

export default function PlayerBar({
  state,
  engineLabel,
  fallback,
  rate,
  canPrerender,
  progress,
  cached,
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

  return (
    <div className="rd-player" role="group" aria-label="Read aloud">
      <div className="rd-player-row">
        <button
          type="button"
          className="btn btn-ghost btn-icon rd-step"
          aria-label="Previous sentence"
          onClick={onPrev}
        >
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
        <button
          type="button"
          className="btn btn-ghost btn-icon rd-step"
          aria-label="Next sentence"
          onClick={onNext}
        >
          <Glyph>{icons.next}</Glyph>
        </button>

        <label className="rd-rate">
          <span className="rd-rate-label">Speed</span>
          <input
            type="range"
            min={RATE_MIN}
            max={RATE_MAX}
            step={RATE_STEP}
            value={rate}
            aria-label="Playback speed"
            onChange={(event) => onRate(Number(event.target.value))}
          />
          <span className="rd-rate-value">{rate.toFixed(2).replace(/0$/, '')}×</span>
        </label>
      </div>

      <div className="rd-player-row rd-player-meta">
        <span
          className="rd-engine"
          title={fallback ? 'Your chosen voice is not ready; using system voices.' : undefined}
        >
          {engineLabel}
          {fallback ? ' · fallback' : ''}
        </span>

        {cached && !busy ? <span className="badge">cached</span> : null}

        {busy ? (
          <>
            <span className="rd-progress" aria-live="polite">
              Pre-rendering {progress.done}/{progress.total}
            </span>
            <button type="button" className="btn btn-ghost rd-meta-btn" onClick={onCancelPrerender}>
              Cancel
            </button>
          </>
        ) : canPrerender ? (
          <button type="button" className="btn btn-ghost rd-meta-btn" onClick={onPrerender}>
            Pre-render chapter
          </button>
        ) : null}

        <button
          type="button"
          className="btn btn-ghost rd-meta-btn rd-stop"
          aria-label="Stop"
          onClick={onStop}
        >
          <Glyph>{icons.stop}</Glyph>
          <span>Stop</span>
        </button>
      </div>
    </div>
  );
}
