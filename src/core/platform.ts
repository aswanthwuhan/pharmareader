/**
 * The two platform questions that decide how PharmaReader keeps its data.
 *
 * Safari on iOS deletes every script-writable store (IndexedDB books,
 * highlights and cards; Cache Storage voices) after seven days without a visit,
 * and `navigator.storage.persist()` cannot prevent it there — only adding the
 * app to the Home Screen does. Both checks are safe off the browser: a build
 * that renders without a window gets `false`, never a crash.
 */

/** True on iPhone, iPod and iPad — including iPadOS, which claims to be a Mac. */
export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const userAgent = navigator.userAgent ?? '';
  return (
    /iPad|iPhone|iPod/.test(userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

/** True when the page runs as the installed app (Home Screen), not a browser tab. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  // Installed PWAs, and Safari's own Home Screen app, report this display mode.
  const media =
    typeof window.matchMedia === 'function' ? window.matchMedia('(display-mode: standalone)') : null;
  if (media?.matches) return true;
  // iOS Safari before display-mode support still marks itself on navigator.
  return (navigator as { standalone?: boolean }).standalone === true;
}
