/**
 * Constants the native Kokoro engine and the Settings voice list both need.
 *
 * This module deliberately imports neither Capacitor nor the native plugin: the
 * Settings page is opened on the web too, where merely importing the engine would
 * register a plugin that does not exist.
 */

/** Voice used when nothing is configured: `af_heart` (sid 3). */
export const DEFAULT_KOKORO_SID = 3;
export const KOKORO_VOICE_SETTING = 'tts.voice.kokoro';
