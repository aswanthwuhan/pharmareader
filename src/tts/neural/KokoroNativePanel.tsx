/**
 * Kokoro on-device settings: model size and download state, voice, thread count
 * and a speed measurement that reports the real-time factor measured natively.
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
import { isKokoroNativeAvailable, Kokoro, type KokoroStatus } from '../native/kokoroPlugin';

const ATTRIBUTION = 'Kokoro-82M by hexgrad (Apache-2.0) via sherpa-onnx (Apache-2.0)';
const SPEED_TEST_SENTENCE =
  'The half-life of digoxin is about thirty-six hours, prolonged in renal failure.';
const THREAD_OPTIONS = [2, 4, 6] as const;
const DEFAULT_THREADS = 4;

type PanelState = 'unsupported' | 'loading' | 'absent' | 'downloading' | 'ready' | 'error';

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${mb >= 100 ? mb.toFixed(0) : mb.toFixed(1)} MB`;
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
  const [error, setError] = useState<string | null>(null);
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
      setError(null);
      setVoices(await kokoroNativeEngine.listVoices());
    } catch (err) {
      setState('error');
      setError(message(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const download = async (): Promise<void> => {
    setState('downloading');
    setFraction(0);
    setError(null);
    setMeasure(null);
    try {
      await kokoroNativeEngine.prepare((value) => setFraction(clamp01(value)));
      await refresh();
    } catch (err) {
      setState('error');
      setError(message(err));
    }
  };

  const remove = async (): Promise<void> => {
    setError(null);
    setMeasure(null);
    try {
      await kokoroNativeEngine.deleteModel();
      await refresh();
    } catch (err) {
      setState('error');
      setError(message(err));
    }
  };

  const changeVoice = async (voiceId: string): Promise<void> => {
    try {
      await setSetting(KOKORO_VOICE_SETTING, voiceId);
    } catch (err) {
      setError(message(err));
    }
  };

  const changeThreads = async (threads: number): Promise<void> => {
    setError(null);
    try {
      await setSetting(KOKORO_THREADS_SETTING, threads);
      if (status?.loaded) await Kokoro.load({ threads });
      await refresh();
    } catch (err) {
      setError(message(err));
    }
  };

  const measureSpeed = async (): Promise<void> => {
    setMeasuring(true);
    setError(null);
    setMeasure(null);
    try {
      setMeasure(await kokoroNativeEngine.measure(SPEED_TEST_SENTENCE, { rate: 1 }, (value) => setFraction(clamp01(value))));
      await refresh();
    } catch (err) {
      setError(message(err));
    } finally {
      setMeasuring(false);
    }
  };

  const voiceOptions = useMemo(() => {
    if (voices.length > 0) return voices;
    return [{ id: String(DEFAULT_KOKORO_SID), name: 'af_heart', lang: 'en-US' }];
  }, [voices]);

  const selectedVoice = voiceOptions.some((voice) => voice.id === savedVoice) ? savedVoice : voiceOptions[0].id;
  const threads = THREAD_OPTIONS.includes(savedThreads as (typeof THREAD_OPTIONS)[number])
    ? savedThreads
    : DEFAULT_THREADS;

  const sizeLabel = status && status.sizeBytes > 0 ? formatBytes(status.sizeBytes) : 'not downloaded';
  const ready = state === 'ready';

  return (
    <section className="tts-section" aria-labelledby="kokoro-native-heading">
      <h2 id="kokoro-native-heading">Kokoro (on-device)</h2>
      <p className="tts-hint">
        Runs Kokoro-82M entirely on this phone through sherpa-onnx — no PC and no server. The model is a 334 MB
        download that is stored in the app&apos;s private storage and survives restarts.
      </p>

      <div className="tts-field-row">
        <div className="tts-field">
          <label htmlFor="kokoro-native-size">Model</label>
          <output id="kokoro-native-size" className="tts-value">
            {status?.modelId ? `${status.modelId} · ${sizeLabel}` : sizeLabel}
          </output>
        </div>
        <div className="tts-field">
          <label htmlFor="kokoro-native-threads">Threads</label>
          <select
            id="kokoro-native-threads"
            value={threads}
            onChange={(event) => void changeThreads(Number(event.target.value))}
            disabled={state === 'unsupported' || state === 'downloading'}
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

      <div className="tts-field">
        <label htmlFor="kokoro-native-voice">Voice</label>
        <select
          id="kokoro-native-voice"
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
        <p className="tts-tip">
          The native Kokoro engine is only available in the Android app. In the browser use the system voice, or
          connect to a Kokoro server.
        </p>
      )}

      {state === 'downloading' && (
        <p className="tts-status" role="status">
          {fraction >= 1
            ? 'Extracting and loading the model…'
            : `Downloading model… ${Math.round(clamp01(fraction) * 100)}%`}
        </p>
      )}

      {state === 'ready' && (
        <p className="tts-status" role="status">
          Ready on {formatThreads(status?.threads ?? threads)}
          {status?.sampleRate ? ` · ${Math.round(status.sampleRate / 1000)} kHz` : ''}
          {status?.loaded ? ' · loaded' : ''}
        </p>
      )}

      {error && (
        <p className="tts-error" role="alert">
          {error}
        </p>
      )}

      <div className="tts-actions">
        {(state === 'absent' || state === 'error') && (
          <button type="button" className="tts-button" onClick={() => void download()}>
            Download model (334 MB)
          </button>
        )}
        {state === 'downloading' && (
          <button type="button" className="tts-button" disabled>
            Downloading…
          </button>
        )}
        {(state === 'ready' || state === 'absent') && (
          <button type="button" className="tts-button" onClick={() => void measureSpeed()} disabled={!ready || measuring}>
            {measuring ? 'Measuring…' : 'Measure speed'}
          </button>
        )}
        {ready && (
          <button type="button" className="tts-link danger" onClick={() => void remove()}>
            Delete model
          </button>
        )}
      </div>

      {measure && (
        <div className="tts-tip">
          <p className="tts-value">
            RTF {measure.rtf.toFixed(2)} · {Math.round(measure.durationMs)} ms of audio in{' '}
            {Math.round(measure.elapsedMs)} ms · {Math.round(measure.sampleRate / 1000)} kHz
          </p>
          <p className="tts-value">{verdict(measure.rtf)}</p>
        </div>
      )}

      <p className="tts-hint">{status?.attribution ?? ATTRIBUTION}</p>
    </section>
  );
}
