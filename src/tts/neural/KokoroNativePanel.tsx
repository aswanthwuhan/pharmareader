/**
 * Kokoro on-device settings: model state, voice, thread count and a speed measurement
 * that reports the real-time factor measured natively.
 *
 * One model: the full-precision 334 MB graph, the build the plugin shipped before v0.3.3.
 * The lighter int8 build v0.3.3 offered is gone from here — the user found its audio bad —
 * but its files can still be on disk, so the panel offers to delete them. The download
 * warns before it starts on mobile data, shows real progress, offers to resume an
 * interrupted download and refuses to start when the phone does not have the free space
 * the download plus the unpacked model need.
 *
 * Only the Android build has the native sherpa-onnx plugin; on the web the panel
 * explains that and points at the system voice instead.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { setSetting, useSetting } from '../../core/settings';
import type { TtsVoice } from '../../core/types';
import { resetDownload, startDownload, useDownload } from '../downloads';
import { TTS_RATE_SETTING } from '../TtsSettings';
import VoiceTest from '../VoiceTest';
import {
  DEFAULT_KOKORO_MODEL,
  DEFAULT_KOKORO_SID,
  DEFAULT_KOKORO_THREADS,
  KOKORO_THREADS_SETTING,
  KOKORO_VOICE_SETTING,
  fp32Installed,
  kokoroNativeEngine,
  type KokoroMeasureResult,
} from '../native/kokoroNativeEngine';
import {
  KOKORO_REQUIRED_BYTES,
  downloadLabel,
  downloadStageOf,
  formatBytes,
  meteredWarning,
  modelArchiveBytes,
  modelState,
  resumeFraction,
  storageWarning,
  type KokoroModelKey,
} from '../native/kokoroDownload';
import { KOKORO_DOWNLOAD_ID, runKokoroNativeDownload } from '../native/kokoroDownloadCore';
import { rtfSettingKey } from './benchmark';
import {
  copyText,
  describeKokoroFailure,
  type KokoroFailure,
} from '../native/kokoroFailure';
import { isKokoroNativeAvailable, Kokoro, type KokoroStatus } from '../native/kokoroPlugin';
import '../tts.css';
// This panel's own arrangement: the shared .kokoro-* rules in tts.css describe a
// card, and inside an accordion body a model is a row.
import './kokoro-native.css';

const ATTRIBUTION = 'Kokoro-82M by hexgrad (Apache-2.0) via sherpa-onnx (Apache-2.0)';
/** Re-exported so every existing caller and test can keep importing it from the panel. */
export { KOKORO_DOWNLOAD_ID };
const SPEED_TEST_SENTENCE =
  'The half-life of digoxin is about thirty-six hours, prolonged in renal failure.';
const THREAD_OPTIONS = [1, 2, 4] as const;
/**
 * Labels are literal, not derived from the default: 2 is "(recommended)" because it is the
 * balance the measurements picked, and 1 is the coolest option but usually finishes a
 * sentence behind real time.
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

/**
 * The engine names its voices `accent + gender + name` (`af_heart`, `bm_george`), which is
 * unreadable in a picker. This spells it out — "Heart · American female (en-US)" — and
 * leaves any name that does not follow the convention exactly as the engine gave it.
 */
function voiceLabel(voice: TtsVoice): string {
  const match = /^([ab])([fm])_(.+)$/.exec(voice.name);
  if (!match) return `${voice.name} (${voice.lang})`;
  const accent = match[1] === 'a' ? 'American' : 'British';
  const gender = match[2] === 'f' ? 'female' : 'male';
  const name = match[3].charAt(0).toUpperCase() + match[3].slice(1);
  return `${name} · ${accent} ${gender} (${voice.lang})`;
}

/** One line under a disabled "Test voice", so it never looks like a broken control. */
function testVoiceReason(state: PanelState): string | null {
  if (state === 'ready') return null;
  if (state === 'downloading') return 'Available once the download finishes.';
  if (state === 'absent') return 'Download the model first';
  if (state === 'unsupported') return 'Kokoro voices are not available on this device.';
  if (state === 'error') return 'Fix the download first.';
  return 'Checking the model…';
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
  const savedThreads = useSetting<number>(KOKORO_THREADS_SETTING, DEFAULT_KOKORO_THREADS);
  /** The speed the book reads at; the test sample has to sound like the book. */
  const rate = useSetting<number>(TTS_RATE_SETTING, 1);

  const refresh = useCallback(async () => {
    if (!isKokoroNativeAvailable()) {
      setShell('unsupported');
      return;
    }
    try {
      // Ask about the one build the reader speaks with. The plugin also answers
      // `downloaded` for a build it can fall back to, so readiness comes from the fp32
      // entry in `models` alone — an int8-only phone must show "Download model", not
      // "Ready".
      const next = await Kokoro.status({ model: DEFAULT_KOKORO_MODEL });
      setStatus(next);
      setShell(fp32Installed(next) ? 'ready' : 'absent');
      setFailure(null);
      setVoices(await kokoroNativeEngine.listVoices());
    } catch (err) {
      setShell('error');
      // The query itself failed, so there is no status object to describe the model with.
      setFailure(describeKokoroFailure('status', err, null));
    }
  }, []);

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

  /** Start (or resume) the download of the model; `prepare()` fetches fp32. */
  const downloadNow = async (): Promise<void> => {
    setFailure(null);
    setMeasure(null);
    setCopied('idle');
    void startDownload(KOKORO_DOWNLOAD_ID, runKokoroNativeDownload);
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
      // Reload the one build with the new thread count; the panel is the only place that
      // changes threads while a session is warm. Only when fp32 itself is on disk: on an
      // int8-only phone there is no fp32 session to reload, and the next prepare() loads
      // the model with this count.
      if (status?.loaded && fp32Installed(status)) {
        await Kokoro.load({ threads, model: DEFAULT_KOKORO_MODEL });
      }
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
  // Exactly v0.3.3's rule: 1, 2 and 4 are the selector's options, and a count an older
  // build stored (6, for example) is used as it is — shown as an extra "(saved)" option
  // with the warmer-phone warning — rather than being silently rewritten.
  const threads =
    Number.isFinite(savedThreadCount) && savedThreadCount >= 1
      ? Math.round(savedThreadCount)
      : DEFAULT_KOKORO_THREADS;
  const threadsOffered = (THREAD_OPTIONS as readonly number[]).includes(threads);

  // Sizes and install state per build, straight from the Java descriptors via status().
  // The reader speaks fp32 only, so everything the panel reports as "the model" is the
  // fp32 entry; the int8 entry is read just to offer deleting the files v0.3.3 left.
  const int8 = modelState(status?.models, 'int8');
  const fp32 = modelState(status?.models, 'fp32');
  const int8Bytes = modelArchiveBytes(status?.models, 'int8');
  const fp32Bytes = modelArchiveBytes(status?.models, 'fp32');
  const downloaded = status !== null && fp32Installed(status);
  /** status.sizeBytes describes the active build, which is fp32 whenever it is installed. */
  const sizeLabel = downloaded && status ? formatBytes(status.sizeBytes) : 'not downloaded';
  const legacyInt8 = int8?.downloaded === true;
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
  // Always fp32's numbers: on an int8-only phone `status` describes the fallback build it
  // found, and its 126 MB archive would mislabel the 334 MB download the button starts.
  // A plugin that sends no per-build list at all still reports the totals at the top.
  const hasModels = (status?.models?.length ?? 0) > 0;
  const partialBytes = hasModels ? fp32?.partialBytes : status?.partialBytes;
  const requiredBytes =
    (hasModels ? fp32?.requiredBytes : status?.requiredBytes) ?? KOKORO_REQUIRED_BYTES;
  const resumable = resumeFraction(partialBytes, fp32Bytes);
  const spaceWarning = storageWarning(status?.freeBytes, requiredBytes);
  const dataWarning = meteredWarning(status?.metered, downloaded, fp32Bytes);
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
          <p className="kokoro-sub">Kokoro-82M through sherpa-onnx · {formatBytes(fp32Bytes)} model</p>
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
              {voiceLabel(voice)}
            </option>
          ))}
        </select>
        <VoiceTest
          engine={kokoroNativeEngine}
          voiceId={selectedVoice}
          rate={rate}
          disabledReason={testVoiceReason(state)}
        />
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
          A partial download is saved ({Math.round(resumable * 100)}% of {formatBytes(fp32Bytes)}). Resuming
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
                  partialBytes,
                  archiveBytes: fp32Bytes,
                })}
          </button>
        )}
        {busy && (
          <button type="button" className="btn btn-secondary" disabled>
            Downloading…
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
        {/* Reclaim the space the v0.3.3 build took. Only once fp32 is installed and
            working: until then those files are the only model on the phone. */}
        {ready && legacyInt8 && (
          <button
            type="button"
            className="btn btn-ghost"
            style={TAP_TARGET}
            onClick={() => void remove('int8')}
          >
            Remove the old INT8 download ({formatBytes(int8?.sizeBytes ?? int8Bytes)})
          </button>
        )}
      </div>

      <details className="disc-sub">
        <summary>Details</summary>
        <div className="disc-sub-body">
          <div className="tts-field-grid">
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
            {formatBytes(fp32Bytes)} download that is stored in the app&apos;s private storage and survives restarts.
          </p>
        </div>
      </details>
    </section>
  );
}
