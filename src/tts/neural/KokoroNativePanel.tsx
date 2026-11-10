/**
 * Kokoro on-device settings: model size and download state, voice, thread count
 * and a speed measurement that reports the real-time factor measured natively.
 *
 * The download is 334 MB, so the panel warns before it starts on mobile data, shows real
 * progress, offers to resume an interrupted download and refuses to start when the phone
 * does not have the ~750 MB of free space the download plus the unpacked model need.
 *
 * Only the Android build has the native sherpa-onnx plugin; on the web the panel
 * explains that and points at the system voice instead.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { setSetting, useSetting } from '../../core/settings';
import type { TtsVoice } from '../../core/types';
import {
  DEFAULT_KOKORO_SID,
  KOKORO_THREADS_SETTING,
  KOKORO_VOICE_SETTING,
  kokoroNativeEngine,
  type KokoroMeasureResult,
} from '../native/kokoroNativeEngine';
import {
  downloadLabel,
  formatBytes,
  meteredWarning,
  resumeFraction,
  storageWarning,
} from '../native/kokoroDownload';
import { measureRtf, rtfSettingKey } from './benchmark';
import {
  copyText,
  describeKokoroFailure,
  type KokoroFailure,
  type KokoroStage,
} from '../native/kokoroFailure';
import { isKokoroNativeAvailable, Kokoro, type KokoroStatus } from '../native/kokoroPlugin';
import '../tts.css';

const ATTRIBUTION = 'Kokoro-82M by hexgrad (Apache-2.0) via sherpa-onnx (Apache-2.0)';
const SPEED_TEST_SENTENCE =
  'The half-life of digoxin is about thirty-six hours, prolonged in renal failure.';
const THREAD_OPTIONS = [2, 4, 6] as const;
const DEFAULT_THREADS = 4;
/** Minimum touch target the rest of the app uses. */
const TAP_TARGET = { minHeight: 44, minWidth: 44, display: 'inline-flex', alignItems: 'center' } as const;
/** The diagnostic block is plain text; no stylesheet rule exists for a <pre> in the panel. */
const DETAILS_STYLE = {
  margin: '8px 0 0',
  padding: '8px',
  maxWidth: '100%',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  fontSize: 12,
  lineHeight: 1.45,
  textAlign: 'left',
} as const;

type PanelState = 'unsupported' | 'loading' | 'absent' | 'downloading' | 'ready' | 'error';
type CopyState = 'idle' | 'copied' | 'failed';

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function formatThreads(value: number): string {
  return `${value} thread${value === 1 ? '' : 's'}`;
}

function verdict(rtf: number): string {
  return rtf < 1
    ? 'Faster than real-time ✓'
    : 'Slower than real-time — pre-render chapters or use the system voice';
}

export default function KokoroNativePanel(): React.JSX.Element {
  const [state, setState] = useState<PanelState>('loading');
  const [status, setStatus] = useState<KokoroStatus | null>(null);
  const [voices, setVoices] = useState<TtsVoice[]>([]);
  const [fraction, setFraction] = useState(0);
  const [failure, setFailure] = useState<KokoroFailure | null>(null);
  const [stage, setStage] = useState<KokoroStage | null>(null);
  const [copied, setCopied] = useState<CopyState>('idle');
  const [measuring, setMeasuring] = useState(false);
  const [measure, setMeasure] = useState<KokoroMeasureResult | null>(null);

  const savedVoice = useSetting<string>(KOKORO_VOICE_SETTING, String(DEFAULT_KOKORO_SID));
  const savedThreads = useSetting<number>(KOKORO_THREADS_SETTING, DEFAULT_THREADS);

  const refresh = useCallback(async () => {
    if (!isKokoroNativeAvailable()) {
      setState('unsupported');
      return;
    }
    try {
      const next = await Kokoro.status();
      setStatus(next);
      setState(next.downloaded ? 'ready' : 'absent');
      setFailure(null);
      setVoices(await kokoroNativeEngine.listVoices());
    } catch (err) {
      setState('error');
      // The query itself failed, so there is no status object to describe the model with.
      setFailure(describeKokoroFailure('status', err, null));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (copied === 'idle') return;
    const timer = window.setTimeout(() => setCopied('idle'), 2500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const download = async (): Promise<void> => {
    setState('downloading');
    setFraction(resumeFraction(status?.partialBytes, status?.archiveBytes));
    setFailure(null);
    setMeasure(null);
    setCopied('idle');
    // The engine reports the stage it is in; it is kept in a local as well because the state
    // update is asynchronous and the catch block needs the stage that actually failed.
    let failedAt: KokoroStage = 'status';
    try {
      await kokoroNativeEngine.prepare(
        (value) => setFraction(clamp01(value)),
        (next) => {
          failedAt = next;
          setStage(next);
        }
      );
      setStage(null);
      await refresh();
      // 'auto' engine choice only picks a model with a stored RTF, so measure right away.
      void measureRtf(kokoroNativeEngine).catch(() => undefined);
    } catch (err) {
      setStage(null);
      setState('error');
      setFailure(describeKokoroFailure(failedAt, err, status));
    }
  };

  const copyDetails = async (): Promise<void> => {
    if (!failure) return;
    setCopied((await copyText(failure.details)) ? 'copied' : 'failed');
  };

  const remove = async (): Promise<void> => {
    setFailure(null);
    setMeasure(null);
    setCopied('idle');
    try {
      await kokoroNativeEngine.deleteModel();
      await refresh();
    } catch (err) {
      setState('error');
      setFailure(describeKokoroFailure('delete', err, status));
    }
  };

  const changeVoice = async (voiceId: string): Promise<void> => {
    try {
      await setSetting(KOKORO_VOICE_SETTING, voiceId);
    } catch (err) {
      setFailure(describeKokoroFailure('status', err, status));
    }
  };

  const changeThreads = async (threads: number): Promise<void> => {
    setFailure(null);
    try {
      await setSetting(KOKORO_THREADS_SETTING, threads);
      if (status?.loaded) await Kokoro.load({ threads });
      await refresh();
    } catch (err) {
      setFailure(describeKokoroFailure('load', err, status));
    }
  };

  const measureSpeed = async (): Promise<void> => {
    setMeasuring(true);
    setFailure(null);
    setMeasure(null);
    try {
      const result = await kokoroNativeEngine.measure(SPEED_TEST_SENTENCE, { rate: 1 }, (value) =>
        setFraction(clamp01(value))
      );
      setMeasure(result);
      // Same key measureRtf writes; the engine registry reads it for 'auto'.
      await setSetting(rtfSettingKey('kokoro'), result.rtf);
      await refresh();
    } catch (err) {
      setFailure(describeKokoroFailure('measure', err, status));
    } finally {
      setMeasuring(false);
    }
  };

  const voiceOptions = useMemo(() => {
    if (voices.length > 0) return voices;
    return [{ id: String(DEFAULT_KOKORO_SID), name: 'af_heart', lang: 'en-US' }];
  }, [voices]);

  const selectedVoice = voiceOptions.some((voice) => voice.id === savedVoice)
    ? savedVoice
    : voiceOptions[0].id;
  const threads = THREAD_OPTIONS.includes(savedThreads as (typeof THREAD_OPTIONS)[number])
    ? savedThreads
    : DEFAULT_THREADS;

  const downloaded = status?.downloaded === true;
  const sizeLabel = status && status.sizeBytes > 0 ? formatBytes(status.sizeBytes) : 'not downloaded';
  const ready = state === 'ready';
  const resumable = resumeFraction(status?.partialBytes, status?.archiveBytes);
  const spaceWarning = storageWarning(status?.freeBytes, status?.requiredBytes);
  const dataWarning = meteredWarning(status?.metered, downloaded);
  const busy = state === 'downloading';

  const percent = Math.round(clamp01(fraction) * 100);
  const chipLabel =
    state === 'unsupported'
      ? 'Not available here'
      : state === 'loading'
        ? 'Checking…'
        : state === 'downloading'
          ? `Downloading ${percent}%`
          : state === 'error'
            ? 'Error'
            : downloaded
              ? 'Ready'
              : 'Not downloaded';
  const chipTone =
    state === 'ready'
      ? 'is-ready'
      : state === 'error'
        ? 'is-error'
        : state === 'downloading' || state === 'loading'
          ? 'is-busy'
          : '';
  const progressLabel =
    stage === 'unpack' || fraction >= 1
      ? 'Unpacking the model archive… (this is the slow part)'
      : stage === 'load'
        ? 'Loading the model into memory…'
        : `Downloading model… ${percent}%${resumable > 0 && resumable < 1 ? ' (resumed)' : ''}`;

  return (
    <section className="kokoro-panel" aria-labelledby="kokoro-native-heading" aria-busy={busy}>
      <header className="kokoro-head">
        <div>
          <h3 className="kokoro-title" id="kokoro-native-heading">
            Kokoro (on-device)
          </h3>
          <p className="kokoro-sub">Kokoro-82M through sherpa-onnx · 334 MB model</p>
        </div>
        <span className={chipTone ? `status-chip ${chipTone}` : 'status-chip'}>
          <span className="status-dot" aria-hidden="true" />
          {chipLabel}
        </span>
      </header>

      <p className="field-hint">
        Runs Kokoro-82M entirely on this phone through sherpa-onnx — no PC and no server. The model is a 334 MB download
        that is stored in the app&apos;s private storage and survives restarts.
      </p>

      <div className="tts-field-grid">
        <div className="field">
          <span className="field-label" id="kokoro-native-size-label">
            Model
          </span>
          <output id="kokoro-native-size" className="tts-value" aria-labelledby="kokoro-native-size-label">
            {status?.modelId ? `${status.modelId} · ${sizeLabel}` : sizeLabel}
          </output>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="kokoro-native-threads">
            Threads
          </label>
          <select
            id="kokoro-native-threads"
            className="input"
            value={threads}
            onChange={(event) => void changeThreads(Number(event.target.value))}
            disabled={state === 'unsupported' || busy}
          >
            {THREAD_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {formatThreads(option)}
                {option === DEFAULT_THREADS ? ' (recommended)' : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="kokoro-native-voice">
          Voice
        </label>
        <select
          id="kokoro-native-voice"
          className="input"
          value={selectedVoice}
          onChange={(event) => void changeVoice(event.target.value)}
          disabled={state === 'unsupported'}
        >
          {voiceOptions.map((voice) => (
            <option key={voice.id} value={voice.id}>
              {voice.name} ({voice.lang})
            </option>
          ))}
        </select>
      </div>

      {state === 'unsupported' && (
        <div className="banner banner-info">
          <p>
            The native Kokoro engine is only available in the Android app. In the browser, use the in-browser Kokoro or
            Pocket TTS model, or the system voice.
          </p>
        </div>
      )}

      {busy && (
        <div className="kokoro-progress">
          <progress value={clamp01(fraction)} max={1} aria-label="Kokoro model download progress" />
          <p className="tts-status" role="status">
            {progressLabel}
          </p>
        </div>
      )}

      {state === 'ready' && (
        <p className="tts-status" role="status">
          Ready on {formatThreads(status?.threads ?? threads)}
          {status?.provider ? ` (${status.provider})` : ''}
          {status?.sampleRate ? ` · ${Math.round(status.sampleRate / 1000)} kHz` : ''}
          {status?.loaded ? ' · loaded' : ''}
        </p>
      )}

      {dataWarning && (
        <div className="banner banner-info" role="status">
          <p>{dataWarning}</p>
        </div>
      )}

      {spaceWarning && (
        <div className="banner banner-error" role="alert">
          <p>{spaceWarning}</p>
        </div>
      )}

      {!busy && !downloaded && resumable > 0 && resumable < 1 && (
        <p className="field-hint" role="status">
          A partial download is saved ({Math.round(resumable * 100)}% of {formatBytes(status?.archiveBytes)}). Resuming
          continues from there.
        </p>
      )}

      {failure && (
        <div className="kokoro-diagnostics">
          <div className="banner banner-error" role="alert">
            <p>{failure.message}</p>
          </div>
          <details>
            <summary>Error details</summary>
            <pre style={DETAILS_STYLE}>{failure.details}</pre>
          </details>
          <button
            type="button"
            className="btn btn-secondary"
            style={TAP_TARGET}
            onClick={() => void copyDetails()}
          >
            {copied === 'copied'
              ? 'Copied ✓'
              : copied === 'failed'
                ? 'Copy failed — select the details above'
                : 'Copy error details'}
          </button>
        </div>
      )}

      <div className="tts-actions">
        {(state === 'absent' || state === 'error') && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void download()}
            disabled={spaceWarning !== null}
          >
            {downloaded
              ? 'Try loading again'
              : downloadLabel({
                  downloaded: false,
                  partialBytes: status?.partialBytes,
                  archiveBytes: status?.archiveBytes,
                })}
          </button>
        )}
        {busy && (
          <button type="button" className="btn btn-primary" disabled>
            Downloading…
          </button>
        )}
        {(state === 'ready' || state === 'absent') && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void measureSpeed()}
            disabled={!ready || measuring}
          >
            {measuring ? 'Measuring…' : 'Measure speed'}
          </button>
        )}
        {ready && (
          <button
            type="button"
            className="btn btn-ghost"
            style={TAP_TARGET}
            onClick={() => void remove()}
          >
            Delete model
          </button>
        )}
      </div>

      {measure && (
        <div className="kokoro-measure">
          <p>
            RTF {measure.rtf.toFixed(2)} · {Math.round(measure.durationMs)} ms of audio in {Math.round(measure.elapsedMs)}{' '}
            ms · {Math.round(measure.sampleRate / 1000)} kHz
          </p>
          <p>{verdict(measure.rtf)}</p>
        </div>
      )}

      <p className="field-hint">{status?.attribution ?? ATTRIBUTION}</p>
    </section>
  );
}
