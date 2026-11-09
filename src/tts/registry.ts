/**
 * Which engine actually speaks.
 *
 * The reader must never be blocked by a model that is not there yet: every
 * resolution path ends at the system voices, which are always available.
 */
import { Capacitor } from '@capacitor/core';
import { getSetting } from '../core/settings';
import type { TtsEngine } from '../core/types';
import { rtfSettingKey } from './neural/benchmark';
import { kokoroEngine } from './neural/kokoro';
import { kokoroServerEngine } from './neural/kokoroServer';
import { pocketEngine } from './neural/pocket';
import { kokoroNativeEngine } from './native/kokoroNativeEngine';
import { systemEngine } from './system';

/** Same key the settings panel writes (`TTS_ENGINE_SETTING`). */
export const ENGINE_SETTING = 'tts.engine';

export type EngineChoice = 'auto' | 'system' | 'pocket' | 'kokoro' | 'kokoro-server';

/**
 * The neural models exist twice: the same Kokoro weights run in a native
 * sherpa-onnx plugin on Android and on WASM in the browser.
 */
export function kokoroFor(): TtsEngine {
  return Capacitor.isNativePlatform() ? kokoroNativeEngine : kokoroEngine;
}

/** Engines the player can choose between, in preference order for "auto". */
export function allEngines(): TtsEngine[] {
  return [systemEngine, pocketEngine, kokoroFor()];
}

/** A model that throws while probing readiness is simply not ready. */
async function ready(engine: TtsEngine): Promise<boolean> {
  try {
    return await engine.isReady();
  } catch {
    return false;
  }
}

/** An engine is worth using automatically only when measured faster than real time. */
async function fastEnough(engine: TtsEngine): Promise<boolean> {
  const rtf = await getSetting<number | undefined>(rtfSettingKey(engine.id), undefined);
  return typeof rtf === 'number' && Number.isFinite(rtf) && rtf > 0 && rtf < 1;
}

export async function resolveEngine(): Promise<TtsEngine> {
  const choice = await getSetting<string>(ENGINE_SETTING, 'auto');

  if (choice !== 'auto') {
    // kokoro-server is LAN-only and deliberately not in `allEngines()` (the
    // player/prerender list), but the settings panel offers it — honour it.
    const candidates = [...allEngines(), kokoroServerEngine];
    const picked = candidates.find((engine) => engine.id === choice);
    if (picked && (await ready(picked))) return picked;
    return systemEngine;
  }

  for (const engine of [kokoroFor(), pocketEngine]) {
    if ((await ready(engine)) && (await fastEnough(engine))) return engine;
  }
  return systemEngine;
}

export interface EngineInfo {
  engine: TtsEngine;
  /** False when the user's choice fell back to the system voices. */
  preferred: boolean;
}

/** Like `resolveEngine`, but tells the UI whether a fallback happened. */
export async function describeEngine(): Promise<EngineInfo> {
  const choice = await getSetting<string>(ENGINE_SETTING, 'auto');
  const engine = await resolveEngine();
  return { engine, preferred: choice === 'auto' ? engine.id !== 'system' : engine.id === choice };
}
