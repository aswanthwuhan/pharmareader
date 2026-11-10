import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Capacitor } from '@capacitor/core';
import { setSetting, useSetting } from '../../core/settings';
import type { TtsEngine, TtsVoice } from '../../core/types';
import { resetDownload, startDownload, useDownload, type DownloadState } from '../downloads';
import { measureRtf, rtfSettingKey } from './benchmark';
import { copyText } from './clipboard';
import {
  DEFAULT_KOKORO_VOICE,
  KOKORO_DTYPE_SETTING,
  KOKORO_VOICE_SETTING,
  kokoroEngine,
  resetKokoroEngine,
  setKokoroVoice,
} from './kokoro';
import type { KokoroDtype } from './kokoroProtocol';
import KokoroNativePanel from './KokoroNativePanel';
import { isModelDownloaded, isModelReadyFlag, kokoroSizeMb, deleteModel, POCKET_SIZE_MB } from './models';
import { describeNeuralError, type NeuralErrorInfo } from './neuralError';
import { POCKET_RATE_MAX, POCKET_RATE_MIN, pocketEngine, resetPocketEngine } from './pocket';
import styles from './NeuralModelsPanel.module.css';

type ModelId = 'pocket' | 'kokoro';

/** What is on disk, independent of whether a download is running. */
type Availability = 'loading' | 'absent' | 'ready';

type ModelState =
  | { kind: 'loading' }
  | { kind: 'absent' }
  | { kind: 'downloading'; fraction: number }
  | { kind: 'ready' }
  | { kind: 'error'; info: NeuralErrorInfo };

const DTYPE_LABELS: Record<KokoroDtype, string> = {
  fp32: 'fp32 — best quality, ~320 MB',
  fp16: 'fp16 — ~170 MB',
  q8: 'q8 — smallest, ~90 MB (can be slower on some CPUs)',
};

const POCKET_ATTRIBUTION = 'Pocket TTS by Kyutai — model weights CC-BY-4.0.';
const KOKORO_ATTRIBUTION = 'Kokoro-82M by hexgrad — Apache-2.0.';

/**
 * Derive one card's state from the download store and the disk check.
 *
 * Nothing about a download lives in this component's state: that state died with
 * the panel when the user left Settings, which is why the progress disappeared and
 * the unfinished cache looked like a failure.
 */
function modelState(
  model: ModelId,
  download: DownloadState,
  available: Availability,
  failure: NeuralErrorInfo | null
): ModelState {
  if (download.status === 'downloading' || download.status === 'unpacking') {
    return { kind: 'downloading', fraction: download.fraction };
  }
  if (download.status === 'error') {
    return {
      kind: 'error',
      info: describeNeuralError(model, download.cause ?? download.error ?? 'The download failed.'),
    };
  }
  if (failure) return { kind: 'error', info: failure };
  if (download.status === 'done' || available === 'ready') return { kind: 'ready' };
  if (available === 'loading') return { kind: 'loading' };
  return { kind: 'absent' };
}

interface EngineCardProps {
  model: ModelId;
  engine: TtsEngine;
  title: string;
  /** What this model is for, next to its name: "best quality", "faster". */
  qualifier: string;
  sizeMb: number;
  state: ModelState;
  voices: TtsVoice[];
  voiceId: string;
  onVoiceChange(voiceId: string): void;
  onDownload(): void;
  onDelete(): void;
  onMeasure(): void;
  measuring: boolean;
  rtf: number;
  measureError: string | null;
  /** A download-size decision or a technical readout: sits behind Details. */
  advanced?: ReactNode;
  /** More than a line of explanation: sits behind Details, under the controls. */
  howItWorks?: ReactNode;
  attribution?: string;
}

function EngineCard(props: EngineCardProps) {
  const { state, engine } = props;
  const busy = state.kind === 'downloading' || props.measuring;
  const chip = chipFor(state);
  const speed = speedLine(props.rtf);

  return (
    <section className={styles.block} aria-labelledby={`tts-${props.model}-title`}>
      <header className={styles.head}>
        <div className={styles.name}>
          <h3 id={`tts-${props.model}-title`} className={styles.title}>
            {props.title}
          </h3>
          <span className={styles.qualifier}>· {props.qualifier}</span>
        </div>
        <div className={styles.actions}>
          {state.kind !== 'ready' && (
            <button type="button" className="btn btn-secondary" onClick={props.onDownload} disabled={busy || state.kind === 'loading'}>
              Download
            </button>
          )}
          {/* Delete only when there is something on disk (or a failed attempt
              left a partial cache behind). */}
          {(state.kind === 'ready' || state.kind === 'error') && (
            <button type="button" className="btn btn-ghost" onClick={props.onDelete} disabled={busy}>
              Delete
            </button>
          )}
        </div>
      </header>

      <div className={styles.meta}>
        <span className={chip.tone ? `status-chip ${chip.tone}` : 'status-chip'} role="status" aria-live="polite">
          <span className="status-dot" aria-hidden="true" />
          {chip.label}
        </span>
        <span className={styles.size}>
          ~{props.sizeMb} MB · use Wi-Fi
        </span>
      </div>

      {state.kind === 'downloading' && (
        <div className={styles.download}>
          <div className="progress" aria-hidden="true">
            <span style={{ width: `${Math.round(state.fraction * 100)}%` }} />
          </div>
          <p className={styles.downloadText} role="status" aria-live="polite">
            {Math.round(state.fraction * props.sizeMb)} of {props.sizeMb} MB
          </p>
        </div>
      )}

      {state.kind === 'error' && <ErrorDetails info={state.info} />}

      {/* Measuring lives under Details, but if it failed the failure is the
          user's answer: it stays in the open next to the model it belongs to. */}
      {props.measureError && (
        <p className={styles.measureError} role="alert">
          {props.measureError}
        </p>
      )}

      {/* A voice list belongs to a model that is here; before that it is a
          disabled control explaining nothing. */}
      {props.voices.length > 0 && (
        <label className={styles.field}>
          <span className="field-label">Voice</span>
          <select
            className="input"
            value={props.voiceId}
            onChange={(event) => props.onVoiceChange(event.target.value)}
          >
            {props.voices.map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.name} ({voice.lang})
              </option>
            ))}
          </select>
        </label>
      )}

      {/* One disclosure per model: the technical controls first, then the
          explanation of what the model is doing, under the same label. */}
      <details className="disc-sub">
        <summary>Details</summary>
        <div className="disc-sub-body">
          {props.advanced}

          <div className={styles.speed}>
            <p className={styles.speedResult}>
              {speed.value ? (
                <>
                  <span className={styles.speedValue}>{speed.value}</span>{' '}
                  <span className={speed.ok ? styles.speedOk : styles.speedSlow}>{speed.verdict}</span>
                </>
              ) : (
                <span>Speed not measured yet</span>
              )}
            </p>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={props.onMeasure}
              // Measuring synthesises with the real model, so it must already be here;
              // otherwise the click would silently start a 90–150 MB download.
              disabled={busy || state.kind !== 'ready'}
            >
              {props.measuring ? 'Measuring…' : 'Measure speed'}
            </button>
          </div>

          <p className={styles.hint}>
            {engine.capabilities.prerender
              ? 'Can pre-render a chapter to audio for offline listening.'
              : 'Streams from the network; no pre-render.'}
          </p>

          {props.attribution && <p className={styles.attribution}>{props.attribution}</p>}

          {props.howItWorks}
        </div>
      </details>
    </section>
  );
}

/** The status chip: a word, a tone, and nothing the user has to interpret. */
function chipFor(state: ModelState): { label: string; tone: string } {
  switch (state.kind) {
    case 'loading':
      return { label: 'Checking…', tone: 'is-busy' };
    case 'absent':
      return { label: 'Not downloaded', tone: '' };
    case 'downloading':
      return { label: `Downloading ${Math.round(state.fraction * 100)}%`, tone: 'is-busy' };
    case 'ready':
      return { label: 'Ready', tone: 'is-ready' };
    case 'error':
      return { label: 'Error', tone: 'is-error' };
  }
}

/** How this engine's measured speed compares with playback. */
function speedLine(rtf: number): { value: string; verdict: string; ok: boolean } {
  if (!Number.isFinite(rtf) || rtf <= 0) return { value: '', verdict: '', ok: false };
  return rtf < 1
    ? { value: `${rtf.toFixed(2)}× real-time`, verdict: '✓ faster than playback', ok: true }
    : { value: `${rtf.toFixed(2)}× real-time`, verdict: 'slower than playback — save the chapter ahead', ok: false };
}

/**
 * A failure the user can act on: the stage it died in, the message the library
 * gave us, and the whole stack behind "Copy error details" (what a bug report
 * needs — a real phone reported "not working" with nothing to go on).
 */
function ErrorDetails({ info }: { info: NeuralErrorInfo }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const detailsRef = useRef<HTMLPreElement>(null);
  const blockRef = useRef<HTMLDivElement>(null);

  const copy = useCallback(() => {
    // Report what actually happened: a WebView may refuse both clipboard paths,
    // and a fake "Copied" is worse than none.
    void copyText(info.details).then((ok) => {
      setCopyState(ok ? 'copied' : 'failed');
      if (!ok) selectDetails(blockRef.current, detailsRef.current);
      window.setTimeout(() => setCopyState('idle'), 2500);
    });
  }, [info.details]);

  return (
    <div className="banner banner-error" role="alert">
      <div className={styles.errorBlock} ref={blockRef}>
        <p className={styles.errorStage}>Failed while {info.stage}</p>
        <p className={styles.errorMessage}>{info.message}</p>
        <details className={`disc-sub ${styles.errorDetails}`} open={copyState === 'failed'}>
          <summary>Technical details</summary>
          <pre ref={detailsRef}>{info.details}</pre>
        </details>
        <button type="button" className={`btn btn-ghost ${styles.copyError}`} onClick={copy}>
          {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy blocked — text selected, press and hold to copy' : 'Copy error details'}
        </button>
      </div>
    </div>
  );
}

/**
 * When a WebView refuses the clipboard, leave the text selected so the user can
 * long-press (Android) or Ctrl+C instead of hunting for the details.
 */
function selectDetails(block: HTMLDivElement | null, pre: HTMLPreElement | null): void {
  if (!block || !pre || typeof window.getSelection !== 'function') return;
  const range = document.createRange();
  range.selectNodeContents(pre);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export default function NeuralModelsPanel() {
  const pocketDownload = useDownload('pocket');
  const kokoroDownload = useDownload('kokoro');
  const [pocketAvailable, setPocketAvailable] = useState<Availability>('loading');
  const [kokoroAvailable, setKokoroAvailable] = useState<Availability>('loading');
  const [pocketFailure, setPocketFailure] = useState<NeuralErrorInfo | null>(null);
  const [kokoroFailure, setKokoroFailure] = useState<NeuralErrorInfo | null>(null);
  const [pocketVoices, setPocketVoices] = useState<TtsVoice[]>([]);
  const [kokoroVoices, setKokoroVoices] = useState<TtsVoice[]>([]);
  const [measuring, setMeasuring] = useState<ModelId | null>(null);
  const [pocketError, setPocketError] = useState<string | null>(null);
  const [kokoroError, setKokoroError] = useState<string | null>(null);

  // On Android/iOS the native sherpa-onnx panel owns Kokoro; the web engine
  // would download into the WebView cache and could not run the native model.
  const native = useMemo(() => Capacitor.isNativePlatform(), []);

  const dtype = useSetting<KokoroDtype>(KOKORO_DTYPE_SETTING, defaultDtype());
  const kokoroVoice = useSetting<string>(KOKORO_VOICE_SETTING, DEFAULT_KOKORO_VOICE);
  const pocketVoice = useSetting<string>('tts.pocket.voice', '');
  const pocketRtf = useSetting<number>(rtfSettingKey('pocket'), 0);
  const kokoroRtf = useSetting<number>(rtfSettingKey('kokoro'), 0);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [pocketDownloaded, pocketLoaded] = await Promise.all([
        isModelDownloaded('pocket'),
        isModelReadyFlag('pocket'),
      ]);
      if (!alive) return;
      setPocketAvailable(pocketDownloaded ? 'ready' : 'absent');
      if (pocketDownloaded && pocketLoaded) {
        void loadVoices(pocketEngine, (voices) => {
          if (alive) setPocketVoices(voices);
        });
      }
      if (native) return;
      const kokoroDownloaded = await isModelDownloaded('kokoro');
      if (!alive) return;
      setKokoroAvailable(kokoroDownloaded ? 'ready' : 'absent');
      // Kokoro's voice list is static, so it is available without loading the model.
      void loadVoices(kokoroEngine, (voices) => {
        if (alive) setKokoroVoices(voices);
      });
    })();
    return () => {
      alive = false;
    };
  }, [native]);

  // A download may finish while the panel is unmounted (that is the point of the
  // store). The next mount's disk check is asynchronous, so react to the store
  // directly to light up "Ready" and the voice list.
  useEffect(() => {
    if (pocketDownload.status !== 'done') return;
    setPocketAvailable('ready');
    void loadVoices(pocketEngine, setPocketVoices);
  }, [pocketDownload.status]);

  useEffect(() => {
    if (native || kokoroDownload.status !== 'done') return;
    setKokoroAvailable('ready');
    void loadVoices(kokoroEngine, setKokoroVoices);
  }, [kokoroDownload.status, native]);

  const download = useCallback(
    (model: ModelId, engine: TtsEngine, setFailure: (info: NeuralErrorInfo | null) => void) => {
      setFailure(null);
      // The store keeps this running when the panel unmounts, and a second call
      // (a remount, another screen) joins the same download instead of restarting it.
      void startDownload(model, async (report) => {
        await engine.prepare((fraction) => report({ fraction }));
        // 'auto' engine choice only picks a model with a stored RTF, so measure right away.
        void measureRtf(engine).catch(() => undefined);
      });
    },
    []
  );

  const remove = useCallback(
    async (
      model: ModelId,
      reset: () => void,
      setAvailable: (availability: Availability) => void,
      setVoices: (voices: TtsVoice[]) => void,
      setFailure: (info: NeuralErrorInfo | null) => void
    ) => {
      try {
        // Unload before deleting: an open worker keeps the Cache Storage entries
        // (and the model memory) reachable and some browsers refuse the delete.
        reset();
        await deleteModel(model);
        setVoices([]);
        setFailure(null);
        setAvailable('absent');
        resetDownload(model);
      } catch (err) {
        setFailure(describeNeuralError(model, err));
      }
    },
    []
  );

  const measure = useCallback(
    async (model: ModelId, engine: TtsEngine, voiceId: string | undefined, setError: (msg: string | null) => void) => {
      setMeasuring(model);
      setError(null);
      try {
        await measureRtf(engine, { voiceId: voiceId || undefined, rate: 1 });
      } catch (err) {
        // Synthesis failures are the ones that used to vanish into silence.
        const info = describeNeuralError(model, err);
        setError(`Failed while ${info.stage}: ${info.message}`);
      } finally {
        setMeasuring(null);
      }
    },
    []
  );

  const gpuHint = useMemo(
    () => (typeof navigator !== 'undefined' && 'gpu' in navigator ? 'WebGPU detected' : 'No WebGPU — using WASM'),
    []
  );

  return (
    <div className={styles.panel}>
      {/* The row body is a list of models; the paragraph that explains what
          "neural" means here belongs to all of them, so it opens once at the top. */}
      <details className="disc-sub">
        <summary>How this works</summary>
        <div className="disc-sub-body">
          <p className={styles.intro}>
            Neural voices run entirely on this device. Nothing is uploaded; the model files are downloaded once and
            cached for offline use. Pre-rendering a chapter with a faster-than-real-time engine gives the smoothest
            reading experience.
          </p>
        </div>
      </details>

      <EngineCard
        model="pocket"
        engine={pocketEngine}
        title="Pocket TTS"
        qualifier="faster"
        sizeMb={POCKET_SIZE_MB}
        state={modelState('pocket', pocketDownload, pocketAvailable, pocketFailure)}
        voices={pocketVoices}
        voiceId={pocketVoice}
        onVoiceChange={(voiceId) => void setSetting('tts.pocket.voice', voiceId)}
        onDownload={() => download('pocket', pocketEngine, setPocketFailure)}
        onDelete={() =>
          void remove('pocket', resetPocketEngine, setPocketAvailable, setPocketVoices, setPocketFailure)
        }
        onMeasure={() => void measure('pocket', pocketEngine, pocketVoice, setPocketError)}
        measuring={measuring === 'pocket'}
        rtf={pocketRtf}
        measureError={pocketError}
        attribution={POCKET_ATTRIBUTION}
        howItWorks={
          <p className={styles.intro}>
            Pocket changes speed by resampling, which also changes the pitch, so its reading speed is limited to{' '}
            {POCKET_RATE_MIN.toFixed(2)}×–{POCKET_RATE_MAX.toFixed(2)}×. Use Kokoro or the system voice for a wider range.
          </p>
        }
      />

      {native ? (
        <KokoroNativePanel />
      ) : (
        <EngineCard
          model="kokoro"
          engine={kokoroEngine}
          title="Kokoro-82M"
          qualifier="best quality"
          sizeMb={kokoroSizeMb(dtype)}
          state={modelState('kokoro', kokoroDownload, kokoroAvailable, kokoroFailure)}
          voices={kokoroVoices}
          voiceId={kokoroVoice}
          onVoiceChange={(voiceId) => void setKokoroVoice(voiceId)}
          onDownload={() => download('kokoro', kokoroEngine, setKokoroFailure)}
          onDelete={() =>
            void remove('kokoro', resetKokoroEngine, setKokoroAvailable, setKokoroVoices, setKokoroFailure)
          }
          onMeasure={() => void measure('kokoro', kokoroEngine, kokoroVoice, setKokoroError)}
          measuring={measuring === 'kokoro'}
          rtf={kokoroRtf}
          measureError={kokoroError}
          attribution={KOKORO_ATTRIBUTION}
          advanced={
            // A download-size decision, not a daily one: it stays folded away.
            <div className={styles.field}>
              <label className="field-label" htmlFor="tts-kokoro-dtype">
                Precision
              </label>
              <select
                id="tts-kokoro-dtype"
                className="input"
                value={dtype}
                onChange={(event) => void setSetting(KOKORO_DTYPE_SETTING, event.target.value as KokoroDtype)}
              >
                {(Object.keys(DTYPE_LABELS) as KokoroDtype[]).map((option) => (
                  <option key={option} value={option}>
                    {DTYPE_LABELS[option]}
                  </option>
                ))}
              </select>
            </div>
          }
          howItWorks={
            <p className={styles.intro}>
              {gpuHint}. Changing precision takes effect on the next download or reload. All 28 Kokoro voices are
              English (af_* and am_* US, bf_* and bm_* UK).
            </p>
          }
        />
      )}
    </div>
  );
}

async function loadVoices(engine: TtsEngine, setVoices: (voices: TtsVoice[]) => void): Promise<void> {
  try {
    const voices = await engine.listVoices();
    if (voices.length > 0) setVoices(voices);
  } catch {
    /* listing voices is best-effort */
  }
}

function defaultDtype(): KokoroDtype {
  return typeof navigator !== 'undefined' && 'gpu' in navigator ? 'fp32' : 'q8';
}
