/// <reference types="vite/client" />

/**
 * The running app version, injected by `define` in vite.config.ts from
 * package.json. Vitest shares that config, so tests see the real number too.
 */
declare const __APP_VERSION__: string;
