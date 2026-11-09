import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { setSetting, useSetting } from '../core/settings';
import type { LexiconEntry, TtsVoice } from '../core/types';
import { cacheSizeBytes, clearAudio } from './cache';
import {
  deleteUserEntry,
  expand,
  listLexiconEntries,
  saveUserEntry,
  setEntryEnabled,
} from './lexicon';
import { systemEngine } from './system';
import './tts.css';

export const TTS_ENGINE_SETTING = 'tts.engine';
export const TTS_VOICE_SETTING = 'tts.voice.system';
export const TTS_RATE_SETTING = 'tts.rate';

export const TEST_SENTENCE = 'The half-life of CYP3A4 substrates rises with ketoconazole.';

export const VOICE_TIP =
  'For a more natural built-in voice: Android → Settings › Text-to-speech → Google › Install voice data (high quality). iPhone → Settings › Accessibility › Spoken Content › Voices → download an Enhanced/Premium voice.';

type EngineChoice = 'auto' | 'system' | 'pocket' | 'kokoro' | 'kokoro-server';

const ENGINE_OPTIONS: { value: EngineChoice; label: string }[] = [
  { value: 'auto', label: 'Auto (best available)' },
  { value: 'system', label: 'System voices (free, offline)' },
  { value: 'pocket', label: 'Pocket TTS (on-device model)' },
  { value: 'kokoro', label: 'Kokoro (on-device model)' },
  { value: 'kokoro-server', label: 'Kokoro server (LAN)' },
];

const RATE_MIN = 0.5;
const RATE_MAX = 2;
const RATE_STEP = 0.05;

interface Draft {
  id?: string;
  pattern: string;
  replacement: string;
  isRegex: boolean;
}

const EMPTY_DRAFT: Draft = { pattern: '', replacement: '', isRegex: true };

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Case-insensitive search across the rule text, for the lexicon list. */
export function filterEntries(entries: LexiconEntry[], query: string): LexiconEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter(
    (e) =>
      e.pattern.toLowerCase().includes(q) ||
      e.replacement.toLowerCase().includes(q) ||
      e.id.toLowerCase().includes(q),
  );
}

export function isEngineChoice(value: string): value is EngineChoice {
  return ENGINE_OPTIONS.some((o) => o.value === value);
}

interface LexiconEditorProps {
  onError(message: string): void;
}

/** Search, toggle, add and edit the pronunciation rules. */
function LexiconEditor({ onError }: LexiconEditorProps) {
  const [entries, setEntries] = useState<LexiconEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [previewText, setPreviewText] = useState('');
  const [previewResult, setPreviewResult] = useState('');

  const reload = useCallback(async () => {
    try {
      setEntries(await listLexiconEntries());
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Preview is cheap but runs the whole rule list; debounce while typing.
  useEffect(() => {
    if (!previewText.trim()) {
      setPreviewResult('');
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      void expand(previewText).then((out) => {
        if (alive) setPreviewResult(out);
      });
    }, 150);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [previewText, entries]);

  const visible = useMemo(() => filterEntries(entries, query), [entries, query]);

  const toggle = async (entry: LexiconEntry) => {
    try {
      await setEntryEnabled(entry.id, !entry.enabled);
      await reload();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  const save = async () => {
    if (!draft.pattern.trim()) {
      onError('A pattern is required.');
      return;
    }
    try {
      await saveUserEntry({
        id: draft.id,
        pattern: draft.pattern,
        replacement: draft.replacement,
        isRegex: draft.isRegex,
      });
      setDraft(EMPTY_DRAFT);
      await reload();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (entry: LexiconEntry) => {
    try {
      await deleteUserEntry(entry.id);
      if (draft.id === entry.id) setDraft(EMPTY_DRAFT);
      await reload();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="tts-section" aria-labelledby="tts-lexicon-heading">
      <h2 id="tts-lexicon-heading">Pronunciation lexicon</h2>
      <p className="tts-hint">
        Rules rewrite tricky pharmacology notation before it is spoken. Built-in rules can be switched off but not edited;
        your own rules run first.
      </p>

      <div className="tts-field">
        <label htmlFor="tts-lexicon-search">Search rules</label>
        <input
          id="tts-lexicon-search"
          type="search"
          value={query}
          placeholder="CYP, half-life, mg/kg…"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <ul className="tts-lexicon-list" aria-busy={loading}>
        {visible.map((entry) => (
          <li key={entry.id} className={entry.enabled ? 'tts-rule' : 'tts-rule off'}>
            <label className="tts-rule-toggle">
              <input type="checkbox" checked={entry.enabled} onChange={() => void toggle(entry)} />
              <span className="tts-rule-pattern">
                {entry.pattern}
                <span className="tts-rule-arrow" aria-hidden="true">
                  {' → '}
                </span>
                {entry.replacement}
              </span>
            </label>
            <span className={entry.source === 'builtin' ? 'tts-badge' : 'tts-badge user'}>
              {entry.source === 'builtin' ? 'built-in' : 'yours'}
            </span>
            {entry.source === 'user' ? (
              <span className="tts-rule-actions">
                <button
                  type="button"
                  className="tts-link"
                  onClick={() =>
                    setDraft({ id: entry.id, pattern: entry.pattern, replacement: entry.replacement, isRegex: entry.isRegex })
                  }
                >
                  Edit
                </button>
                <button type="button" className="tts-link danger" onClick={() => void remove(entry)}>
                  Delete
                </button>
              </span>
            ) : null}
          </li>
        ))}
        {!loading && visible.length === 0 ? <li className="tts-hint">No rules match “{query}”.</li> : null}
      </ul>

      <div className="tts-field">
        <label htmlFor="tts-lexicon-preview">Preview</label>
        <input
          id="tts-lexicon-preview"
          type="text"
          value={previewText}
          placeholder="Type a sentence to hear how it will be spoken…"
          onChange={(e) => setPreviewText(e.target.value)}
        />
        <output className="tts-preview" htmlFor="tts-lexicon-preview" aria-live="polite">
          {previewResult || 'Nothing to preview yet.'}
        </output>
      </div>

      <fieldset className="tts-new-rule">
        <legend>{draft.id ? 'Edit your rule' : 'Add your own rule'}</legend>
        <div className="tts-field-row">
          <div className="tts-field">
            <label htmlFor="tts-rule-pattern">Find</label>
            <input
              id="tts-rule-pattern"
              type="text"
              value={draft.pattern}
              placeholder="\\bCYP3A4\\b"
              onChange={(e) => setDraft({ ...draft, pattern: e.target.value })}
            />
          </div>
          <div className="tts-field">
            <label htmlFor="tts-rule-replacement">Say instead</label>
            <input
              id="tts-rule-replacement"
              type="text"
              value={draft.replacement}
              placeholder="C Y P three A four"
              onChange={(e) => setDraft({ ...draft, replacement: e.target.value })}
            />
          </div>
        </div>
        <label className="tts-check">
          <input
            type="checkbox"
            checked={draft.isRegex}
            onChange={(e) => setDraft({ ...draft, isRegex: e.target.checked })}
          />
          Treat “Find” as a regular expression
        </label>
        <div className="tts-actions">
          <button type="button" className="tts-button" onClick={() => void save()}>
            {draft.id ? 'Save changes' : 'Add rule'}
          </button>
          {draft.id ? (
            <button type="button" className="tts-link" onClick={() => setDraft(EMPTY_DRAFT)}>
              Cancel
            </button>
          ) : null}
        </div>
      </fieldset>
    </section>
  );
}

export default function TtsSettings() {
  const engine = useSetting<string>(TTS_ENGINE_SETTING, 'auto');
  const voiceId = useSetting<string>(TTS_VOICE_SETTING, '');
  const rate = useSetting<number>(TTS_RATE_SETTING, 1);

  const [voices, setVoices] = useState<TtsVoice[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [cacheBytes, setCacheBytes] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      systemEngine.stop();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void systemEngine
      .listVoices()
      .then((list) => {
        if (alive) setVoices(list);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, []);

  const refreshCache = useCallback(async () => {
    try {
      setCacheBytes(await cacheSizeBytes());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refreshCache();
  }, [refreshCache]);

  const testVoice = async () => {
    if (testing) {
      systemEngine.stop();
      setTesting(false);
      setStatus(null);
      return;
    }
    setError(null);
    setTesting(true);
    setStatus('Speaking the test sentence…');
    try {
      const text = await expand(TEST_SENTENCE);
      await systemEngine.speak([{ id: 'test-voice', text }], { voiceId: voiceId || undefined, rate }, {
        onError: (err) => setError(err.message),
      });
      if (mounted.current) setStatus('Finished.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setTesting(false);
    }
  };

  const clearCache = async () => {
    setClearing(true);
    setError(null);
    try {
      await clearAudio();
      await refreshCache();
      setStatus('Cached audio cleared.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setClearing(false);
    }
  };

  const engineValue: EngineChoice = isEngineChoice(engine) ? engine : 'auto';

  return (
    <div className="tts-settings">
      <section className="tts-section" aria-labelledby="tts-engine-heading">
        <h2 id="tts-engine-heading">Voice and speed</h2>

        <div className="tts-field">
          <label htmlFor="tts-engine">Engine</label>
          <select
            id="tts-engine"
            value={engineValue}
            onChange={(e) => {
              void setSetting(TTS_ENGINE_SETTING, e.target.value);
              setStatus(null);
            }}
          >
            {ENGINE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <p className="tts-hint">On-device models are set up under Models. “Auto” falls back to system voices when nothing is ready.</p>
        </div>

        <div className="tts-field">
          <label htmlFor="tts-voice">System voice</label>
          <select
            id="tts-voice"
            value={voiceId}
            disabled={engineValue !== 'system' && engineValue !== 'auto'}
            onChange={(e) => void setSetting(TTS_VOICE_SETTING, e.target.value)}
          >
            <option value="">Device default</option>
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} ({v.lang})
              </option>
            ))}
          </select>
          {engineValue !== 'system' && engineValue !== 'auto' ? (
            <p className="tts-hint">This voice is used when the system engine speaks. The chosen model brings its own voices.</p>
          ) : null}
        </div>

        <div className="tts-field">
          <label htmlFor="tts-rate">
            Speed <span className="tts-value">{formatRate(rate)}×</span>
          </label>
          <input
            id="tts-rate"
            type="range"
            min={RATE_MIN}
            max={RATE_MAX}
            step={RATE_STEP}
            value={rate}
            onChange={(e) => void setSetting(TTS_RATE_SETTING, Number(e.target.value))}
          />
        </div>

        <div className="tts-actions">
          <button type="button" className="tts-button" onClick={() => void testVoice()}>
            {testing ? 'Stop test' : 'Test voice'}
          </button>
        </div>

        <p className="tts-tip">{VOICE_TIP}</p>
        <p className="tts-status" role="status">
          {status ?? ''}
        </p>
        {error ? (
          <p className="tts-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>

      <LexiconEditor onError={setError} />

      <section className="tts-section" aria-labelledby="tts-cache-heading">
        <h2 id="tts-cache-heading">Cached audio</h2>
        <p className="tts-hint">
          Sentences read by an on-device model are stored so re-reading them is instant. The cache never leaves this device.
        </p>
        <p className="tts-value" data-testid="tts-cache-size">
          {cacheBytes === null ? 'Measuring…' : formatBytes(cacheBytes)}
        </p>
        <div className="tts-actions">
          <button type="button" className="tts-button" disabled={clearing} onClick={() => void clearCache()}>
            {clearing ? 'Clearing…' : 'Clear cache'}
          </button>
        </div>
      </section>
    </div>
  );
}

function formatRate(rate: number): string {
  if (!Number.isFinite(rate)) return '1.0';
  return rate.toFixed(2).replace(/0$/, '');
}
