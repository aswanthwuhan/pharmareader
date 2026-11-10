/**
 * The Android back key, in one place.
 *
 * A WebView's history is not a menu. A reader can sit hundreds of sentences into
 * a book with a sheet open; "back" there must close the sheet, then leave the
 * book — it must never drop the reader out of the app by accident. The native
 * shell calls `window.__pharmaBack()` and gets `true` when the app handled the
 * press. It gets `false` only from the library itself, where "back" is the one
 * case that may ask "Exit PharmaReader?".
 */

type BackHandler = () => boolean;

/** Open handlers, oldest first; the newest registered one gets the press first. */
const handlers: BackHandler[] = [];

/**
 * Register a back handler on top of the stack. It returns `true` when it used
 * the press (a sheet closed), `false` to let older handlers (or navigation)
 * have it. Returns an unsubscribe function; calling it twice is harmless.
 */
export function pushBackHandler(fn: BackHandler): () => void {
  handlers.push(fn);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const at = handlers.lastIndexOf(fn);
    if (at !== -1) handlers.splice(at, 1);
  };
}

/** Run the open handlers newest first. True when one of them handled the press. */
function runHandlers(): boolean {
  // Snapshot the length: a handler may unregister itself (closing a sheet) and
  // the press still belongs to the handler that was on top when it started.
  for (let i = handlers.length - 1; i >= 0; i -= 1) {
    const fn = handlers[i];
    if (fn && fn()) return true;
  }
  return false;
}

declare global {
  interface Window {
    /** Installed by {@link installBackBridge}; read by the Android shell. */
    __pharmaBack?: () => boolean;
  }
}

/**
 * Expose `window.__pharmaBack` for the native shell. Handlers run first; then a
 * non-library page steps back to the library (the app's menu); only the library
 * itself returns false, which is the shell's cue to ask about exiting.
 *
 * Returns a disposer that removes the bridge again (only when it is still ours).
 */
export function installBackBridge(
  navigate: (to: string) => void,
  getPath: () => string,
): () => void {
  const previous = window.__pharmaBack;
  const onBack = (): boolean => {
    if (runHandlers()) return true;
    if (getPath() !== '/') {
      // The library is the menu: from any screen, one back press lands there.
      navigate('/');
      return true;
    }
    return false;
  };
  window.__pharmaBack = onBack;
  return () => {
    if (window.__pharmaBack !== onBack) return;
    if (previous) window.__pharmaBack = previous;
    else delete window.__pharmaBack;
  };
}
