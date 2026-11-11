/**
 * Kokoro on-device settings: model build and download state, voice, thread count
 * and a speed measurement that reports the real-time factor measured natively.
 *
 * Two builds can be installed: the int8 graph (126 MB, cooler, the default) and the
 * original fp32 graph (334 MB, what existing users already have). The panel offers the
 * int8 download to an fp32 user and only offers to delete the old fp32 files once the int8
 * model has loaded successfully. The download warns before it starts on mobile data, shows
 * real progress, offers to resume an interrupted download and refuses to start when the
 * phone does not have the free space the download plus the unpacked model need.
 *
 * Only the Android build has the native sherpa-onnx plugin; on the web the panel
 * explains that and points at the system voice instead.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { setSetting, useSetting } from '../../core/settings';
import type { TtsVoice } from '../../core/types';
import { resetDownload, startDownload, useDownload, type DownloadReporter } from '../downloads';
import {
  DEFAULT_KOKORO_MODEL,
  DEFAULT_KOKORO_SID,
  KOKORO_INT8_READY_SETTING,
  KOKORO_MODEL_SETTING,
  KOKORO_THREADS_SETTING,
  KOKORO_VOICE_SETTING,
  kokoroNativeEngine,
  type KokoroMeasureResult,
} from '../native/kokoroNativeEngine';
import {
  downloadLabel,
  downloadStageOf,
  followRunningDownload,
  formatBytes,
  isBusyError,
  meteredWarning,
  modelArchiveBytes,
  modelState,
  resumeFraction,
  storageWarning,
  tagDownloadStage,
  type KokoroModelKey,
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
// This panel's own arrangement: the shared .kokoro-* rules in tts.css describe a
// card, and inside an accordion body a model is a row.
import './kokoro-native.css';

const ATTRIBUTION = 'Kokoro-82M by hexgrad (Apache-2.0) via sherpa-onnx (Apache-2.0)';
/** The one native model download, shared by every mount of this panel. */
export const KOKORO_DOWNLOAD_ID = 'kokoro';
const SPEED_TEST_SENTENCE =
  'The half-life of digoxin is about thirty-six hours, prolonged in renal failure.';
const THREAD_OPTIONS = [1, 2, 4] as const;
const DEFAULT_THREADS = 2;
/**
 * Labels are literal, not derived from the default: 2 is "(recommended)" because it is the
 * balance the measurements picked, and 1 is the coolest but usually lags behind real time.
 */
const THREAD_LABELS: Record<number, string> = {
  1: '1 thread (coolest, may pause between sentences)',
  2: '2 threads (recommended)',
  4: '4 threads (faster, gets hot)',
};
const THREAD_WARNING =
  'More threads finish sooner but keep more cores busy, and the phone gets warmer.';
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
  const download = useDownload(KOKORO_DOWNLOAD_ID);
  const [shell, setShell] = useState<PanelState>('loading');
  const [status, setStatus] = useState<KokoroStatus | null>(null);
  const [voices, setVoices] = useState<TtsVoice[]>([]);
  const [failure, setFailure] = useState<KokoroFailure | null>(null);
  const [copied, setCopied] = useState<CopyState>('idle');
  const [measuring, setMeasuring] = useState(false);
  const [measure, setMeasure] = useState<KokoroMeasureResult | null>(null);

  const savedVoice = useSetting<string>(KOKORO_VOICE_SETTING, String(DEFAULT_KOKORO_SID));
  const savedThreads = useSetting<number>(KOKORO_THREADS_SETTING, DEFAULT_THREADS);
  const savedModel = useSetting<string>(KOKORO_MODEL_SETTING, DEFAULT_KOKORO_MODEL);
  const int8Ready = useSetting<boolean>(KOKORO_INT8_READY_SETTING, false);
  const chosenModel: KokoroModelKey = savedModel === 'fp32' ? 'fp32' : 'int8';

  const refresh = useCallback(async () => {
    if (!isKokoroNativeAvailable()) {
      setShell('unsupported');
      return;
    }
    try {
      // Ask about the saved build: the plugin answers about the one that is installed,
      // which is the build the reader would actually speak with.
      const next = await Kokoro.status({ model: chosenModel });
      setStatus(next);
      setShell(next.downloaded ? 'ready' : 'absent');
      setFailure(null);
      setVoices(await kokoroNativeEngine.listVoices());
    } catch (err) {
      setShell('error');
      // The query itself failed, so there is no status object to describe the model with.
      setFailure(describeKokoroFailure('status', err, null));
    }
  }, [chosenModel]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A download outlives the panel. When it ends — here or while the user was on
  // another screen — pick up the final model state (size, threads, "Ready").
  useEffect(() => {
    if (download.status === 'done' || download.status === 'error') void refresh();
  }, [download.status, refresh]);

  useEffect(() => {
    if (copied === 'idle') return;
    const timer = window.setTimeout(() => setCopied('idle'), 2500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  /**
   * Download the archive, then load the model — outside the component, so leaving
   * Settings cannot stop it. The native plugin downloads on its own io thread and
   * keeps going after the WebView stops listening.
   */
  const runDownload = useCallback(async (report: DownloadReporter): Promise<void> => {
    const forward = (stage: KokoroStage): void => {
      if (stage === 'download' || stage === 'unpack' || stage === 'load') report({ stage });
    };
    // The catch needs the stage that actually failed, not the last rendered one.
    let failedAt: KokoroStage = 'status';
    const attempt = async (): Promise<void> => {
      await kokoroNativeEngine.prepare(
        (value) => report({ fraction: clamp01(value) }),
        (next) => {
          failedAt = next;
          forward(next);
        }
      );
    };

    try {
      await attempt();
      // 'auto' engine choice only picks a model with a stored RTF, so measure right away.
      void measureRtf(kokoroNativeEngine).catch(() => undefined);
      return;
    } catch (err) {
      // BUSY is not a failure: the plugin refused a second download because the
      // first one (a previous mount, or the native side itself) is still running.
      // Wait for that one instead of reporting "download error".
      if (!isBusyError(err)) throw tagDownloadStage(err, failedAt);
    }

    report({ stage: 'download' });
    try {
      await followRunningDownload({
        status: () => Kokoro.status({ model: chosenModel }),
        listen: async (onFraction) => {
          const handle = await Kokoro.addListener('downloadProgress', (progress) =>
            onFraction(progress.fraction)
          );
          return () => {
            void handle.remove().catch(() => undefined);
          };
        },
        onProgress: (value) => report({ fraction: value }),
        onUnpacking: () => {
          failedAt = 'unpack';
          forward('unpack');
        },
      });
      // The archive is complete; load it the way the first call would have.
      failedAt = 'load';
      await attempt();
    } catch (err) {
      throw tagDownloadStage(err, failedAt);
    }
  }, [chosenModel]);

  /**
   * Start (or resume) the download of one build. The setting is written first because
   * {@code prepare()} reads the saved build, and an fp32 user clicking "Download the lighter
   * INT8 model" must get int8 rather than another look at the model they already have.
   */
  const downloadNow = async (model: KokoroModelKey = chosenModel): Promise<void> => {
    setFailure(null);
    setMeasure(null);
    setCopied('idle');
    // Always written: an unset setting lets prepare() fall back to the build already
    // installed, which is exactly what this button must not do.
    {
      try {
        await setSetting(KOKORO_MODEL_SETTING, model);
      } catch (err) {
        setFailure(describeKokoroFailure('status', err, status));
        return;
      }
    }
    void startDownload(KOKORO_DOWNLOAD_ID, runDownload);
  };

  const remove = async (model?: KokoroModelKey): Promise<void> => {
    setFailure(null);
    setMeasure(null);
    setCopied('idle');
    try {
      await kokoroNativeEngine.deleteModel(model);
      resetDownload(KOKORO_DOWNLOAD_ID);
      await refresh();
    } catch (err) {
      setShell('error');
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
      if (status?.loaded) await Kokoro.load({ threads, model: chosenModel });
      await refresh();
    } catch (err) {
      setFailure(describeKokoroFailure('load', err, status));
    }
  };

  /** Switch between the two installed builds and reload the session when one is loaded. */
  const changeModel = async (model: KokoroModelKey): Promise<void> => {
    setFailure(null);
    setMeasure(null);
    try {
      await setSetting(KOKORO_MODEL_SETTING, model);
      if (status?.loaded) await Kokoro.load({ model, threads });
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
      const result = await kokoroNativeEngine.measure(SPEED_TEST_SENTENCE, { rate: 1 });
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
  const savedThreadCount = Number(savedThreads);
  // A value saved by an older build (6, for example) is shown as-is instead of being
  // silently rewritten: the select gets an extra "(saved)" option and the warning covers it.
  const threads =
    Number.isFinite(savedThreadCount) && savedThreadCount >= 1
      ? Math.round(savedThreadCount)
      : DEFAULT_THREADS;
  const threadsOffered = (THREAD_OPTIONS as readonly number[]).includes(threads);

  const downloaded = status?.downloaded === true;
  const sizeLabel = status && status.sizeBytes > 0 ? formatBytes(status.sizeBytes) : 'not downloaded';
  // Sizes and install state per build, straight from the Java descriptors via status().
  const int8 = modelState(status?.models, 'int8');
  const fp32 = modelState(status?.models, 'fp32');
  const bothInstalled = int8?.downloaded === true && fp32?.downloaded === true;
  const int8Bytes = modelArchiveBytes(status?.models, 'int8');
  const fp32Bytes = modelArchiveBytes(status?.models, 'fp32');
  /** The build the plugin resolved: an fp32-only install answers "fp32" even when int8 is saved. */
  const activeModel: KokoroModelKey = status?.model === 'fp32' ? 'fp32' : chosenModel;
  const activeBytes = modelArchiveBytes(status?.models, activeModel);
  const downloading = download.status === 'downloading' || download.status === 'unpacking';
  // A download that failed before the panel was mounted still has to be reported:
  // the store carries the rejection and the stage it happened in.
  const downloadFailure =
    download.status === 'error'
      ? describeKokoroFailure(
          downloadStageOf(download.cause) ?? download.stage,
          download.cause ?? download.error ?? 'The download failed.',
          status
        )
      : null;
  const state: PanelState =
    shell === 'unsupported'
      ? 'unsupported'
      : downloading
        ? 'downloading'
        : downloadFailure
          ? 'error'
          : download.status === 'done'
            ? 'ready'
            : shell;
  const shownFailure = downloadFailure ?? failure;
  const fraction = download.fraction;
  const stage = downloading ? download.stage : null;
  const ready = state === 'ready';
  const resumable = resumeFraction(status?.partialBytes, status?.archiveBytes);
  const spaceWarning = storageWarning(status?.freeBytes, status?.requiredBytes);
  const dataWarning = meteredWarning(status?.metered, downloaded, status?.archiveBytes);
  const busy = downloading;

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
            : state === 'ready'
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
  // `load` comes last in the store's sequence and keeps fraction 1, so it has to
  // be tested before the "100% means unpacking" rule or it never shows.
  const progressLabel =
    stage === 'load'
      ? 'Loading the model into memory…'
      : stage === 'unpack' || fraction >= 1
        ? 'Unpacking the model archive… (this is the slow part)'
        : `Downloading model… ${percent}%${resumable > 0 && resumable < 1 ? ' (resumed)' : ''}`;

  const copyDetails = async (): Promise<void> => {
    if (!shownFailure) return;
    setCopied((await copyText(shownFailure.details)) ? 'copied' : 'failed');
  };

  return (
    <section className="kokoro-panel" aria-labelledby="kokoro-native-heading" aria-busy={busy}>
      <header className="kokoro-head">
        <div className="kokoro-head-main">
          <h3 className="kokoro-title" id="kokoro-native-heading">
            Kokoro (on-device)
          </h3>
          <p className="kokoro-sub">Kokoro-82M through sherpa-onnx · {formatBytes(activeBytes)} model</p>
        </div>
        <span className={chipTone ? `status-chip ${chipTone}` : 'status-chip'}>
          <span className="status-dot" aria-hidden="true" />
          {chipLabel}
        </span>
      </header>

      {/* Why there is nothing to download comes before the controls it disables. */}
      {state === 'unsupported' && (
        <div className="banner banner-info">
          <p>
            The native Kokoro engine is only available in the Android app. In the browser, use the in-browser Kokoro or
            Pocket TTS model, or the system voice.
          </p>
        </div>
      )}

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

      {busy && (
        <div className="kokoro-progress">
          <progress value={clamp01(fraction)} max={1} aria-label="Kokoro model download progress" />
          <p className="tts-status" role="status">
            {progressLabel}
          </p>
        </div>
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

      {shownFailure && (
        <div className="kokoro-diagnostics">
          <div className="banner banner-error" role="alert">
            <p>{shownFailure.message}</p>
          </div>
          <details className="disc-sub">
            <summary>Error details</summary>
            <pre style={DETAILS_STYLE}>{shownFailure.details}</pre>
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
            className="btn btn-secondary"
            onClick={() => void downloadNow()}
            disabled={spaceWarning !== null}
          >
            {downloaded
              ? 'Try loading again'
              : downloadLabel({
                  downloaded: false,
                  partialBytes: status?.partialBytes,
                  // From the active descriptor (126 MB for int8, 334 MB for fp32).
                  archiveBytes: status?.archiveBytes,
                })}
          </button>
        )}
        {busy && (
          <button type="button" className="btn btn-secondary" disabled>
            Downloading…
          </button>
        )}
        {!busy && downloaded && int8 && int8.downloaded === false && (
          <button type="button" className="btn btn-secondary" onClick={() => void downloadNow('int8')}>
            Download the lighter INT8 model ({formatBytes(int8Bytes)})
          </button>
        )}
        {ready && (
          <button
            type="button"
            className="btn btn-ghost"
            style={TAP_TARGET}
            onClick={() => void remove(activeModel)}
          >
            Delete model
          </button>
        )}
        {/* Only after int8 has loaded once: until then the fp32 files are the safety net. */}
        {!busy && bothInstalled && int8Ready === true && (
          <button
            type="button"
            className="btn btn-ghost"
            style={TAP_TARGET}
            onClick={() => void remove('fp32')}
          >
            Delete the older fp32 model ({formatBytes(fp32?.sizeBytes ?? fp32Bytes)})
          </button>
        )}
      </div>

      <details className="disc-sub">
        <summary>Details</summary>
        <div className="disc-sub-body">
          <div className="tts-field-grid">
            {bothInstalled && (
              <div className="field">
                <label className="field-label" htmlFor="kokoro-native-model">
                  Build
                </label>
                <select
                  id="kokoro-native-model"
                  className="input"
                  value={chosenModel}
                  onChange={(event) =>
                    void changeModel(event.target.value === 'fp32' ? 'fp32' : 'int8')
                  }
                  disabled={state === 'unsupported' || busy}
                >
                  <option value="int8">Lighter (int8) · {formatBytes(int8Bytes)}</option>
                  <option value="fp32">Full precision · {formatBytes(fp32Bytes)}</option>
                </select>
              </div>
            )}
            <div className="field">
              <span className="field-label" id="kokoro-native-size-label">
                Installed
              </span>
              <output
                id="kokoro-native-size"
                className="tts-value"
                aria-labelledby="kokoro-native-size-label"
                title={status?.modelId}
              >
                {status?.modelLabel ? `${status.modelLabel} · ${sizeLabel}` : sizeLabel}
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
                    {THREAD_LABELS[option]}
                  </option>
                ))}
                {!threadsOffered && (
                  <option value={threads}>{formatThreads(threads)} (saved)</option>
                )}
              </select>
              {threads > 2 && (
                <p className="field-hint" role="status">
                  {THREAD_WARNING}
                </p>
              )}
            </div>
          </div>

          {state === 'ready' && (
            <p className="tts-status" role="status">
              Ready on {formatThreads(status?.threads ?? threads)}
              {status?.provider ? ` (${status.provider})` : ''}
              {status?.sampleRate ? ` · ${Math.round(status.sampleRate / 1000)} kHz` : ''}
              {status?.loaded ? ' · loaded' : ''}
            </p>
          )}

          {measure && (
            <div className="kokoro-measure">
              <p>
                RTF {measure.rtf.toFixed(2)} · {Math.round(measure.durationMs)} ms of audio in{' '}
                {Math.round(measure.elapsedMs)} ms · {Math.round(measure.sampleRate / 1000)} kHz
              </p>
              <p>{verdict(measure.rtf)}</p>
            </div>
          )}

          {(state === 'ready' || state === 'absent') && (
            <div className="tts-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void measureSpeed()}
                disabled={!ready || measuring}
              >
                {measuring ? 'Measuring…' : 'Measure speed'}
              </button>
            </div>
          )}

          <p className="field-hint">{status?.attribution ?? ATTRIBUTION}</p>

          <p className="field-hint">
            Runs Kokoro-82M entirely on this phone through sherpa-onnx — no PC and no server. The model is a{' '}
            {formatBytes(activeBytes)} download that is stored in the app&apos;s private storage and survives restarts.
            The int8 build sounds the same and keeps the phone cooler; the full-precision build is kept until you delete
            it.
          </p>
        </div>
      </details>
    </section>
  );
}
