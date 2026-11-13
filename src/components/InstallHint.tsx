/**
 * iOS only: Safari deletes everything this app stores after seven days without
 * a visit, and `navigator.storage.persist()` answers no there. An installed app
 * on the Home Screen is the one thing that stops it, so the reader is told once
 * — before the shelf is gone, not after.
 *
 * Every other platform renders nothing: Android and desktop Chrome keep the
 * data on their own, and the hint would only be noise.
 */
import { useEffect, useState } from 'react';
import { isIos, isStandalone } from '../core/platform';
import { getSetting, setSetting } from '../core/settings';
import styles from './InstallHint.module.css';

/** Read once and kept: the advice has been read, not the problem solved. */
export const INSTALL_HINT_DISMISSED_KEY = 'ui.dismiss.installHint';

function ShareIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3.5v10" />
      <path d="M8.4 6.9 12 3.5l3.6 3.4" />
      <path d="M7 10.5H5.6A1.6 1.6 0 0 0 4 12.1v7.3a1.6 1.6 0 0 0 1.6 1.6h12.8a1.6 1.6 0 0 0 1.6-1.6v-7.3a1.6 1.6 0 0 0-1.6-1.6H17" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
    </svg>
  );
}

export default function InstallHint() {
  // Decided once per mount: opening the app from the Home Screen is a fresh start.
  const [applies] = useState(() => isIos() && !isStandalone());
  // `null` while the stored answer is being read, so a dismissed hint never flashes.
  const [dismissed, setDismissed] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    void getSetting<boolean>(INSTALL_HINT_DISMISSED_KEY, false)
      .then((value) => {
        if (alive) setDismissed(value === true);
      })
      .catch(() => {
        // A settings read that failed must not hide the warning.
        if (alive) setDismissed(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!applies || dismissed !== false) return null;

  function dismiss(): void {
    setDismissed(true);
    void setSetting(INSTALL_HINT_DISMISSED_KEY, true).catch(() => undefined);
  }

  return (
    <div className={`banner banner-warning ${styles.hint}`} role="status">
      <ShareIcon />
      <div className={styles.body}>
        <p className="banner-title">Keep your library on this iPhone</p>
        <p>
          On iPhone, Safari deletes your library if you don’t open PharmaReader for 7 days. To keep it, tap Share, then
          Add to Home Screen.
        </p>
      </div>
      <button
        type="button"
        className={`btn btn-ghost btn-icon ${styles.dismiss}`}
        aria-label="Dismiss"
        onClick={dismiss}
      >
        <CloseIcon />
      </button>
    </div>
  );
}
