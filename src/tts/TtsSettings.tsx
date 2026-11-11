import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

type EngineChoice = 'auto' | 'system' | 'pocket' | 'kokoro';

const ENGINE_OPTIONS: { value: EngineChoice; label: string; hint: string }[] = [
  {
    value: 'auto',
    label: 'Auto (best available)',
    hint: 'Uses a downloaded on-device model when one is ready, and your system voice otherwise. Nothing else to set up.',
  },
  {
    value: 'system',
    label: 'System voices (free, offline)',
    hint: 'The voices your phone already has. No download, works offline, and follows the device speed.',
  },
  {
    value: 'pocket',
    label: 'Pocket TTS (on-device model)',
    hint: 'A 148 MB model that runs on this device. Speed is limited to 0.80×–1.25× because it works by resampling.',
  },
  {
    value: 'kokoro',
    label: 'Kokoro (on-device model)',
    hint: 'Kokoro-82M, 320 MB download. Faster than real-time on most phones.',
  },
];

const RATE_MIN = 0.5;
const RATE_MAX = 2;
const RATE_STEP = 0.05;
const INITIAL_RULES = 8;

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

export function engineHint(value: string): string {
  return (ENGINE_OPTIONS.find((o) => o.value === value) ?? ENGINE_OPTIONS[0]).hint;
}

function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="banner banner-error" role="alert">
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        aria-hidden="true"
        focusable="false"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7.5v5.5M12 16.5h.01" />
      </svg>
      <p>{message}</p>
    </div>
  );
}

/** Engine, system voice, speed and the test sentence. */
export function VoicePanel() {
  const engine = useSetting<string>(TTS_ENGINE_SETTING, 'auto');
  const voiceId = useSetting<string>(TTS_VOICE_SETTING, '');
  const rate = useSetting<number>(TTS_RATE_SETTING, 1);

  const [voices, setVoices] = useState<TtsVoice[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
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

  const engineValue: EngineChoice = isEngineChoice(engine) ? engine : 'auto';
  const systemVoiceActive = engineValue === 'system' || engineValue === 'auto';
  const voiceHint = systemVoiceActive
    ? voices.length > 0
      ? `${voices.length} system ${voices.length === 1 ? 'voice' : 'voices'} reported by this device.`
      : 'Voices are provided by the device; none were reported yet.'
    : 'Used when the system engine speaks. The on-device model brings its own voices.';

  return (
    <div className="tts-panel">
      <div className="field">
        <label className="field-label" htmlFor="tts-engine">
          Engine
        </label>
        <select
          id="tts-engine"
          className="input"
          value={engineValue}
          aria-describedby="tts-engine-hint"
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
        <p className="field-hint" id="tts-engine-hint">
          {engineHint(engineValue)}{' '}
          <a href="#voice-models">Manage on-device models</a>.
        </p>
      </div>

      <div className="tts-field-grid">
        <div className="field">
          <label className="field-label" htmlFor="tts-voice">
            System voice
          </label>
          <select
            id="tts-voice"
            className="input"
            value={voiceId}
            disabled={!systemVoiceActive}
            aria-describedby="tts-voice-hint"
            onChange={(e) => void setSetting(TTS_VOICE_SETTING, e.target.value)}
          >
            <option value="">Device default</option>
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} ({v.lang})
              </option>
            ))}
          </select>
          <p className="field-hint" id="tts-voice-hint">
            {voiceHint}
          </p>
        </div>

        <div className="field">
          <div className="tts-label-row">
            <label className="field-label" htmlFor="tts-rate">
              Speed
            </label>
            <span className="tts-rate-value tnum" aria-hidden="true">
              {formatRate(rate)}×
            </span>
          </div>
          <input
            id="tts-rate"
            className="tts-range"
            type="range"
            min={RATE_MIN}
            max={RATE_MAX}
            step={RATE_STEP}
            value={rate}
            aria-valuetext={`${formatRate(rate)} times`}
            onChange={(e) => void setSetting(TTS_RATE_SETTING, Number(e.target.value))}
          />
          <p className="field-hint">
            {RATE_MIN}×–{RATE_MAX}×, applied to every engine.
          </p>
        </div>
      </div>

      <div className="tts-test-row">
        <button
          type="button"
          className={testing ? 'btn btn-secondary' : 'btn btn-primary'}
          onClick={() => void testVoice()}
        >
          {testing ? 'Stop test' : 'Test voice'}
        </button>
        <p className="tts-status" role="status">
          {status ?? ''}
        </p>
      </div>
      <p className="field-hint tts-test-sentence">Speaks: “{TEST_SENTENCE}”</p>

      <details className="disc-sub">
        <summary>How this works</summary>
        <div className="disc-sub-body">
          <div className="tts-notes">
            <dl className="tts-note-list">
              {ENGINE_OPTIONS.map((o) => (
                <div key={o.value}>
                  <dt>{o.label}</dt>
                  <dd>{engineHint(o.value)}</dd>
                </div>
              ))}
            </dl>
            <div className="tts-note-block">
              <p className="tts-note-title">A more natural system voice</p>
              <p className="tts-note">{VOICE_TIP}</p>
            </div>
          </div>
        </div>
      </details>

      <ErrorBanner message={error} />
    </div>
  );
}

/** Search, toggle, add and edit the pronunciation rules. */
export function LexiconPanel() {
  const [entries, setEntries] = useState<LexiconEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [adding, setAdding] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState('');
  const [previewResult, setPreviewResult] = useState('');
  const builtinRef = useRef<HTMLDetailsElement>(null);

  const reload = useCallback(async () => {
    try {
      setEntries(await listLexiconEntries());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

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

  // One search covers both lists, as it always did: the reader's own rules
  // first (they are the ones being curated), then the built-in rules, which sit
  // inside their disclosure and render only their first few matches until the
  // reader asks for all of them.
  const visible = useMemo(() => {
    const rows = [...filterEntries(entries, query)];
    return rows.sort((a, b) => Number(b.source === 'user') - Number(a.source === 'user'));
  }, [entries, query]);
  const ownVisible = useMemo(() => visible.filter((e) => e.source === 'user'), [visible]);
  const builtinVisible = useMemo(() => visible.filter((e) => e.source !== 'user'), [visible]);
  const builtinTotal = useMemo(() => entries.filter((e) => e.source !== 'user').length, [entries]);
  const builtinShown = showAll ? builtinVisible : builtinVisible.slice(0, INITIAL_RULES);
  const hiddenCount = builtinVisible.length - builtinShown.length;
  // A search that finds a built-in rule has to show it, so the disclosure is
  // held open while the query matches something in it.
  const forcedOpen = query.trim().length > 0 && builtinVisible.length > 0;

  // Opening the disclosure is what makes the matches visible; the toggle guard
  // below keeps it open for as long as the query still matches something.
  useEffect(() => {
    const el = builtinRef.current;
    if (el && forcedOpen && !el.open) el.open = true;
  }, [forcedOpen, builtinVisible.length]);

  const closeEditor = () => {
    setDraft(EMPTY_DRAFT);
    setAdding(false);
  };

  const startEdit = (entry: LexiconEntry) => {
    setAdding(false);
    setDraft({ id: entry.id, pattern: entry.pattern, replacement: entry.replacement, isRegex: entry.isRegex });
  };

  const toggle = async (entry: LexiconEntry) => {
    try {
      await setEntryEnabled(entry.id, !entry.enabled);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const save = async () => {
    if (!draft.pattern.trim()) {
      setError('A pattern is required.');
      return;
    }
    try {
      await saveUserEntry({
        id: draft.id,
        pattern: draft.pattern,
        replacement: draft.replacement,
        isRegex: draft.isRegex,
      });
      closeEditor();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (entry: LexiconEntry) => {
    try {
      await deleteUserEntry(entry.id);
      if (draft.id === entry.id) closeEditor();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const editor = (
    <fieldset className="tts-editor">
      <legend>{draft.id ? 'Edit rule' : 'New rule'}</legend>
      <div className="tts-editor-grid">
        <div className="field">
          <label className="field-label" htmlFor="tts-rule-pattern">
            Find
          </label>
          <input
            id="tts-rule-pattern"
            className="input"
            type="text"
            value={draft.pattern}
            placeholder="\bCYP3A4\b"
            onChange={(e) => setDraft({ ...draft, pattern: e.target.value })}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="tts-rule-replacement">
            Say instead
          </label>
          <input
            id="tts-rule-replacement"
            className="input"
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
      <div className="tts-editor-actions">
        <button type="button" className="btn btn-primary" onClick={() => void save()}>
          {draft.id ? 'Save changes' : 'Add rule'}
        </button>
        <button type="button" className="btn btn-secondary" onClick={closeEditor}>
          Cancel
        </button>
      </div>
    </fieldset>
  );

  const editingVisible = draft.id !== undefined && visible.some((e) => e.id === draft.id);

  const ruleRow = (entry: LexiconEntry) => (
    <Fragment key={entry.id}>
      <li className={entry.enabled ? 'tts-rule' : 'tts-rule is-off'}>
        <label className="tts-rule-toggle">
          <input
            type="checkbox"
            checked={entry.enabled}
            aria-label={`${entry.enabled ? 'Disable' : 'Enable'} rule ${entry.pattern}`}
            onChange={() => void toggle(entry)}
          />
          <span className="tts-rule-text">
            <span className="tts-rule-pattern" title={entry.pattern}>
              {entry.pattern}
            </span>
            <span className="tts-rule-replacement" title={entry.replacement}>
              {entry.replacement || '—'}
            </span>
          </span>
        </label>
        <span className="tts-rule-meta">
          {entry.source === 'user' ? <span className="badge badge-accent">yours</span> : null}
          {entry.source === 'user' ? (
            <span className="tts-rule-actions">
              <button
                type="button"
                className="tts-rule-action"
                aria-label={`Edit rule ${entry.pattern}`}
                onClick={() => startEdit(entry)}
              >
                Edit
              </button>
              <button
                type="button"
                className="tts-rule-action danger"
                aria-label={`Delete rule ${entry.pattern}`}
                onClick={() => void remove(entry)}
              >
                Delete
              </button>
            </span>
          ) : null}
        </span>
      </li>
      {draft.id === entry.id ? <li className="tts-editor-row">{editor}</li> : null}
    </Fragment>
  );

  return (
    <div className="tts-panel">
      <div className="field">
        <label className="field-label" htmlFor="tts-lexicon-search">
          Search rules
        </label>
        <input
          id="tts-lexicon-search"
          className="input"
          type="search"
          value={query}
          placeholder="CYP, half-life, mg/kg…"
          onChange={(e) => {
            setQuery(e.target.value);
            setShowAll(false);
          }}
        />
        <p className="field-hint tts-lexicon-count" aria-live="polite">
          {loading
            ? 'Loading rules…'
            : query.trim()
              ? `Showing ${visible.length} of ${entries.length} rules`
              : `${entries.length} of ${entries.length} rules`}
        </p>
      </div>

      {!loading && query.trim() && visible.length === 0 ? (
        <ul className="tts-rules">
          <li className="tts-empty">No rules match “{query}”.</li>
        </ul>
      ) : null}

      {!loading && (ownVisible.length > 0 || !query.trim()) ? (
        <ul className="tts-rules tts-rules-own">
          {ownVisible.map(ruleRow)}
          {ownVisible.length === 0 ? <li className="tts-empty">No rules of your own yet.</li> : null}
        </ul>
      ) : null}

      {adding ? (
        <div className="tts-editor-row">{editor}</div>
      ) : draft.id === undefined ? (
        <div className="tts-add">
          <button type="button" className="btn btn-secondary" onClick={() => setAdding(true)}>
            Add a rule
          </button>
        </div>
      ) : null}

      {draft.id !== undefined && !editingVisible ? <div className="tts-editor-row">{editor}</div> : null}

      <details
        className="disc-sub"
        ref={builtinRef}
        onToggle={(event) => {
          // While a search matches built-in rules the list stays open, so its
          // results cannot end up hidden behind a closed disclosure.
          if (forcedOpen && !event.currentTarget.open) event.currentTarget.open = true;
        }}
      >
        <summary>Built-in rules ({builtinTotal})</summary>
        <div className="disc-sub-body">
          <ul className="tts-rules tts-rules-builtin" aria-busy={loading}>
            {builtinShown.map(ruleRow)}
            {!loading && !query.trim() && builtinVisible.length === 0 ? (
              <li className="tts-empty">No built-in rules yet.</li>
            ) : null}
          </ul>

          {/* Pagination inside the disclosure: the first few matches stay in the
              DOM, the rest wait for "Show all". */}
          {hiddenCount > 0 ? (
            <div className="tts-add">
              <button type="button" className="btn btn-secondary" onClick={() => setShowAll(true)}>
                Show all {builtinVisible.length} rules
              </button>
            </div>
          ) : showAll && builtinVisible.length > INITIAL_RULES ? (
            <div className="tts-add">
              <button type="button" className="btn btn-ghost" onClick={() => setShowAll(false)}>
                Show fewer
              </button>
            </div>
          ) : null}
        </div>
      </details>

      <details className="disc-sub">
        <summary>Advanced</summary>
        <div className="disc-sub-body">
          <div className="field">
            <label className="field-label" htmlFor="tts-lexicon-preview">
              Preview
            </label>
            <input
              id="tts-lexicon-preview"
              className="input"
              type="text"
              value={previewText}
              placeholder="CYP3A4 inhibitors at 5 mg/kg…"
              onChange={(e) => setPreviewText(e.target.value)}
            />
            <output className="tts-preview" htmlFor="tts-lexicon-preview" aria-live="polite">
              {previewResult || 'Type a phrase to see the spoken form.'}
            </output>
          </div>
        </div>
      </details>

      <ErrorBanner message={error} />
    </div>
  );
}

/** Audio cache size and the button that empties it. */
export function CachePanel() {
  const [cacheBytes, setCacheBytes] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="tts-panel">
      <div className="tts-cache-row">
        <p className="tts-cache-size tnum" data-testid="tts-cache-size">
          {cacheBytes === null ? 'Measuring…' : formatBytes(cacheBytes)}
        </p>
        <button type="button" className="btn btn-secondary" disabled={clearing} onClick={() => void clearCache()}>
          {clearing ? 'Clearing…' : 'Clear cache'}
        </button>
      </div>
      <p className="tts-status" role="status">
        {status ?? ''}
      </p>

      <details className="disc-sub">
        <summary>How this works</summary>
        <div className="disc-sub-body">
          <div className="tts-notes">
            <p className="tts-note">
              Sentences already read by an on-device model. Stored on this device; removing them only costs a moment to
              rebuild.
            </p>
          </div>
        </div>
      </details>

      <ErrorBanner message={error} />
    </div>
  );
}

/**
 * All three voice panels in one stack, without page headings — the Settings page
 * places each panel under its own section heading.
 */
export default function TtsSettings() {
  return (
    <div className="tts-settings">
      <VoicePanel />
      <LexiconPanel />
      <CachePanel />
    </div>
  );
}

function formatRate(rate: number): string {
  if (!Number.isFinite(rate)) return '1.0';
  return rate.toFixed(2).replace(/0$/, '');
}
