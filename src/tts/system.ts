/**
 * The operating system's own voices — free, offline, and on every device.
 *
 * Web: `speechSynthesis`. Each sentence gets its own utterance so the Chrome
 * bug that silences anything longer than ~15 seconds cannot swallow the
 * paragraph, and `boundary` events give us word highlighting for free.
 * Native (Capacitor): the `@capacitor-community/text-to-speech` plugin, which
 * speaks one string at a time and reports no word boundaries.
 */
import type { SpeakEvents, TtsCapabilities, TtsEngine, TtsVoice } from '../core/types';

/** Chrome silently stops producing audio after ~15 s of one utterance. */
const MAX_UTTERANCE_CHARS = 300;

const WEB_RATE_MIN = 0.1;
const WEB_RATE_MAX = 10;

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

// ---------------------------------------------------------------------------
// Web Speech
// ---------------------------------------------------------------------------

let webVoices: SpeechSynthesisVoice[] | null = null;
let stopWeb: (() => void) | null = null;

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
): Promise<void> {
  return new Promise<void>((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = voice?.lang ?? lang;
    if (voice) u.voice = voice;
    u.rate = Math.min(WEB_RATE_MAX, Math.max(WEB_RATE_MIN, rate));
    u.onstart = () => ev.onStart?.(sentenceId);
    u.onboundary = (e) => {
      if (e.name !== 'word' && e.name !== undefined) return;
      ev.onWord?.(sentenceId, charOffset + e.charIndex);
    };
    u.onend = () => resolve();
    u.onerror = (e) => {
      // Cancelling fires "canceled"/"interrupted"; that is us stopping, not a fault.
      const reason = (e as SpeechSynthesisErrorEvent).error;
      if (reason !== 'canceled' && reason !== 'interrupted' && !cancelled()) {
        ev.onError?.(new Error(`speechSynthesis: ${reason ?? 'unknown error'}`));
      }
      resolve();
    };
    s.speak(u);
  });
}

/** Split on sentence ends, and cap very long sentences so Chrome cannot cut them. */
function chunks(text: string): string[] {
  const out: string[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const s = sentence.trim();
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
    s.cancel(); // drop anything queued by a previous call
    let stopped = false;
    stopWeb = () => {
      stopped = true;
      s.cancel();
    };
    const voices = await loadWebVoices();
    const voice = webVoiceFor(voices, opts.voiceId);
    for (const item of items) {
      if (stopped) return;
      const parts = chunks(item.text);
      if (parts.length === 0) {
        ev.onEnd?.(item.id);
        continue;
      }
      let cursor = 0;
      for (const part of parts) {
        if (stopped) return;
        // Boundary offsets are per utterance; report them against the sentence.
        const at = item.text.indexOf(part, cursor);
        const offset = at >= 0 ? at : cursor;
        cursor = offset + part.length;
        await speakOne(s, part, voice, opts.rate, 'en-US', ev, item.id, offset, () => stopped);
      }
      if (!stopped) ev.onEnd?.(item.id);
    }
  },
  stop() {
    stopWeb?.();
  },
  pause() {
    synth()?.pause();
  },
  resume() {
    synth()?.resume();
  },
};

// ---------------------------------------------------------------------------
// Native (Capacitor)
// ---------------------------------------------------------------------------

interface NativeTts {
  speak(opts: { text: string; lang?: string; rate?: number; voice?: number }): Promise<void>;
  stop(): Promise<void>;
  getSupportedVoices(): Promise<{ voices: { name: string; lang: string; voiceURI: string }[] }>;
}

let nativeModule: Promise<NativeTts> | null = null;

function loadNative(): Promise<NativeTts> {
  nativeModule ??= import('@capacitor-community/text-to-speech').then((m) => m.TextToSpeech as NativeTts);
  return nativeModule;
}

interface NativeVoice {
  name: string;
  lang: string;
  voiceURI: string;
}

let nativeVoices: NativeVoice[] | null = null;

async function loadNativeVoices(): Promise<NativeVoice[]> {
  if (nativeVoices) return nativeVoices;
  const tts = await loadNative();
  const res = await tts.getSupportedVoices();
  nativeVoices = res.voices ?? [];
  return nativeVoices;
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
    let stopped = false;
    stopNative = () => {
      stopped = true;
      void tts.stop();
    };
    const voices = await loadNativeVoices();
    const index = opts.voiceId ? voices.findIndex((v) => v.voiceURI === opts.voiceId || v.name === opts.voiceId) : -1;
    for (const item of items) {
      if (stopped) return;
      ev.onStart?.(item.id);
      // speak() resolves when the utterance finishes on both platforms.
      await tts.speak({
        text: item.text,
        lang: 'en-US',
        rate: opts.rate,
        ...(index >= 0 ? { voice: index } : {}),
      });
      if (stopped) return;
      ev.onEnd?.(item.id);
    }
  },
  stop() {
    stopNative?.();
  },
  pause() {
    // The plugin has no pause; stopping is the closest honest behaviour.
    stopNative?.();
  },
  resume() {
    /* nothing to resume: pause() stopped the queue */
  },
};

let stopNative: (() => void) | null = null;

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
  },
};
