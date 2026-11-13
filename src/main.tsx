import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import App from './App';
import './styles.css';
import { isIos, isStandalone } from './core/platform';
import { ensureSyllabusSeeded } from './syllabus/seed';

// BASE_URL carries the deploy sub-path (e.g. /pharmareader/ on GitHub Pages) and is '/'
// for dev, Android and Windows. react-router wants no trailing slash.
const basename = import.meta.env.BASE_URL.replace(/\/+$/, '') || '/';

// A service worker left behind by an older build keeps answering navigations
// with its precached index.html, so an upgraded app quietly runs the previous
// bundle: every chunk it imports is missing from the new install (404 storms,
// features that never show up) and Android still looks like it "kept the old
// version". The Android build ships no service worker — VitePWA is disabled for
// the native mode in vite.config.ts — so on the device any registration is
// stale and has to go.
const SW_RELOAD_FLAG = 'pharmareader:sw-reloaded';

async function dropStaleServiceWorker(): Promise<void> {
  if (!Capacitor.isNativePlatform() || !('serviceWorker' in navigator)) return;
  const registrations = await navigator.serviceWorker.getRegistrations();
  if (!registrations.length) return;
  await Promise.all(registrations.map((registration) => registration.unregister()));
  if (typeof caches !== 'undefined') {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((key) => key.startsWith('workbox-')).map((key) => caches.delete(key)),
    );
  }
  // Reload once so the document comes from the network instead of the old
  // shell. The flag keeps a stubborn cache from turning this into a loop.
  if (sessionStorage.getItem(SW_RELOAD_FLAG) !== '1') {
    sessionStorage.setItem(SW_RELOAD_FLAG, '1');
    window.location.reload();
  }
}

void dropStaleServiceWorker().catch(() => undefined);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={basename}>
      <App />
    </BrowserRouter>
  </StrictMode>,
);

/**
 * Run `task` after the first frame is on screen, in an idle slot.
 *
 * Both boot tasks below are IndexedDB writes, and on a cold start they raced the
 * WebView's first paint — one of the ways the main thread stayed busy long enough
 * for Android to report "Input dispatching timed out". Nothing on the library
 * screen needs either of them, so they can wait a frame and an idle slot.
 */
function afterFirstPaint(task: () => void): void {
  requestAnimationFrame(() => {
    const idle = (window as {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    }).requestIdleCallback;
    if (typeof idle === 'function') idle(task, { timeout: 2000 });
    else setTimeout(task, 200);
  });
}

afterFirstPaint(() => {
  // Ask the browser to keep IndexedDB (books, audio cache) from being evicted.
  // Safari on iOS answers no unless the app is on the Home Screen (see InstallHint).
  if (!isIos() || isStandalone()) void navigator.storage?.persist?.().catch(() => undefined);
  // Topic pickers anywhere in the app need the default syllabus present.
  void ensureSyllabusSeeded().catch((error) => console.warn('Syllabus seed failed', error));
});
