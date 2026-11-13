/**
 * The docked player. It replaces the app's tab bar while reading, so it is the
 * one piece of chrome a thumb can always reach: where she is in the chapter on
 * top, then speed, stepping, play and the voice that will speak.
 *
 * The two popovers keep the sheet itself to a single row of controls; both are
 * dismissable with Escape, the Android back key, a tap outside, or the same
 * button that opened them.
 * Generation status ("Generating sentence 15…", "2 ready ahead") lives under the
 * position line, so waiting is visible instead of looking like a stuck button.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { pushBackHandler } from '../core/backButton';
import { getSetting } from '../core/settings';
import { useDownload } from '../tts/downloads';
import {
  canRunKokoro,
  kokoroIsReady,
  markKokoroPrompted,
  wasKokoroPrompted,
} from '../tts/kokoroOffer';
import { ENGINE_SETTING } from '../tts/registry';
import { Glyph, icons } from './Icon';
import VoicePrompt from './VoicePrompt';

export type PlayState = 'idle' | 'playing' | 'paused';

/** Page-level stepping for long books: one PDF page, or one screen of text. */
export interface PageNav {
  /** "Page 12 of 24" (PDF) or "Screen 2 of 9" (text). */
  label: string;
  onPrev(): void;
  onNext(): void;
}

/**
 * A hand-picked passage is being read. It replaces the chapter position line,
 * because "sentence 2 of 4" is the only useful number while it plays.
 */
export interface SelectionStatus {
  /** 1-based position inside the selection. */
  at: number;
  total: number;
  /** The last selected sentence has been spoken. */
  done: boolean;
  onContinue(): void;
  onReplay(): void;
}

/**
 * What the "…" menu shows while audio is being saved: one chapter, or a queue
 * of several. `status` is the queue's own sentence ("Saving chapter 2 of 5 — 14
 * of 120 sentences"); a single chapter keeps the original line.
 */
export interface PrerenderProgress {
  done: number;
  total: number;
  status?: string;
}

interface Props {
  state: PlayState;
  /** "Kokoro" / "Pocket TTS" / "Phone voice" — never an engine class name. */
  engineName: string;
  /** The resolved engine's id ('system', 'kokoro', 'pocket'), or null while resolving. */
  engineId?: string | null;
  /** True when the chosen engine was unavailable and the phone voice took over. */
  fallback: boolean;
  rate: number;
  canPrerender: boolean;
  progress: PrerenderProgress | null;
  cached: boolean;
  /** 1-based position of the spoken sentence inside the chapter. */
  sentenceNumber: number;
  sentenceTotal: number;
  /** 1-based sentence number being synthesized right now, if any. */
  generating: number | null;
  /** How many upcoming sentences already have audio. */
  readyAhead: number;
  /** Null when page stepping is not available (single page, or page view). */
  pages: PageNav | null;
  /** The cursor is off-screen: play should start at the top of the viewport. */
  fromHere: boolean;
  /** Set while a selected passage is playing, or just after it finished. */
  selection: SelectionStatus | null;
  onToggle(): void;
  onStop(): void;
  onPrev(): void;
  onNext(): void;
  onRate(rate: number): void;
  onPrerender(): void;
  /** Opens the sheet that queues several chapters, or a page range. */
  onPrerenderMore(): void;
  onCancelPrerender(): void;
  onPlayFromHere(): void;
  /** Sleep timer ran out: pause where the voice is, do not stop or close. */
  onSleepEnd(): void;
  /** "End of chapter" is armed or disarmed, so the player can stop advancing. */
  onSleepAtChapterEndChange(atEnd: boolean): void;
}

const RATE_MIN = 0.5;
const RATE_MAX = 2;
const RATE_STEP = 0.05;
/** The speeds most listeners actually use. Everything else lives on the slider. */
const RATE_PRESETS = [0.75, 1, 1.25, 1.5, 2];

/** Sleep timer choices. "End of chapter" is the one that is not a duration. */
type SleepChoice = 'off' | '10' | '20' | '30' | 'end';

const SLEEP_OPTIONS: { value: SleepChoice; text: string; label: string }[] = [
  { value: 'off', text: 'Off', label: 'Sleep timer off' },
  { value: '10', text: '10 min', label: 'Sleep timer 10 minutes' },
  { value: '20', text: '20 min', label: 'Sleep timer 20 minutes' },
  { value: '30', text: '30 min', label: 'Sleep timer 30 minutes' },
  { value: 'end', text: 'Chapter end', label: 'Sleep timer end of chapter' },
];

function rateLabel(rate: number): string {
  return `${rate.toFixed(2).replace(/0$/, '')}×`;
}

/** The phone-voice pill is an icon-only 44px button under 480px; this is its glyph. */
const DOWNLOAD_GLYPH = (
  <>
    <path d="M12 4.5v9" />
    <path d="m8.4 10 3.6 3.6L15.6 10" />
    <path d="M5 18.5h14" />
  </>
);

/** When Kokoro cannot run here the pill still links to Settings; this is that glyph. */
const VOICE_GLYPH = (
  <>
    <path d="M4.5 10v4h3l4 3.5v-11L7.5 10z" />
    <path d="M15 9.2a4 4 0 0 1 0 5.6" />
    <path d="M17.5 7a7.5 7.5 0 0 1 0 10" />
  </>
);

export default function PlayerBar({
  state,
  engineName,
  engineId,
  fallback,
  rate,
  canPrerender,
  progress,
  cached,
  sentenceNumber,
  sentenceTotal,
  generating,
  readyAhead,
  pages,
  fromHere,
  selection,
  onToggle,
  onStop,
  onPrev,
  onNext,
  onRate,
  onPrerender,
  onPrerenderMore,
  onCancelPrerender,
  onPlayFromHere,
  onSleepEnd,
  onSleepAtChapterEndChange,
}: Props) {
  const playing = state === 'playing';
  const busy = progress !== null;
  const [open, setOpen] = useState<'none' | 'speed' | 'more'>('none');
  const [sleepChoice, setSleepChoice] = useState<SleepChoice>('off');
  const [sleepEndsAt, setSleepEndsAt] = useState<number | null>(null);
  const [sleepNow, setSleepNow] = useState(() => Date.now());

  // Both callbacks are re-created by the reader on every render; keep the
  // interval and the choice handler reading the current ones.
  const sleepEnd = useRef(onSleepEnd);
  sleepEnd.current = onSleepEnd;
  const sleepAtChapterEnd = useRef(onSleepAtChapterEndChange);
  sleepAtChapterEnd.current = onSleepAtChapterEndChange;
  /** A one-shot "End of chapter" only resets once playback has actually run. */
  const wasPlaying = useRef(false);

  const kokoroDownload = useDownload('kokoro');
  /** The Kokoro offer sheet: opened by the phone-voice pill, or once on the first Play. */
  const [voiceOpen, setVoiceOpen] = useState(false);
  const promptedOnce = useRef(false);
  const canOfferKokoro = useMemo(() => canRunKokoro(), []);
  const phoneVoice = engineId === 'system';
  const kokoroBusy =
    kokoroDownload.status === 'downloading' || kokoroDownload.status === 'unpacking';
  const kokoroPercent = Math.max(0, Math.min(100, Math.round(kokoroDownload.fraction * 100)));

  // First Play while the phone voice would read: offer Kokoro once, without delaying
  // playback. "Not now" (any close) leaves the pill and the banner as the way back.
  useEffect(() => {
    if (!canOfferKokoro || promptedOnce.current) return;
    if (state !== 'playing' || engineId !== 'system') return;
    if (kokoroBusy || kokoroDownload.status === 'done') return;
    promptedOnce.current = true;
    let alive = true;
    void (async () => {
      // Read the stored choice, never the live hook's fallback: a choice made in
      // Settings must hold even during the instant before it finishes loading.
      if ((await getSetting<string>(ENGINE_SETTING, 'auto')) !== 'auto') return;
      if (await kokoroIsReady()) return;
      if (await wasKokoroPrompted()) return;
      // Playback state moved on while we were reading settings: ask on the next
      // Play instead of recording a prompt nobody saw.
      if (!alive) {
        promptedOnce.current = false;
        return;
      }
      await markKokoroPrompted();
      setVoiceOpen(true);
    })().catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [canOfferKokoro, state, engineId, kokoroBusy, kokoroDownload.status]);

  useEffect(() => {
    if (sleepEndsAt === null) return;
    // Re-check on a coarse tick: a minute is the resolution shown, and a phone
    // that slept through ticks still fires on the first wake-up past the time.
    const tick = () => {
      const now = Date.now();
      setSleepNow(now);
      if (now < sleepEndsAt) return;
      setSleepEndsAt(null);
      setSleepChoice('off');
      sleepEnd.current();
    };
    const id = window.setInterval(tick, 15_000);
    return () => window.clearInterval(id);
  }, [sleepEndsAt]);

  // "End of chapter" is spent once the chapter finishes (or the reader stops),
  // so the next chapter plays normally rather than stopping again at its end.
  useEffect(() => {
    if (state === 'playing') {
      wasPlaying.current = true;
      return;
    }
    if (state === 'paused' || sleepChoice !== 'end' || !wasPlaying.current) return;
    // A picked passage ending is not the chapter ending: "Continue from here"
    // still has to stop at the end of the chapter, so keep the one-shot armed.
    if (selection !== null) return;
    wasPlaying.current = false;
    setSleepChoice('off');
    sleepAtChapterEnd.current(false);
  }, [state, sleepChoice, selection]);

  function chooseSleep(choice: SleepChoice): void {
    const now = Date.now();
    setSleepNow(now);
    setSleepChoice(choice);
    wasPlaying.current = state === 'playing';
    if (choice === 'off') {
      setSleepEndsAt(null);
      sleepAtChapterEnd.current(false);
      return;
    }
    if (choice === 'end') {
      setSleepEndsAt(null);
      sleepAtChapterEnd.current(true);
      return;
    }
    setSleepEndsAt(now + Number(choice) * 60_000);
    sleepAtChapterEnd.current(false);
  }

  useEffect(() => {
    if (open === 'none') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen('none');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // The Android back key dismisses the popover the way Escape does. Without
  // this the press reaches the app bridge, which leaves the book: the sheet was
  // the top layer, so it has to be the thing that closes.
  useEffect(() => {
    if (open === 'none') return;
    return pushBackHandler(() => {
      setOpen('none');
      return true;
    });
  }, [open]);

  const percent =
    selection !== null
      ? selection.total > 0
        ? Math.round((selection.at / selection.total) * 100)
        : 0
      : sentenceTotal > 0
        ? Math.round((sentenceNumber / sentenceTotal) * 100)
        : 0;

  const minutesLeft = sleepEndsAt === null ? 0 : Math.max(1, Math.ceil((sleepEndsAt - sleepNow) / 60_000));
  const sleepValue = sleepEndsAt !== null ? `${minutesLeft} min` : sleepChoice === 'end' ? 'Chapter end' : 'Off';
  const sleepNote =
    sleepEndsAt !== null
      ? `Pauses in ${minutesLeft} ${minutesLeft === 1 ? 'minute' : 'minutes'}`
      : sleepChoice === 'end'
        ? 'Pauses at the end of this chapter'
        : null;

  function togglePanel(panel: 'speed' | 'more'): void {
    setOpen((current) => (current === panel ? 'none' : panel));
  }

  return (
    <div className="rd-dock">
      <div className="rd-player" role="group" aria-label="Read aloud">
        <div
          className="rd-player-track"
          role="progressbar"
          aria-label={selection !== null ? 'Selection progress' : 'Chapter progress'}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <span style={{ width: `${percent}%` }} />
        </div>

        <div className="rd-player-caption">
          <div className="rd-player-meta">
            <p className="rd-player-count" aria-live="polite">
              {selection !== null
                ? selection.done
                  ? 'Selection finished'
                  : `Selection: sentence ${selection.at} of ${selection.total}`
                : sentenceTotal > 0
                  ? (
                    <>
                      {/* The word drops out on a narrow phone; the numbers stay. */}
                      <span className="rd-count-word">Sentence </span>
                      {sentenceNumber} of {sentenceTotal}
                    </>
                  )
                  : 'No sentences here'}
              {selection === null && cached && !busy ? (
                <span className="rd-player-saved"> · audio saved</span>
              ) : null}
            </p>
            {generating !== null ? (
              <p className="rd-gen" role="status">
                <span className="rd-spinner" aria-hidden="true" />
                Generating sentence {generating}…
              </p>
            ) : readyAhead > 0 ? (
              <p className="rd-buffer">{readyAhead} ready ahead</p>
            ) : null}
          </div>

          {pages ? (
            <div className="rd-pages">
              <button type="button" className="rd-icon-btn" aria-label="Previous page" onClick={pages.onPrev}>
                <Glyph>{icons.back}</Glyph>
              </button>
              <span className="rd-pages-label" aria-hidden="true">
                {pages.label}
              </span>
              <button type="button" className="rd-icon-btn" aria-label="Next page" onClick={pages.onNext}>
                <Glyph>{icons.forward}</Glyph>
              </button>
            </div>
          ) : null}

          <button
            type="button"
            className="rd-icon-btn"
            aria-label="Playback options"
            aria-expanded={open === 'more'}
            onClick={() => togglePanel('more')}
            data-tour="more"
          >
            <Glyph>{icons.more}</Glyph>
          </button>
        </div>

        {fromHere && !playing && selection === null ? (
          <button type="button" className="rd-from-here" onClick={onPlayFromHere}>
            <Glyph size={16}>{icons.play}</Glyph>
            <span>Play from here</span>
          </button>
        ) : null}

        {selection?.done ? (
          <div className="rd-sel-done">
            <button type="button" className="btn btn-ghost rd-action" onClick={selection.onContinue}>
              <Glyph>{icons.play}</Glyph>
              <span>Continue from here</span>
            </button>
            <button type="button" className="btn btn-ghost rd-action" onClick={selection.onReplay}>
              <Glyph>{icons.replay}</Glyph>
              <span>Replay</span>
            </button>
          </div>
        ) : null}

        <div className="rd-player-controls">
          <button
            type="button"
            className="rd-speed"
            aria-label={`Playback speed ${rateLabel(rate)}`}
            aria-expanded={open === 'speed'}
            onClick={() => togglePanel('speed')}
            data-tour="speed"
          >
            {rateLabel(rate)}
          </button>

          <button
            type="button"
            className="rd-icon-btn"
            aria-label="Previous sentence"
            onClick={onPrev}
            data-tour="step"
          >
            <Glyph>{icons.prev}</Glyph>
          </button>
          <button
            type="button"
            className="rd-play"
            aria-label={playing ? 'Pause' : state === 'paused' ? 'Resume' : 'Play'}
            aria-pressed={playing}
            onClick={onToggle}
            data-tour="play"
          >
            <Glyph>{playing ? icons.pause : icons.play}</Glyph>
          </button>
          <button type="button" className="rd-icon-btn" aria-label="Next sentence" onClick={onNext}>
            <Glyph>{icons.next}</Glyph>
          </button>

          {phoneVoice && canOfferKokoro ? (
            <button
              type="button"
              className={`rd-engine rd-engine--phone${fallback ? ' is-warning' : ''}`}
              data-engine-state={kokoroBusy ? 'downloading' : 'phone'}
              title="Voice options. Kokoro is available for this book."
              aria-label={
                kokoroBusy
                  ? `Kokoro download ${kokoroPercent}% — open voice options`
                  : 'Voice options — the phone voice is reading. Kokoro is available.'
              }
              onClick={() => setVoiceOpen(true)}
            >
              <span className="rd-engine-dot" aria-hidden="true" />
              <span className="rd-engine-name">
                {kokoroBusy ? `Kokoro · ${kokoroPercent}%` : engineName}
              </span>
              <span className="rd-engine-glyph" aria-hidden="true">
                <Glyph size={24}>{DOWNLOAD_GLYPH}</Glyph>
              </span>
            </button>
          ) : (
            <Link
              className={`rd-engine${phoneVoice ? ' rd-engine--phone' : ''}${fallback ? ' is-warning' : ''}`}
              data-engine-state={
                phoneVoice ? (kokoroBusy ? 'downloading' : 'phone') : engineId ?? 'resolving'
              }
              to="/settings#voice-models"
              title={
                fallback
                  ? 'Your chosen voice model is not ready, so the phone voice is reading. Change it in Settings.'
                  : `Voice: ${engineName}. Change it in Settings.`
              }
            >
              <span className="rd-engine-dot" aria-hidden="true" />
              <span className="rd-engine-name">{engineName}</span>
              {phoneVoice ? (
                <span className="rd-engine-glyph" aria-hidden="true">
                  <Glyph size={24}>{VOICE_GLYPH}</Glyph>
                </span>
              ) : null}
            </Link>
          )}
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
                {progress.status ?? `Saving chapter audio ${progress.done} of ${progress.total}`}
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
              <button
                type="button"
                className="rd-pop-action"
                onClick={() => {
                  setOpen('none');
                  onPrerenderMore();
                }}
              >
                <Glyph>{icons.chapters}</Glyph>
                <span>Save audio for more…</span>
              </button>
              <p className="rd-pop-note">Plays back with no waiting, and keeps working offline.</p>
            </div>
          ) : null}

          <div className="rd-pop-slot">
            <div className="rd-pop-head">
              <span className="rd-pop-title">Sleep timer</span>
              <span className="rd-pop-value">{sleepValue}</span>
            </div>
            <div className="rd-sleep-choices" role="group" aria-label="Sleep timer">
              {SLEEP_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className="rd-preset"
                  aria-label={option.label}
                  aria-pressed={sleepChoice === option.value}
                  onClick={() => chooseSleep(option.value)}
                >
                  {option.text}
                </button>
              ))}
            </div>
            {sleepNote !== null ? (
              <p className="rd-pop-note rd-sleep-note" role="status">
                {sleepNote}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      <VoicePrompt open={voiceOpen} onClose={() => setVoiceOpen(false)} />
    </div>
  );
}
