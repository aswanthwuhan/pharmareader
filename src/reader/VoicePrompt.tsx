/**
 * The in-reader offer for Kokoro: a bottom sheet that can start the on-device
 * download without leaving the book.
 *
 * It is opened from three places — the voice pill while the phone voice reads, the
 * first Play while Kokoro is not downloaded, and the library/reader banner — and it
 * writes the engine choice only after the download reports `done`. Closing the sheet
 * never cancels the download: the state lives in `downloads.ts`, outside React.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { pushBackHandler } from '../core/backButton';
import { isIos } from '../core/platform';
import { setSetting } from '../core/settings';
import { useDownload } from '../tts/downloads';
import {
  canRunKokoro,
  IOS_KOKORO_SHEET_LINE,
  startKokoroDownload,
  VOICE_LIST_POINTER,
} from '../tts/kokoroOffer';
import { kokoroSizeMb } from '../tts/neural/sizes';
import { ENGINE_SETTING } from '../tts/registry';
import './VoicePrompt.css';

export interface VoicePromptProps {
  /** Mount/display the sheet; `false` keeps the component alive but invisible. */
  open: boolean;
  /** Removes the sheet. Never cancels a running download. */
  onClose: () => void;
  /** Where the sheet was opened from; kept for the prompt-once bookkeeping done by the opener. */
  source?: 'pill' | 'banner' | 'auto';
}

export default function VoicePrompt({ open, onClose }: VoicePromptProps) {
  const titleId = useId();
  const sheetRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const download = useDownload('kokoro');
  /** A download was started from this sheet; without it a stale `done` would switch voices. */
  const [attempted, setAttempted] = useState(false);
  const [switched, setSwitched] = useState(false);

  const close = () => closeRef.current();
  const closeFnRef = useRef(close);
  closeFnRef.current = close;

  const busy = download.status === 'downloading' || download.status === 'unpacking';
  const done = download.status === 'done';
  const failed = download.status === 'error';

  // Focus and the Android back key belong to the sheet while it is open.
  useEffect(() => {
    if (!open) return;
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    startRef.current?.focus();

    function focusables(): HTMLElement[] {
      const root = sheetRef.current;
      if (!root) return [];
      return Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeFnRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    const dispose = pushBackHandler(() => {
      closeFnRef.current();
      return true;
    });

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      dispose();
      if (returnTo && document.contains(returnTo)) returnTo.focus();
    };
  }, [open]);

  // A finished download becomes the reading voice, and the sheet says so before closing.
  useEffect(() => {
    if (!open || !attempted || !done || switched) return;
    setSwitched(true);
    void setSetting(ENGINE_SETTING, 'kokoro').catch(() => undefined);
  }, [open, attempted, done, switched]);

  // A closed sheet forgets the success, so opening it again later offers the normal
  // state instead of a stale "ready" message. A download still running keeps its
  // attempt, so finishing while the sheet is closed still switches the voice.
  useEffect(() => {
    if (open) return;
    setSwitched(false);
    if (download.status !== 'downloading' && download.status !== 'unpacking') {
      setAttempted(false);
    }
  }, [open, download.status]);

  useEffect(() => {
    if (!open || !switched) return;
    const timer = window.setTimeout(() => closeFnRef.current(), 1800);
    return () => window.clearTimeout(timer);
  }, [open, switched]);

  if (!open) return null;

  // On an iPhone the phone voice may never start, which is the other half of the
  // reason to offer Kokoro here — but only where Kokoro can actually run.
  const ios = isIos();
  const kokoroRuns = canRunKokoro();
  const phoneVoiceWarning = ios && kokoroRuns && !switched && !done;

  const percent = Math.max(0, Math.min(100, Math.round(download.fraction * 100)));
  const stageText =
    download.stage === 'unpack'
      ? `Unpacking Kokoro — ${percent}%`
      : download.stage === 'load'
        ? 'Loading Kokoro — almost done.'
        : `Downloading Kokoro — ${percent}%`;

  const start = () => {
    setAttempted(true);
    setSwitched(false);
    void startKokoroDownload();
  };

  const useDownloaded = () => {
    void setSetting(ENGINE_SETTING, 'kokoro').catch(() => undefined);
    close();
  };

  return (
    <>
      <div className="sheet-backdrop" onClick={close} />
      <div
        ref={sheetRef}
        className="sheet voice-prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h2 id={titleId} className="sheet-title">
          Kokoro, the natural voice
        </h2>

        <div className="voice-prompt-body">
          {switched ? (
            <p className="voice-prompt-status" role="status">
              Kokoro is ready. It will read from here.
            </p>
          ) : done ? (
            <>
              <p className="voice-prompt-status" role="status">
                Kokoro is already downloaded on this device.
              </p>
              <p className="voice-prompt-note">You can start reading with it straight away.</p>
            </>
          ) : failed ? (
            <>
              <p className="voice-prompt-status" role="alert">
                Kokoro didn’t finish downloading.
              </p>
              {download.error ? <p className="voice-prompt-note">{download.error}</p> : null}
              <p className="voice-prompt-note">
                The phone voice is still reading your book. You can try again.
              </p>
            </>
          ) : busy ? (
            <>
              <p className="voice-prompt-progress-label">{stageText}</p>
              <div
                className="progress voice-prompt-progress"
                role="progressbar"
                aria-label="Kokoro download progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
              >
                <span style={{ width: `${percent}%` }} />
              </div>
              <p className="voice-prompt-note">
                You can close this and keep reading. The download continues.
              </p>
            </>
          ) : (
            <>
              <p>
                Kokoro is a higher quality voice than the phone voice, and it sounds more natural
                reading a whole chapter.
              </p>
              <p>
                It runs on this device. Download it once ({kokoroSizeMb()} MB), and it works
                offline from then on.
              </p>
              <p className="voice-prompt-note">{VOICE_LIST_POINTER}</p>
            </>
          )}
          {phoneVoiceWarning ? (
            <p className="voice-prompt-note voice-prompt-ios">{IOS_KOKORO_SHEET_LINE}</p>
          ) : null}
        </div>

        <div className="sheet-actions voice-prompt-actions">
          {switched ? (
            <button type="button" className="btn btn-secondary" onClick={close}>
              Close
            </button>
          ) : done ? (
            <>
              <button type="button" className="btn btn-secondary" onClick={close}>
                Not now
              </button>
              <button ref={startRef} type="button" className="btn btn-primary" onClick={useDownloaded}>
                Use Kokoro
              </button>
            </>
          ) : failed ? (
            <>
              <button type="button" className="btn btn-secondary" onClick={close}>
                Close
              </button>
              <button ref={startRef} type="button" className="btn btn-primary" onClick={start}>
                Retry
              </button>
            </>
          ) : busy ? (
            <button ref={startRef} type="button" className="btn btn-secondary" onClick={close}>
              Close
            </button>
          ) : (
            <>
              <button type="button" className="btn btn-secondary" onClick={close}>
                Not now
              </button>
              <button ref={startRef} type="button" className="btn btn-primary" onClick={start}>
                Download Kokoro
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
