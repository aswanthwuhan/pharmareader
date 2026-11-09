import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    VitePWA({
      // native shell bundles its own assets; a service worker there would serve stale code after app updates
      disable: mode === 'native',
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'PharmaReader',
        short_name: 'PharmaReader',
        description: 'Offline-first reader for MD Pharmacology study material.',
        theme_color: '#0f4c5c',
        background_color: '#0f4c5c',
        display: 'standalone',
        start_url: '/',
        icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        // TTS models are hundreds of MB and are downloaded at runtime, never precached.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,woff2}'],
      },
    }),
  ],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    // Scratch work under .tmp/ must never leak into the suite.
    exclude: [...configDefaults.exclude, '.tmp/**'],
  },
}));
