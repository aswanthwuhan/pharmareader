import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Capacitor } from '@capacitor/core';
import { setSetting, useSetting } from '../../core/settings';
import type { TtsEngine, TtsVoice } from '../../core/types';
import { measureRtf, rtfSettingKey, rtfVerdict } from './benchmark';
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
import { POCKET_RATE_MAX, POCKET_RATE_MIN, pocketEngine, resetPocketEngine } from './pocket';
import styles from './NeuralModelsPanel.module.css';

type ModelId = 'pocket' | 'kokoro';

type ModelState =
  | { kind: 'loading' }
  | { kind: 'absent' }
  | { kind: 'downloading'; fraction: number }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

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
  sizeLabel: string;
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
  const status = describeState(state);

  return (
    <section className={styles.card} aria-labelledby={`tts-${props.model}-title`}>
      <header className={styles.cardHeader}>
        <h3 id={`tts-${props.model}-title`} className={styles.cardTitle}>
          {props.title}
        </h3>
        <span className={styles.size}>{props.sizeLabel}</span>
      </header>

      <p className={styles.status} role="status" aria-live="polite">
        {status}
      </p>

      {state.kind === 'downloading' && (
        <progress
          className={styles.progress}
          value={Math.round(state.fraction * 100)}
          max={100}
          aria-label={`${props.title} download progress`}
        />
      )}

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primary}
          onClick={props.onDownload}
          disabled={busy || state.kind === 'ready'}
        >
          Download
        </button>
        <button
          type="button"
          className={styles.secondary}
          onClick={props.onDelete}
          disabled={busy || state.kind === 'absent'}
        >
          Delete
        </button>
      </div>

      {props.children}

      <label className={styles.field}>
        <span>Voice</span>
        <select
          value={props.voiceId}
          onChange={(event) => props.onVoiceChange(event.target.value)}
          disabled={props.voices.length === 0}
        >
          {props.voices.length === 0 && <option value="">Download or load the model to list voices</option>}
          {props.voices.map((voice) => (
            <option key={voice.id} value={voice.id}>
              {voice.name} ({voice.lang})
            </option>
          ))}
        </select>
      </label>

      <button
        type="button"
        className={styles.secondary}
        onClick={props.onMeasure}
        // Measuring synthesises with the real model, so it must already be here;
        // otherwise the click would silently start a 90–150 MB download.
        disabled={busy || state.kind !== 'ready'}
      >
        {props.measuring ? 'Measuring…' : 'Measure speed'}
      </button>

      {props.measureError ? (
        <p className={styles.error}>{props.measureError}</p>
      ) : (
        props.rtf > 0 && (
          <p className={styles.rtf}>
            Real-time factor {props.rtf.toFixed(2)} · {rtfVerdict(props.rtf)}
          </p>
        )
      )}

      <p className={styles.hint}>
        {engine.capabilities.prerender
          ? 'Can pre-render a chapter to audio for offline listening.'
          : 'Streams from the network; no pre-render.'}
      </p>
    </section>
  );
}

function describeState(state: ModelState): string {
  switch (state.kind) {
    case 'loading':
      return 'Checking download…';
    case 'absent':
      return 'Not downloaded';
    case 'downloading':
      return `Downloading ${Math.round(state.fraction * 100)}%`;
    case 'ready':
      return 'Ready';
    case 'error':
      return `Failed: ${state.message}`;
  }
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
    async (engine: TtsEngine, setState: (state: ModelState) => void, setVoices: (voices: TtsVoice[]) => void) => {
      setState({ kind: 'downloading', fraction: 0 });
      try {
        await engine.prepare((fraction) => setState({ kind: 'downloading', fraction }));
        setVoices(await engine.listVoices());
        setState({ kind: 'ready' });
        // 'auto' engine choice only picks a model with a stored RTF, so measure right away.
        void measureRtf(engine).catch(() => undefined);
      } catch (err) {
        setState({ kind: 'error', message: messageOf(err) });
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
        setState({ kind: 'error', message: messageOf(err) });
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
        setError(messageOf(err));
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
        sizeLabel={`~${POCKET_SIZE_MB} MB · INT8`}
        state={pocketState}
        voices={pocketVoices}
        voiceId={pocketVoice}
        onVoiceChange={(voiceId) => void setSetting('tts.pocket.voice', voiceId)}
        onDownload={() => void download(pocketEngine, setPocketState, setPocketVoices)}
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
          sizeLabel={`~${kokoroSizeMb(dtype)} MB · ${dtype}`}
          state={kokoroState}
          voices={kokoroVoices}
          voiceId={kokoroVoice}
          onVoiceChange={(voiceId) => void setKokoroVoice(voiceId)}
          onDownload={() => void download(kokoroEngine, setKokoroState, setKokoroVoices)}
          onDelete={() => void remove('kokoro', resetKokoroEngine, setKokoroState, setKokoroVoices)}
          onMeasure={() => void measure('kokoro', kokoroEngine, kokoroVoice, setKokoroError)}
          measuring={measuring === 'kokoro'}
          rtf={kokoroRtf}
          measureError={kokoroError}
        >
          <label className={styles.field}>
            <span>Precision</span>
            <select
              value={dtype}
              onChange={(event) => void setSetting(KOKORO_DTYPE_SETTING, event.target.value as KokoroDtype)}
            >
              {(Object.keys(DTYPE_LABELS) as KokoroDtype[]).map((option) => (
                <option key={option} value={option}>
                  {DTYPE_LABELS[option]}
                </option>
              ))}
            </select>
          </label>
          <p className={styles.hint}>
            {gpuHint}. Changing precision takes effect on the next download or reload. All 28 Kokoro voices are
            English (af_* and am_* US, bf_* and bm_* UK).
          </p>
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

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
