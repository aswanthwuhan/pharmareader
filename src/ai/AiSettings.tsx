import { useEffect, useState } from 'react';
import { setSetting, useSetting } from '../core/settings';
import { AI_DEFAULTS, AI_PRESETS, chat, type AiPresetId } from './client';
import './ai-settings.css';

/** BYO-key AI settings panel for the Settings page (the page owns the heading). */
export default function AiSettings() {
  const enabled = useSetting('ai.enabled', AI_DEFAULTS.enabled);
  const storedBaseUrl = useSetting('ai.baseUrl', AI_DEFAULTS.baseUrl);
  const storedApiKey = useSetting('ai.apiKey', AI_DEFAULTS.apiKey);
  const storedModel = useSetting('ai.model', AI_DEFAULTS.model);

  const [baseUrl, setBaseUrl] = useState(storedBaseUrl);
  const [apiKey, setApiKey] = useState(storedApiKey);
  const [model, setModel] = useState(storedModel);
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Keep the form in step with anything written elsewhere (import, other tab).
  useEffect(() => setBaseUrl(storedBaseUrl), [storedBaseUrl]);
  useEffect(() => setApiKey(storedApiKey), [storedApiKey]);
  useEffect(() => setModel(storedModel), [storedModel]);

  const derived: AiPresetId =
    AI_PRESETS.find((p) => p.id !== 'custom' && p.baseUrl === baseUrl.trim())?.id ?? 'custom';
  // The select must keep showing "Custom" after it is picked, even though the
  // URL still matches a preset until the user edits it.
  const [picked, setPicked] = useState<AiPresetId>(derived);
  useEffect(() => setPicked(derived), [derived]);

  async function persist() {
    await Promise.all([
      setSetting('ai.baseUrl', baseUrl.trim()),
      setSetting('ai.apiKey', apiKey.trim()),
      setSetting('ai.model', model.trim()),
    ]);
  }

  async function onPresetChange(id: string) {
    const next = AI_PRESETS.find((p) => p.id === id);
    if (!next) return;
    setPicked(next.id);
    if (next.id === 'custom') return; // keep the current URL, let the user type one
    setBaseUrl(next.baseUrl);
    setModel(next.model);
    await Promise.all([setSetting('ai.baseUrl', next.baseUrl), setSetting('ai.model', next.model)]);
  }

  async function test() {
    setTesting(true);
    setResult(null);
    try {
      await persist();
      const reply = await chat([{ role: 'user', content: 'Reply with exactly: OK' }], { timeoutMs: 15_000 });
      setResult({ ok: true, message: `OK — ${reply.slice(0, 60) || 'connected'}` });
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="ai-panel">
      <div className="banner banner-info">
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
          <path d="M12 3 5 6v5.5c0 4.4 3 8.2 7 9.5 4-1.3 7-5.1 7-9.5V6l-7-3Z" />
          <path d="M9.5 12.2 11 13.7l3.6-3.6" />
        </svg>
        <div className="banner-body">
          <p className="banner-title">Your key stays on this device</p>
          <p>Selected text is sent to the provider you choose. Your key is stored only on this device.</p>
        </div>
      </div>

      <label className="ai-enable">
        <input
          id="ai-enabled"
          type="checkbox"
          checked={enabled}
          onChange={(e) => void setSetting('ai.enabled', e.target.checked)}
        />
        <span className="ai-enable-text">
          <span className="ai-enable-label">Enable AI</span>
          <span className="field-hint ai-enable-hint">
            When off, no text leaves the app and the AI actions are hidden.
          </span>
        </span>
      </label>

      <div className="field">
        <label className="field-label" htmlFor="ai-preset">
          Provider
        </label>
        <select id="ai-preset" className="input" value={picked} onChange={(e) => void onPresetChange(e.target.value)}>
          {AI_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <p className="field-hint">Presets fill in a base URL and model. Choose Custom to point at another server.</p>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="ai-key">
          API key
        </label>
        <div className="ai-key-row">
          <input
            id="ai-key"
            className="input"
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-…"
            onChange={(e) => setApiKey(e.target.value)}
            onBlur={() => void persist()}
          />
          <button
            type="button"
            className="btn btn-secondary btn-icon"
            aria-label={showKey ? 'Hide API key' : 'Show API key'}
            aria-pressed={showKey}
            title={showKey ? 'Hide API key' : 'Show API key'}
            onClick={() => setShowKey((v) => !v)}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
              <circle cx="12" cy="12" r="2.6" />
              {showKey ? <path d="m4 4 16 16" /> : null}
            </svg>
          </button>
        </div>
        <p className="field-hint">Sent as a bearer token to the base URL below. Never written into a backup.</p>
      </div>

      <div className="ai-endpoints">
        <div className="field">
          <label className="field-label" htmlFor="ai-base-url">
            Base URL
          </label>
          <input
            id="ai-base-url"
            className="input"
            type="text"
            inputMode="url"
            value={baseUrl}
            spellCheck={false}
            placeholder="https://api.openai.com/v1"
            onChange={(e) => setBaseUrl(e.target.value)}
            onBlur={() => void persist()}
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="ai-model">
            Model
          </label>
          <input
            id="ai-model"
            className="input"
            type="text"
            value={model}
            spellCheck={false}
            placeholder="gpt-4.1-mini"
            onChange={(e) => setModel(e.target.value)}
            onBlur={() => void persist()}
          />
        </div>
      </div>

      <div className="ai-test-row">
        <button type="button" className="btn btn-secondary" onClick={() => void test()} disabled={testing}>
          {testing ? 'Testing…' : 'Test'}
        </button>
        <p className="field-hint ai-test-hint">Sends one tiny message to check the key and model.</p>
      </div>

      {result ? (
        <div className={result.ok ? 'banner banner-success' : 'banner banner-error'} role={result.ok ? 'status' : 'alert'}>
          <p>{result.message}</p>
        </div>
      ) : null}
    </div>
  );
}
