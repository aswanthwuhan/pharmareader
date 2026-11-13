/**
 * The operating system's own voices — free, offline, and on every device.
 *
 * Web: `speechSynthesis`. Each sentence gets its own utterance so the Chrome
 * bug that silences anything longer than ~15 seconds cannot swallow the
 * paragraph, and `boundary` events give us word highlighting for free.
 *
 * Pause is implemented by cancelling and remembering where we were: Chrome
 * Android's `speechSynthesis.pause()` is unreliable, can leave `paused` stuck
 * true, and often never resumes. The speak() promise stays pending across a
 * pause, so a caller's sentence is never silently skipped.
 *
 * Native (Capacitor): the `@capacitor-community/text-to-speech` plugin, which
 * speaks one string at a time, reports no word boundaries, and has no pause.
 * Android's stop() clears its request map without ever resolving the pending
 * `speak()` call, so every native utterance is raced against our own
 * cancellation; pause = stop + remember the sentence, resume re-speaks it.
 */
import type { SpeakEvents, TtsCapabilities, TtsEngine, TtsVoice } from '../core/types';

/** Chrome silently stops producing audio after ~15 s of one utterance. */
const MAX_UTTERANCE_CHARS = 300;

const WEB_RATE_MIN = 0.1;
const WEB_RATE_MAX = 10;

/** Android `TextToSpeech.setSpeechRate()` documents 0.1–2.0. */
const NATIVE_RATE_MIN = 0.1;
const NATIVE_RATE_MAX = 2;

const NATIVE_LANG = 'en-US';

function isNative(): boolean {
  // Capacitor is only injected by the shell; Vite's web build must not touch it.
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return cap?.isNativePlatform?.() === true;
}

function synth(): SpeechSynthesis | undefined {
  return typeof globalThis.speechSynthesis === 'undefined' ? undefined : globalThis.speechSynthesis;
}

const capabilities: TtsCapabilities = {
  streaming: true,
  prerender: false,
  needsDownload: false,
  wordBoundaries: true,
};

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Web Speech
// ---------------------------------------------------------------------------

let webVoices: SpeechSynthesisVoice[] | null = null;

/** getVoices() is empty until the engine has loaded; wait for the event (1 s cap). */
async function loadWebVoices(): Promise<SpeechSynthesisVoice[]> {
  if (webVoices && webVoices.length > 0) return webVoices;
  const s = synth();
  if (!s) return [];
  const now = s.getVoices();
  if (now.length > 0) {
    webVoices = now;
    return now;
  }
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      s.removeEventListener('voiceschanged', finish);
      resolve();
    };
    const timer = setTimeout(finish, 1000);
    s.addEventListener('voiceschanged', finish);
  });
  webVoices = s.getVoices();
  return webVoices;
}

function webVoiceFor(voices: SpeechSynthesisVoice[], id: string | undefined): SpeechSynthesisVoice | undefined {
  if (!id) return undefined;
  return voices.find((v) => v.voiceURI === id) ?? voices.find((v) => v.name === id);
}

interface WebRun {
  stopped: boolean;
  paused: boolean;
  /** Resolved by resume()/stop() while the loop is parked on a pause. */
  pauseWaiters: (() => void)[];
}

let webRun: WebRun | null = null;
let speaking: SpeechSynthesisUtterance | null = null;

function flushPauseWaiters(run: WebRun): void {
  const waiters = run.pauseWaiters;
  run.pauseWaiters = [];
  for (const resolve of waiters) resolve();
}

/**
 * Speak one chunk. Resolves `true` when it ended on its own, `false` when it
 * was cancelled (by us) or failed; a failure is reported through onError
 * unless the caller cancelled.
 */
function speakOne(
  s: SpeechSynthesis,
  text: string,
  voice: SpeechSynthesisVoice | undefined,
  rate: number,
  lang: string,
  ev: SpeakEvents,
  sentenceId: string,
  charOffset: number,
  cancelled: () => boolean,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    // Held until it ends: Safari can collect an unreferenced utterance, and then
    // onend never fires and reading stops after the first sentence.
    speaking = u;
    u.lang = voice?.lang ?? lang;
    if (voice) u.voice = voice;
    u.rate = Math.min(WEB_RATE_MAX, Math.max(WEB_RATE_MIN, rate));
    u.onstart = () => ev.onStart?.(sentenceId);
    u.onboundary = (e) => {
      if (e.name !== 'word' && e.name !== undefined) return;
      ev.onWord?.(sentenceId, charOffset + e.charIndex);
    };
    u.onend = () => {
      if (speaking === u) speaking = null;
      resolve(true);
    };
    u.onerror = (e) => {
      // Cancelling fires "canceled"/"interrupted"; that is us stopping, not a fault.
      const reason = (e as SpeechSynthesisErrorEvent).error;
      const expected = cancelled() || reason === 'canceled' || reason === 'interrupted';
      if (!expected) {
        ev.onError?.(new Error(`speechSynthesis: ${reason ?? 'unknown error'}`));
      }
      resolve(false);
    };
    s.speak(u);
  });
}

/** Split on sentence ends, and cap very long sentences so Chrome cannot cut them. */
function chunks(text: string): string[] {
  const out: string[] = [];
  // no lookbehind: in a regex literal it is a parse error on iOS < 16.4 and blanks the app
  const parts = text.split(/([.!?])\s+/);
  for (let i = 0; i < parts.length; i += 2) {
    const s = (parts[i]! + (parts[i + 1] ?? '')).trim();
    if (!s) continue;
    if (s.length <= MAX_UTTERANCE_CHARS) {
      out.push(s);
      continue;
    }
    // Long sentence (a table row, a citation pile): break at a clause boundary.
    let rest = s;
    while (rest.length > MAX_UTTERANCE_CHARS) {
      const cut = Math.max(rest.lastIndexOf(', ', MAX_UTTERANCE_CHARS), rest.lastIndexOf('; ', MAX_UTTERANCE_CHARS));
      const at = cut > 40 ? cut + 1 : MAX_UTTERANCE_CHARS;
      out.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) out.push(rest);
  }
  return out;
}

const webEngine: TtsEngine = {
  id: 'system',
  label: 'System voices',
  capabilities,
  async isReady() {
    return synth() !== undefined;
  },
  async prepare() {
    /* nothing to download */
  },
  async listVoices(): Promise<TtsVoice[]> {
    const voices = await loadWebVoices();
    return voices
      .filter((v) => v.lang.toLowerCase().startsWith('en'))
      .map((v) => ({ id: v.voiceURI, name: v.name, lang: v.lang }));
  },
  async speak(items, opts, ev) {
    const s = synth();
    if (!s) {
      ev.onError?.(new Error('This browser has no speech synthesis.'));
      return;
    }

    // A previous run parked on a pause must end before it could wake up again.
    const previous = webRun;
    if (previous) {
      previous.stopped = true;
      previous.paused = false;
      flushPauseWaiters(previous);
      webRun = null;
    }

    // Some engines are left `paused` by an earlier cancel; speak() alone then
    // silently queues nothing.
    if (s.paused) s.resume();
    const wasBusy = s.speaking === true || s.pending === true;
    s.cancel();
    if (wasBusy) {
      // Chrome Android drops a speak() issued in the same tick as cancel().
      await delay(50);
    }

    const run: WebRun = { stopped: false, paused: false, pauseWaiters: [] };
    webRun = run;
    try {
      const voices = await loadWebVoices();
      if (run.stopped) return;
      const voice = webVoiceFor(voices, opts.voiceId);

      for (const item of items) {
        if (run.stopped) return;
        const parts = chunks(item.text);
        if (parts.length === 0) {
          ev.onEnd?.(item.id);
          continue;
        }
        // Boundary offsets are per utterance; report them against the sentence.
        const offsets: number[] = [];
        let cursor = 0;
        for (const part of parts) {
          const at = item.text.indexOf(part, cursor);
          const offset = at >= 0 ? at : cursor;
          offsets.push(offset);
          cursor = offset + part.length;
        }

        for (let p = 0; p < parts.length; p++) {
          while (run.paused && !run.stopped) {
            await new Promise<void>((resolve) => run.pauseWaiters.push(resolve));
          }
          if (run.stopped) return;

          const completed = await speakOne(
            s,
            parts[p]!,
            voice,
            opts.rate,
            'en-US',
            ev,
            item.id,
            offsets[p]!,
            () => run.stopped || run.paused,
          );
          if (run.stopped) return;
          if (run.paused) {
            // We cancelled mid-chunk: replay this chunk once resume() wakes us.
            if (!completed) p--;
            continue;
          }
          if (!completed) return; // a real error (reported) or an external cancel
        }
        if (!run.stopped) ev.onEnd?.(item.id);
      }
    } finally {
      // A finished, failed or superseded speak() must not stay registered as
      // the live run: a later pause() would cancel a run that no longer exists.
      if (webRun === run) webRun = null;
    }
  },
  stop() {
    const run = webRun;
    if (run) {
      run.stopped = true;
      run.paused = false;
      flushPauseWaiters(run);
      webRun = null;
    }
    synth()?.cancel();
  },
  pause() {
    const run = webRun;
    const s = synth();
    if (!run || !s || run.stopped) return;
    run.paused = true;
    // Never speechSynthesis.pause(): it is unreliable on Chrome Android and
    // can leave `paused` stuck after cancel(). Cancelling is honest.
    s.cancel();
  },
  resume() {
    const run = webRun;
    if (!run || run.stopped) return;
    run.paused = false;
    flushPauseWaiters(run);
  },
};

// ---------------------------------------------------------------------------
// Native (Capacitor)
// ---------------------------------------------------------------------------

interface NativeSpeakOptions {
  text: string;
  lang?: string;
  rate?: number;
  voice?: number;
}

interface NativeTts {
  speak(opts: NativeSpeakOptions): Promise<void>;
  stop(): Promise<void>;
  getSupportedVoices(): Promise<{ voices: { name: string; lang: string; voiceURI: string }[] }>;
}

interface NativeVoice {
  name: string;
  lang: string;
  voiceURI: string;
}

interface NativeRun {
  cancelled: boolean;
  paused: boolean;
  /** Flushed by pause()/stop(): Android never resolves a stopped speak(). */
  speakWaiters: (() => void)[];
  /** Flushed by resume()/stop() while the loop is parked on a pause. */
  pauseWaiters: (() => void)[];
}

let nativeModule: Promise<NativeTts> | null = null;
let nativeTts: NativeTts | null = null;
let nativeVoices: NativeVoice[] | null = null;
let nativeRun: NativeRun | null = null;

function loadNative(): Promise<NativeTts> {
  nativeModule ??= import('@capacitor-community/text-to-speech').then((m) => {
    // Capacitor plugin proxies answer every property, including `then`; resolving a promise with
    // one makes it look thenable and the await never settles. Wrap it in a plain object.
    const tts = m.TextToSpeech as NativeTts;
    return {
      speak: (opts) => tts.speak(opts),
      stop: () => tts.stop(),
      getSupportedVoices: () => tts.getSupportedVoices(),
    };
  });
  return nativeModule;
}

async function loadNativeVoices(): Promise<NativeVoice[]> {
  if (nativeVoices) return nativeVoices;
  const tts = await loadNative();
  const res = await tts.getSupportedVoices();
  nativeVoices = res.voices ?? [];
  return nativeVoices;
}

function clampNativeRate(rate: number): number {
  return Math.min(NATIVE_RATE_MAX, Math.max(NATIVE_RATE_MIN, rate));
}

function flushSpeakWaiters(run: NativeRun): void {
  const waiters = run.speakWaiters;
  run.speakWaiters = [];
  for (const wake of waiters) wake();
}

function flushPause(run: NativeRun): void {
  const waiters = run.pauseWaiters;
  run.pauseWaiters = [];
  for (const resolve of waiters) resolve();
}

/** Stop the plugin without letting a rejected/never-settling stop() escape. */
function stopNativePlugin(): void {
  const tts = nativeTts;
  if (!tts) return;
  try {
    void tts.stop().catch(() => {});
  } catch {
    /* plugin throws when its engine is not initialised */
  }
}

/**
 * Android's stop() clears the request map without resolving the pending
 * speak() call, so the call is always raced with `run.speakWaiters`:
 * `interrupted` means we stopped it (pause/stop), `done` means it finished.
 */
function speakNativeOnce(tts: NativeTts, opts: NativeSpeakOptions, run: NativeRun): Promise<'done' | 'interrupted'> {
  return new Promise<'done' | 'interrupted'>((resolve, reject) => {
    let settled = false;
    const wake = () => finish('interrupted');
    const finish = (outcome: 'done' | 'interrupted') => {
      if (settled) return;
      settled = true;
      const at = run.speakWaiters.indexOf(wake);
      if (at >= 0) run.speakWaiters.splice(at, 1);
      resolve(outcome);
    };
    run.speakWaiters.push(wake);
    tts.speak(opts).then(
      () => finish('done'),
      (err: unknown) => {
        if (settled) return; // already flushed by a pause/stop
        settled = true;
        const at = run.speakWaiters.indexOf(wake);
        if (at >= 0) run.speakWaiters.splice(at, 1);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

const nativeEngine: TtsEngine = {
  id: 'system',
  label: 'System voices',
  // The plugin gives no word callbacks, so highlighting is sentence-level only.
  capabilities: { ...capabilities, wordBoundaries: false },
  async isReady() {
    return true;
  },
  async prepare() {
    /* nothing to download */
  },
  async listVoices(): Promise<TtsVoice[]> {
    const voices = await loadNativeVoices();
    return voices
      .filter((v) => v.lang.toLowerCase().startsWith('en'))
      .map((v) => ({ id: v.voiceURI, name: v.name, lang: v.lang }));
  },
  async speak(items, opts, ev) {
    const tts = await loadNative();
    nativeTts = tts;

    // Supersede any previous run still waiting on the plugin.
    const previous = nativeRun;
    if (previous) {
      previous.cancelled = true;
      previous.paused = false;
      flushSpeakWaiters(previous);
      flushPause(previous);
    }

    const run: NativeRun = { cancelled: false, paused: false, speakWaiters: [], pauseWaiters: [] };
    nativeRun = run;
    try {
      // Voices are needed on both platforms: the plugin takes an array index.
      const voices = await loadNativeVoices();
      if (run.cancelled) return;
      const voice = opts.voiceId
        ? voices.findIndex((v) => v.voiceURI === opts.voiceId || v.name === opts.voiceId)
        : -1;

      for (const item of items) {
        if (run.cancelled) return;
        ev.onStart?.(item.id);

        for (;;) {
          if (run.cancelled) return;
          if (run.paused) {
            // Stopped by pause(): park until resume() (or stop()).
            await new Promise<void>((resolve) => run.pauseWaiters.push(resolve));
            if (run.cancelled) return;
            continue; // re-speak the sentence that pause() interrupted
          }
          try {
            const outcome = await speakNativeOnce(
              tts,
              {
                text: item.text,
                lang: NATIVE_LANG,
                rate: clampNativeRate(opts.rate),
                ...(voice >= 0 ? { voice } : {}),
              },
              run,
            );
            if (run.cancelled) return;
            if (run.paused) continue;
            if (outcome === 'interrupted') return; // stopped by a newer call
            break;
          } catch (err) {
            if (run.cancelled) return;
            if (run.paused) continue;
            ev.onError?.(err instanceof Error ? err : new Error(String(err)));
            return;
          }
        }
        if (run.cancelled) return;
        ev.onEnd?.(item.id);
      }
    } finally {
      if (nativeRun === run) nativeRun = null;
    }
  },
  stop() {
    const run = nativeRun;
    if (run) {
      run.cancelled = true;
      run.paused = false;
      flushSpeakWaiters(run);
      flushPause(run);
      nativeRun = null;
    }
    stopNativePlugin();
  },
  pause() {
    const run = nativeRun;
    if (!run || run.cancelled || run.paused) return;
    run.paused = true;
    // The plugin has no pause: stop the utterance and remember where we were.
    stopNativePlugin();
    flushSpeakWaiters(run);
  },
  resume() {
    const run = nativeRun;
    if (!run || run.cancelled || !run.paused) return;
    run.paused = false;
    flushPause(run);
  },
};

export const systemEngine: TtsEngine = isNative() ? nativeEngine : webEngine;

/** Exposed so tests can drive both branches without a Capacitor shell. */
export const __systemInternals = {
  webEngine,
  nativeEngine,
  chunks,
  isNative,
  resetVoices(): void {
    webVoices = null;
    nativeVoices = null;
    nativeRun = null;
  },
};
