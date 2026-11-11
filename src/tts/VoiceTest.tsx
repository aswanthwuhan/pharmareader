/**
 * "Test voice" for every voice engine in Settings.
 *
 * The sample is synthesised in memory and played from a Blob URL. It never
 * reaches the audio cache, so trying a voice cannot fill the reader's disk with
 * a sentence it will never ask for again.
 *
 * One test at a time, across every panel: `active` below is module-level, so
 * starting a sample in one panel stops the one in another, and each button says
 * "Stop test" only while its own sample is the one being prepared or heard.
 * Leaving Settings unmounts the panels, and unmounting the owner stops it.
 */
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { TtsEngine } from '../core/types';
import { expand } from './lexicon';

/** What the button speaks. Short on purpose: a voice check, not a paragraph. */
export const VOICE_TEST_SENTENCE = 'This is how your book will sound.';

type Phase = 'idle' | 'preparing' | 'playing';

interface ActiveTest {
  owner: number;
  phase: Phase;
  stop(): void;
}

let active: ActiveTest | null = null;
let nextOwner = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** A string, so `useSyncExternalStore` gets a stable snapshot between renders. */
function snapshot(): string {
  return active === null ? '0:idle' : `${active.owner}:${active.phase}`;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stop the sample, whichever panel started it. */
export function stopVoiceTest(): void {
  const test = active;
  if (test === null) return;
  active = null;
  emit();
  test.stop();
}

export interface VoiceTestProps {
  /** The engine the sample is spoken with; its own voice list is elsewhere. */
  engine: TtsEngine;
  /** The voice the reader picked for that engine (empty = engine default). */
  voiceId?: string;
  /** The rate the book would use, so the sample sounds like the book will. */
  rate: number;
  /** Text to speak; defaults to {@link VOICE_TEST_SENTENCE}. */
  sample?: string;
  /**
   * Why testing is unavailable, in one line ("Download the model first").
   * When set the button is disabled and the reason sits under it.
   */
  disabledReason?: string | null;
  /** Voice panel's one button is primary; inside a model row it is secondary. */
  tone?: 'primary' | 'secondary';
}

export default function VoiceTest({
  engine,
  voiceId,
  rate,
  sample = VOICE_TEST_SENTENCE,
  disabledReason = null,
  tone = 'secondary',
}: VoiceTestProps) {
  const ownerRef = useRef(0);
  if (ownerRef.current === 0) ownerRef.current = nextOwner++;
  const owner = ownerRef.current;
  const run = useRef(0);
  const reasonId = useId();
  const [error, setError] = useState<string | null>(null);

  // The third argument keeps a server render (the settings page is also rendered to a
  // string in tests) from throwing: no test can be running before hydration.
  const snap = useSyncExternalStore(subscribe, snapshot, () => '0:idle');
  const [ownerPart, phasePart] = snap.split(':');
  const mine = Number(ownerPart) === owner;
  const phase: Phase = mine ? (phasePart as Phase) : 'idle';
  // A reason that arrives mid-sample (the model was deleted, the engine was
  // switched) must not disable the only way to silence it.
  const disabled = Boolean(disabledReason) && phase === 'idle';

  // Leaving Settings (or closing the disclosure) must not leave a sample
  // talking to itself; only the panel that owns it may stop it this way.
  useEffect(() => {
    return () => {
      if (active?.owner === owner) stopVoiceTest();
    };
  }, [owner]);

  const start = (): void => {
    setError(null);
    // One sample at a time: a test running in another panel stops now.
    stopVoiceTest();

    const token = run.current + 1;
    run.current = token;
    let cancelled = false;
    let audio: HTMLAudioElement | null = null;
    let url: string | null = null;

    const release = (): void => {
      if (audio !== null) {
        audio.pause();
        audio = null;
      }
      if (url !== null) {
        if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
        url = null;
      }
    };

    const test: ActiveTest = {
      owner,
      phase: 'preparing',
      stop: () => {
        cancelled = true;
        // A synthesis already in flight must not start playing afterwards.
        run.current += 1;
        release();
        // The platform voice speaks outside the DOM; this cancels it.
        engine.stop();
        setError(null);
      },
    };
    active = test;
    emit();

    const finish = (failure?: string): void => {
      if (active === test) {
        active = null;
        emit();
      }
      release();
      if (cancelled) return;
      if (failure !== undefined) setError(failure);
    };

    const speak = async (): Promise<void> => {
      const text = await expand(sample);
      if (cancelled || run.current !== token) return;

      if (typeof engine.synthesize === 'function') {
        // Still "Preparing…": the model is generating the sample, not playing it.
        const blob = await engine.synthesize(text, { voiceId: voiceId || undefined, rate });
        if (cancelled || run.current !== token) return;
        if (typeof URL.createObjectURL !== 'function') {
          finish('This browser cannot play the sample.');
          return;
        }
        url = URL.createObjectURL(blob);
        const element = new Audio(url);
        audio = element;
        element.addEventListener('ended', () => finish(), { once: true });
        element.addEventListener('error', () => finish('The sample could not be played.'), {
          once: true,
        });
        test.phase = 'playing';
        emit();
        // Older WebViews return nothing from play(); only a promise means the
        // autoplay policy may still refuse the sample.
        const played = element.play() as Promise<void> | undefined;
        if (played !== undefined) await played.catch(() => finish('The browser blocked playback.'));
        return;
      }

      // The system voice has no synthesize(): it speaks through the platform.
      test.phase = 'playing';
      emit();
      await engine.speak(
        [{ id: 'voice-test', text }],
        { voiceId: voiceId || undefined, rate },
        { onError: (err) => finish(err.message) },
      );
      finish();
    };

    void speak().catch((err: unknown) => finish(err instanceof Error ? err.message : String(err)));
  };

  const onClick = (): void => {
    if (phase !== 'idle') {
      stopVoiceTest();
      return;
    }
    start();
  };

  const label = phase === 'preparing' ? 'Preparing…' : phase === 'playing' ? 'Stop test' : 'Test voice';
  const status =
    phase === 'preparing'
      ? 'Preparing the sample…'
      : phase === 'playing'
        ? 'Playing the sample.'
        : (error ?? '');

  return (
    <>
      <div className="tts-test-row">
        <button
          type="button"
          className={`btn btn-${tone}`}
          // The house button is already --tap tall; keep the target explicit here
          // because this row can carry a long status and shrink the button.
          style={{ minHeight: 44, minWidth: 44 }}
          onClick={onClick}
          disabled={disabled}
          aria-describedby={disabled ? reasonId : undefined}
        >
          {label}
        </button>
        <p className="tts-status" role="status">
          {status}
        </p>
      </div>
      {disabled && disabledReason ? (
        <p className="field-hint" id={reasonId}>
          {disabledReason}
        </p>
      ) : null}
    </>
  );
}
