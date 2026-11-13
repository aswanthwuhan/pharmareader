/**
 * Says which voice will actually read, before the reader finds out by tapping.
 *
 * Every state here is a fallback the app is already doing quietly: no model is
 * installed, a model is installed but has never been measured, the phone has no
 * speech engine at all. The banner is a sentence of fact plus the one action
 * that changes it — never a blocker. Checks run after paint, and a component
 * that unmounts mid-probe simply never shows anything.
 *
 * On an iPhone the phone voice may never start at all, so wherever it would be the
 * one reading, the dismissible tip gives way to that warning — which is why it is
 * never marked `data-dismissible`.
 */
import { Capacitor } from '@capacitor/core';
import { useEffect, useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { getSetting, setSetting, useSetting } from '../core/settings';
import type { TtsEngine, TtsVoice } from '../core/types';
import VoicePrompt from '../reader/VoicePrompt';
import { useDownload } from './downloads';
import {
  canRunKokoro,
  iosPhoneVoiceNotice,
  type IosPhoneVoiceNotice,
  VOICE_LIST_POINTER,
} from './kokoroOffer';
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
  /** Only the iPhone warning has a headline of its own. */
  title?: string;
  /** The one thing that is true. */
  text: string;
  /** Offer a way to the voice models. */
  download: boolean;
  /** The action opens the in-place Kokoro offer instead of linking to Settings. */
  downloadKokoro: boolean;
  /** Only a tip the reader can live without may be dismissed. */
  dismissible: boolean;
}

interface Probe {
  /** The model the reader chose by name, and whether it can speak. */
  chosen: { id: 'pocket' | 'kokoro'; ready: boolean } | null;
  pocketReady: boolean;
  kokoroReady: boolean;
  /** Kokoro can run on this device at all (native Android, or web with SIMD). */
  kokoroUsable: boolean;
  /** A stored speed measurement is what lets Auto pick a model. */
  measured: boolean;
  /** The choice fell back to the system voices. */
  fallback: boolean;
  /** Native Android with no installed speech engine at all. */
  noSystemVoices: boolean;
  /** Set on an iPhone or iPad while the phone voice is what would read. */
  ios: IosPhoneVoiceNotice | null;
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

/** The iPhone warning: a fact, and — where Kokoro runs — the way to it. */
function iosWarning(notice: IosPhoneVoiceNotice): Banner {
  return {
    kind: 'warning',
    title: notice.title,
    text: notice.body,
    download: notice.recommend,
    downloadKokoro: notice.recommend,
    dismissible: false,
  };
}

/** `null` while the probes are still running, and when nothing is worth saying. */
function decide(choice: EngineChoice, probe: Probe): Banner | null {
  if (probe.chosen && !probe.chosen.ready && probe.fallback) {
    // On an iPhone the fallback is the voice that may never start: warn, do not
    // blame the missing model.
    if (probe.ios) return iosWarning(probe.ios);
    return {
      kind: 'warning',
      text: `${MODEL_NAMES[probe.chosen.id]} voice isn't downloaded yet — reading with the phone's built-in voice.`,
      download: true,
      downloadKokoro: probe.chosen.id === 'kokoro' && probe.kokoroUsable,
      dismissible: false,
    };
  }

  if (choice === 'auto') {
    const installed = probe.pocketReady || probe.kokoroReady;
    if (!installed) {
      // The iPhone warning replaces the tip, so it must not be dismissible.
      if (probe.ios) return iosWarning(probe.ios);
      return {
        kind: 'info',
        text: probe.kokoroUsable
          ? "Using your phone's built-in voice. Kokoro is higher quality and sounds more natural — download it once, and it works offline."
          : "Using your phone's built-in voice. Download Pocket TTS in Settings for a more natural voice.",
        download: true,
        downloadKokoro: probe.kokoroUsable,
        dismissible: true,
      };
    }
    if (!probe.measured) {
      return {
        kind: 'info',
        text: "Voice model installed — run 'Measure speed' in Settings so Auto can use it.",
        download: false,
        downloadKokoro: false,
        dismissible: false,
      };
    }
    return null;
  }

  // The phone voice chosen outright is the same risk as falling back to it.
  if (choice === 'system' && probe.ios) return iosWarning(probe.ios);

  if (probe.noSystemVoices) {
    return {
      kind: 'error',
      text: "No text-to-speech engine found on this phone. Install 'Speech Services by Google' from the Play Store.",
      download: false,
      downloadKokoro: false,
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
  const [voiceOpen, setVoiceOpen] = useState(false);

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
          kokoroUsable: canRunKokoro(),
          // Either model measured is enough for Auto to have a choice.
          measured: measured.some(Boolean),
          fallback: info ? !info.preferred : true,
          // Only a device that cannot speak at all earns the error.
          noSystemVoices: Boolean(voices) && voices !== null && voices.length === 0,
          ios: iosPhoneVoiceNotice(),
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

  // The sheet stays mounted while it downloads: the banner above it can change or
  // disappear, but the progress and the "ready" message must not be unmounted.
  const offer = (
    <VoicePrompt open={voiceOpen} onClose={() => setVoiceOpen(false)} source="banner" />
  );

  if (runningId && runningDownload) {
    // The download is still running in the background store, so say that instead of
    // "isn't downloaded yet" — the reader may be on a screen far from Settings.
    const percent = Math.round(runningDownload.fraction * 100);
    return (
      <>
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
        {offer}
      </>
    );
  }

  if (!banner) return offer;
  if (banner.dismissible && dismissed) return offer;

  // Only the dismissible tip is marked: on a phone held sideways the reader
  // hides it, because its player's voice pill says the same thing. A warning or
  // a "measure speed" prompt has nowhere else to appear and stays.
  return (
    <>
      <div
        className={CLASSES[banner.kind]}
        role={banner.kind === 'error' ? 'alert' : 'status'}
        data-context={context}
        data-dismissible={banner.dismissible ? 'true' : undefined}
      >
        {ICONS[banner.kind]}
        <div>
          {banner.title ? <p className="banner-title">{banner.title}</p> : null}
          <p>{banner.text}</p>
          {banner.download ? (
            <p>
              {banner.downloadKokoro ? (
                <button
                  type="button"
                  className="rd-banner-link"
                  onClick={() => setVoiceOpen(true)}
                >
                  Download Kokoro
                </button>
              ) : (
                <Link to={SETTINGS_LINK} className="rd-banner-link">
                  Download in Settings
                </Link>
              )}
            </p>
          ) : null}
          {banner.download && banner.downloadKokoro ? (
            <p className="rd-banner-note">{VOICE_LIST_POINTER}</p>
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
      {offer}
    </>
  );
}
