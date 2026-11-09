import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Capacitor } from '@capacitor/core';
import { setSetting, useSetting } from '../../core/settings';
import type { TtsEngine, TtsVoice } from '../../core/types';
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
  children?: ReactNode;
}

function EngineCard(props: EngineCardProps) {
  const { state, engine } = props;
  const busy = state.kind === 'downloading' || props.measuring;
  const chip = chipFor(state);
  const speed = speedLine(props.rtf);

  return (
    <section className={styles.card} aria-labelledby={`tts-${props.model}-title`}>
      <header className={styles.head}>
        <h3 id={`tts-${props.model}-title`} className={styles.title}>
          {props.title}
        </h3>
        <span className={styles.qualifier}>· {props.qualifier}</span>
        <div className={styles.actions}>
          {state.kind !== 'ready' && (
            <button type="button" className="btn btn-primary" onClick={props.onDownload} disabled={busy || state.kind === 'loading'}>
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

      {props.children}

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

      <div className={styles.speed}>
        <p className={styles.speedResult}>
          {props.measureError ? (
            <span className={styles.measureError}>{props.measureError}</span>
          ) : speed.value ? (
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
        <details className={styles.errorDetails} open={copyState === 'failed'}>
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
  const [pocketState, setPocketState] = useState<ModelState>({ kind: 'loading' });
  const [kokoroState, setKokoroState] = useState<ModelState>({ kind: 'loading' });
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
      setPocketState(pocketDownloaded ? { kind: 'ready' } : { kind: 'absent' });
      if (pocketDownloaded && pocketLoaded) {
        void loadVoices(pocketEngine, (voices) => {
          if (alive) setPocketVoices(voices);
        });
      }
      if (native) return;
      const kokoroDownloaded = await isModelDownloaded('kokoro');
      if (!alive) return;
      setKokoroState(kokoroDownloaded ? { kind: 'ready' } : { kind: 'absent' });
      // Kokoro's voice list is static, so it is available without loading the model.
      void loadVoices(kokoroEngine, (voices) => {
        if (alive) setKokoroVoices(voices);
      });
    })();
    return () => {
      alive = false;
    };
  }, [native]);

  const download = useCallback(
    async (
      model: ModelId,
      engine: TtsEngine,
      setState: (state: ModelState) => void,
      setVoices: (voices: TtsVoice[]) => void
    ) => {
      setState({ kind: 'downloading', fraction: 0 });
      try {
        await engine.prepare((fraction) => setState({ kind: 'downloading', fraction }));
        setVoices(await engine.listVoices());
        setState({ kind: 'ready' });
        // 'auto' engine choice only picks a model with a stored RTF, so measure right away.
        void measureRtf(engine).catch(() => undefined);
      } catch (err) {
        setState({ kind: 'error', info: describeNeuralError(model, err) });
      }
    },
    []
  );

  const remove = useCallback(
    async (model: ModelId, reset: () => void, setState: (state: ModelState) => void, setVoices: (voices: TtsVoice[]) => void) => {
      try {
        // Unload before deleting: an open worker keeps the Cache Storage entries
        // (and the model memory) reachable and some browsers refuse the delete.
        reset();
        await deleteModel(model);
        setVoices([]);
        setState({ kind: 'absent' });
      } catch (err) {
        setState({ kind: 'error', info: describeNeuralError(model, err) });
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
      <p className={styles.intro}>
        Neural voices run entirely on this device. Nothing is uploaded; the model files are downloaded once and
        cached for offline use. Pre-rendering a chapter with a faster-than-real-time engine gives the smoothest
        reading experience.
      </p>

      <EngineCard
        model="pocket"
        engine={pocketEngine}
        title="Pocket TTS"
        qualifier="faster"
        sizeMb={POCKET_SIZE_MB}
        state={pocketState}
        voices={pocketVoices}
        voiceId={pocketVoice}
        onVoiceChange={(voiceId) => void setSetting('tts.pocket.voice', voiceId)}
        onDownload={() => void download('pocket', pocketEngine, setPocketState, setPocketVoices)}
        onDelete={() => void remove('pocket', resetPocketEngine, setPocketState, setPocketVoices)}
        onMeasure={() => void measure('pocket', pocketEngine, pocketVoice, setPocketError)}
        measuring={measuring === 'pocket'}
        rtf={pocketRtf}
        measureError={pocketError}
      >
        <p className={styles.hint}>
          Pocket changes speed by resampling, which also changes the pitch, so its reading speed is limited to{' '}
          {POCKET_RATE_MIN.toFixed(2)}×–{POCKET_RATE_MAX.toFixed(2)}×. Use Kokoro or the system voice for a wider range.
        </p>
      </EngineCard>

      {native ? (
        <KokoroNativePanel />
      ) : (
        <EngineCard
          model="kokoro"
          engine={kokoroEngine}
          title="Kokoro-82M"
          qualifier="best quality"
          sizeMb={kokoroSizeMb(dtype)}
          state={kokoroState}
          voices={kokoroVoices}
          voiceId={kokoroVoice}
          onVoiceChange={(voiceId) => void setKokoroVoice(voiceId)}
          onDownload={() => void download('kokoro', kokoroEngine, setKokoroState, setKokoroVoices)}
          onDelete={() => void remove('kokoro', resetKokoroEngine, setKokoroState, setKokoroVoices)}
          onMeasure={() => void measure('kokoro', kokoroEngine, kokoroVoice, setKokoroError)}
          measuring={measuring === 'kokoro'}
          rtf={kokoroRtf}
          measureError={kokoroError}
        >
          {/* A download-size decision, not a daily one: it stays folded away. */}
          <details className={styles.disclosure}>
            <summary>Precision</summary>
            <div className={styles.disclosureBody}>
              <select
                className="input"
                aria-label="Precision"
                value={dtype}
                onChange={(event) => void setSetting(KOKORO_DTYPE_SETTING, event.target.value as KokoroDtype)}
              >
                {(Object.keys(DTYPE_LABELS) as KokoroDtype[]).map((option) => (
                  <option key={option} value={option}>
                    {DTYPE_LABELS[option]}
                  </option>
                ))}
              </select>
              <p className={styles.hint}>
                {gpuHint}. Changing precision takes effect on the next download or reload. All 28 Kokoro voices are
                English (af_* and am_* US, bf_* and bm_* UK).
              </p>
            </div>
          </details>
        </EngineCard>
      )}

      <p className={styles.attribution}>{POCKET_ATTRIBUTION}</p>
      {!native && <p className={styles.attribution}>{KOKORO_ATTRIBUTION}</p>}
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
