/**
 * Says which voice will actually read, before the reader finds out by tapping.
 *
 * Every state here is a fallback the app is already doing quietly: no model is
 * installed, a model is installed but has never been measured, the phone has no
 * speech engine at all. The banner is a sentence of fact plus the one action
 * that changes it — never a blocker. Checks run after paint, and a component
 * that unmounts mid-probe simply never shows anything.
 */
import { Capacitor } from '@capacitor/core';
import { useEffect, useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { getSetting, setSetting, useSetting } from '../core/settings';
import type { TtsEngine, TtsVoice } from '../core/types';
import { useDownload } from './downloads';
import { rtfSettingKey } from './neural/benchmark';
import { allEngines, describeEngine, ENGINE_SETTING, kokoroFor, type EngineChoice } from './registry';

/** Remembered so the tip does not return on every book. */
export const NO_MODEL_TIP_KEY = 'ui.dismiss.noModelTip';

const SETTINGS_LINK = '/settings#voice-models';

const MODEL_NAMES: Record<'pocket' | 'kokoro', string> = {
  pocket: 'Pocket TTS',
  kokoro: 'Kokoro',
};

type BannerKind = 'info' | 'warning' | 'error';

interface Banner {
  kind: BannerKind;
  /** The one thing that is true. */
  text: string;
  /** Offer the route to the voice models section. */
  download: boolean;
  /** Only a tip the reader can live without may be dismissed. */
  dismissible: boolean;
}

interface Probe {
  /** The model the reader chose by name, and whether it can speak. */
  chosen: { id: 'pocket' | 'kokoro'; ready: boolean } | null;
  pocketReady: boolean;
  kokoroReady: boolean;
  /** A stored speed measurement is what lets Auto pick a model. */
  measured: boolean;
  /** The choice fell back to the system voices. */
  fallback: boolean;
  /** Native Android with no installed speech engine at all. */
  noSystemVoices: boolean;
}

async function isReady(engine: TtsEngine | undefined): Promise<boolean> {
  if (!engine) return false;
  try {
    return await engine.isReady();
  } catch {
    return false;
  }
}

async function hasMeasurement(engine: TtsEngine | undefined): Promise<boolean> {
  if (!engine) return false;
  const rtf = await getSetting<number | undefined>(rtfSettingKey(engine.id), undefined);
  return typeof rtf === 'number' && Number.isFinite(rtf);
}

function isNativeAndroid(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  } catch {
    // A build without the Capacitor bridge is the web build.
    return false;
  }
}

function neuralEngines(): { pocket: TtsEngine | undefined; kokoro: TtsEngine } {
  const engines = allEngines();
  return {
    pocket: engines.find((engine) => engine.id === 'pocket'),
    kokoro: engines.find((engine) => engine.id === 'kokoro') ?? kokoroFor(),
  };
}

function systemEngineOf(): TtsEngine | undefined {
  return allEngines().find((engine) => engine.id === 'system');
}

/** `null` while the probes are still running, and when nothing is worth saying. */
function decide(choice: EngineChoice, probe: Probe): Banner | null {
  if (probe.chosen && !probe.chosen.ready && probe.fallback) {
    return {
      kind: 'warning',
      text: `${MODEL_NAMES[probe.chosen.id]} voice isn't downloaded yet — reading with the phone's built-in voice.`,
      download: true,
      dismissible: false,
    };
  }

  if (choice === 'auto') {
    const installed = probe.pocketReady || probe.kokoroReady;
    if (!installed) {
      return {
        kind: 'info',
        text: "Using your phone's built-in voice. Download Kokoro or Pocket TTS in Settings for a more natural voice.",
        download: true,
        dismissible: true,
      };
    }
    if (!probe.measured) {
      return {
        kind: 'info',
        text: "Voice model installed — run 'Measure speed' in Settings so Auto can use it.",
        download: false,
        dismissible: false,
      };
    }
    return null;
  }

  if (probe.noSystemVoices) {
    return {
      kind: 'error',
      text: "No text-to-speech engine found on this phone. Install 'Speech Services by Google' from the Play Store.",
      download: false,
      dismissible: false,
    };
  }

  return null;
}

const ICON_WARNING = (
  <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7">
    <path d="M12 3.8 2.7 19.4h18.6L12 3.8Z" />
    <path d="M12 9.6v4.2" />
    <path d="M12 16.6h.01" />
  </svg>
);

const ICON_INFO = (
  <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.4" />
    <path d="M12 7.6h.01" />
  </svg>
);

const ICON_ERROR = (
  <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.2v5.6" />
    <path d="M12 16.6h.01" />
  </svg>
);

const ICONS: Record<BannerKind, ReactElement> = {
  info: ICON_INFO,
  warning: ICON_WARNING,
  error: ICON_ERROR,
};

const CLASSES: Record<BannerKind, string> = {
  info: 'banner banner-info',
  warning: 'banner banner-warning',
  error: 'banner banner-error',
};

export interface ModelStatusBannerProps {
  /** Where the banner is mounted; the copy is the same, the slot is not. */
  context: 'reader' | 'library';
}

export default function ModelStatusBanner({ context }: ModelStatusBannerProps) {
  const choice = useSetting<string>(ENGINE_SETTING, 'auto');
  const dismissed = useSetting<boolean>(NO_MODEL_TIP_KEY, false);
  const pocketDownload = useDownload('pocket');
  const kokoroDownload = useDownload('kokoro');
  const [banner, setBanner] = useState<Banner | null>(null);

  // A download started from Settings keeps running while the reader browses; under
  // Auto no model is named, so follow whichever one is actually downloading.
  const runningId: 'pocket' | 'kokoro' | null =
    pocketDownload.status === 'downloading' || pocketDownload.status === 'unpacking'
      ? 'pocket'
      : kokoroDownload.status === 'downloading' || kokoroDownload.status === 'unpacking'
        ? 'kokoro'
        : null;
  const runningDownload = runningId === 'pocket' ? pocketDownload : runningId === 'kokoro' ? kokoroDownload : null;

  useEffect(() => {
    let alive = true;
    setBanner(null);

    const engineChoice: EngineChoice =
      choice === 'system' || choice === 'pocket' || choice === 'kokoro' ? choice : 'auto';

    const run = async (): Promise<void> => {
      try {
        const { pocket, kokoro } = neuralEngines();
        const chosenEngine =
          engineChoice === 'pocket' ? pocket : engineChoice === 'kokoro' ? kokoro : undefined;
        const needsVoices = engineChoice === 'system';

        const [pocketReady, kokoroReady, chosenReady, measured, info, voices] = await Promise.all([
          isReady(pocket),
          isReady(kokoro),
          chosenEngine ? isReady(chosenEngine) : Promise.resolve(false),
          Promise.all([hasMeasurement(pocket), hasMeasurement(kokoro)]),
          describeEngine().catch(() => null),
          needsVoices && isNativeAndroid()
            ? (systemEngineOf()
                ?.listVoices()
                .catch(() => [] as TtsVoice[]) ?? Promise.resolve([] as TtsVoice[]))
            : Promise.resolve(null),
        ]);
        if (!alive) return;

        const probe: Probe = {
          chosen:
            engineChoice === 'pocket' || engineChoice === 'kokoro'
              ? { id: engineChoice, ready: chosenReady }
              : null,
          pocketReady,
          kokoroReady,
          // Either model measured is enough for Auto to have a choice.
          measured: measured.some(Boolean),
          fallback: info ? !info.preferred : true,
          // Only a device that cannot speak at all earns the error.
          noSystemVoices: Boolean(voices) && voices !== null && voices.length === 0,
        };
        setBanner(decide(engineChoice, probe));
      } catch {
        // A probe failure is not a reading failure: say nothing.
      }
    };

    void run();
    return () => {
      alive = false;
    };
  }, [
    choice,
    // Re-probe when a download ends: "isn't downloaded yet" must not outlive it.
    pocketDownload.status,
    kokoroDownload.status,
  ]);

  if (runningId && runningDownload) {
    // The download is still running in the background store, so say that instead of
    // "isn't downloaded yet" — the reader may be on a screen far from Settings.
    const percent = Math.round(runningDownload.fraction * 100);
    return (
      <div className="banner banner-info" role="status" data-context={context}>
        {ICON_INFO}
        <div>
          <p>
            Downloading {MODEL_NAMES[runningId]} — {percent}%. Reading with the phone&apos;s built-in voice until it is
            ready.
          </p>
          <p>
            <Link to={SETTINGS_LINK} className="rd-banner-link">
              See the download in Settings
            </Link>
          </p>
        </div>
      </div>
    );
  }

  if (!banner) return null;
  if (banner.dismissible && dismissed) return null;

  // Only the dismissible tip is marked: on a phone held sideways the reader
  // hides it, because its player's voice pill says the same thing. A warning or
  // a "measure speed" prompt has nowhere else to appear and stays.
  return (
    <div
      className={CLASSES[banner.kind]}
      role={banner.kind === 'error' ? 'alert' : 'status'}
      data-context={context}
      data-dismissible={banner.dismissible ? 'true' : undefined}
    >
      {ICONS[banner.kind]}
      <div>
        <p>{banner.text}</p>
        {banner.download ? (
          <p>
            <Link to={SETTINGS_LINK} className="rd-banner-link">
              Download in Settings
            </Link>
          </p>
        ) : null}
      </div>
      {banner.dismissible ? (
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label="Dismiss tip"
          onClick={() => void setSetting(NO_MODEL_TIP_KEY, true)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7">
            <path d="M6.5 6.5 17.5 17.5" />
            <path d="M17.5 6.5 6.5 17.5" />
          </svg>
        </button>
      ) : null}
    </div>
  );
}
