/**
 * Pocket's built-in voices, without the model.
 *
 * `PocketEngine.listVoices()` can only answer after `prepare()`: the voice names
 * arrive inside the bundle's `bundle.json` (`predefined_voices`), which is fetched
 * from the model host together with the weights. That left a device with the
 * model already downloaded — but not loaded in this session — with no voice
 * picker at all, so the reader could not choose a voice before pressing Play.
 *
 * The names below are that file's list, verbatim, for the one pinned bundle
 * (`LANGUAGE = 'english_2026-04'` in `pocket.ts`):
 * https://huggingface.co/vlapky/pocket-tts-onnx/resolve/main/onnx/english_2026-04/bundle.json
 *
 * Keep this list in step with the bundle. `pocket.ts` should eventually import
 * it as the fallback for `listVoices()` (and for the first-voice default) so the
 * panel and the engine cannot disagree.
 */
import type { TtsVoice } from '../../core/types';

/** id → display name; Pocket speaks English only, and every bundle voice is English. */
const NAMES = ['alba', 'azelma', 'cosette', 'eponine', 'fantine', 'javert', 'jean', 'marius'] as const;

export const POCKET_VOICES: TtsVoice[] = NAMES.map((name) => ({
  id: name,
  name: name.charAt(0).toUpperCase() + name.slice(1),
  lang: 'en',
}));
