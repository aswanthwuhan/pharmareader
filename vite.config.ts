import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import packageJson from './package.json' with { type: 'json' };

// GitHub Pages serves the PWA from /pharmareader/; dev, Capacitor and Tauri need '/'.
// The workflow sets VITE_BASE=/pharmareader/ at build time.
const rawBase = process.env.VITE_BASE ?? '/';
const base = rawBase.endsWith('/') ? rawBase : `${rawBase}/`;

export default defineConfig(({ mode }) => ({
  base,
  // Pinned so a Vite upgrade cannot silently raise the floor. iOS 15.4 is the
  // oldest Safari pdf.js runs on (structuredClone, Object.hasOwn); Chrome 110 is
  // the oldest Android WebView supported (see src/import/pdfPolyfill.ts).
  build: { target: ['safari15.4', 'ios15.4', 'chrome110', 'edge110', 'firefox115'] },
  // The What's new sheet and the update check compare against the version that
  // is actually running, so it comes from package.json at build time.
  define: { __APP_VERSION__: JSON.stringify(packageJson.version) },
  plugins: [
    react(),
    VitePWA({
      // native shell bundles its own assets; a service worker there would serve stale code after app updates
      disable: mode === 'native',
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'PharmaReader',
        short_name: 'PharmaReader',
        description: 'Offline-first reader for MD Pharmacology study material.',
        theme_color: '#0f4c5c',
        background_color: '#0f4c5c',
        display: 'standalone',
        // the whole app lives under the deploy path, so the install scope is that path too
        start_url: base,
        scope: base,
        // relative to the manifest, which sits at the base path
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          // iOS and some Android launchers ignore SVG manifest icons
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        ],
      },
      workbox: {
        // TTS models are hundreds of MB and are downloaded at runtime, never precached.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,woff2}'],
        // SPA deep links (e.g. /pharmareader/read/abc on reload) must land on the shell.
        navigateFallback: `${base}index.html`,
        // onnxruntime-web wasm (~22 MB) is too big to precache; cache on first use so later launches work offline.
        runtimeCaching: [
          {
            // matches <base>ort/ wherever the app is mounted
            urlPattern: ({ url }) => url.pathname.includes('/ort/'),
            handler: 'CacheFirst',
            options: { cacheName: 'ort-runtime', expiration: { maxEntries: 10 } },
          },
        ],
      },
    }),
  ],
  // pocket-tts-js spawns its worker via new URL(import.meta.url); esbuild pre-bundling breaks that path
  optimizeDeps: { exclude: ['pocket-tts-js'] },
  worker: { format: 'es' },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    // Scratch work under .tmp/ must never leak into the suite.
    exclude: [...configDefaults.exclude, '.tmp/**'],
  },
}));
