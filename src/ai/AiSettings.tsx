import { useEffect, useState } from 'react';
import { setSetting, useSetting } from '../core/settings';
import { AI_DEFAULTS, AI_PRESETS, chat } from './client';
import './ai.css';

/** BYO-key AI settings section for the Settings page. */
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

  const preset = AI_PRESETS.find((p) => p.id !== 'custom' && p.baseUrl === baseUrl.trim())?.id ?? 'custom';

  async function persist() {
    await Promise.all([
      setSetting('ai.baseUrl', baseUrl.trim()),
      setSetting('ai.apiKey', apiKey.trim()),
      setSetting('ai.model', model.trim()),
    ]);
  }

  async function onPresetChange(id: string) {
    const next = AI_PRESETS.find((p) => p.id === id);
    if (!next || next.id === 'custom') return;
    setBaseUrl(next.baseUrl);
    setModel(next.model);
    await Promise.all([setSetting('ai.baseUrl', next.baseUrl), setSetting('ai.model', next.model)]);
  }

  async function test() {
    setTesting(true);
    setResult(null);
    try {
      await persist();
      const reply = await chat([{ role: 'user', content: 'Reply with exactly: OK' }]);
      setResult({ ok: true, message: `OK — ${reply.slice(0, 60) || 'connected'}` });
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  }

  return (
    <section className="ai-section" aria-labelledby="ai-settings-heading">
      <h2 id="ai-settings-heading">AI (bring your own key)</h2>

      <div className="ai-check">
        <input
          id="ai-enabled"
          type="checkbox"
          checked={enabled}
          onChange={(e) => void setSetting('ai.enabled', e.target.checked)}
        />
        <label htmlFor="ai-enabled">
          Enable AI
          <span className="ai-notice">
            Selected text is sent to the provider you choose. Your key is stored only on this device.
          </span>
        </label>
      </div>

      <div className="ai-row">
        <label htmlFor="ai-preset">Provider</label>
        <select id="ai-preset" value={preset} onChange={(e) => void onPresetChange(e.target.value)}>
          {AI_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      <div className="ai-row">
        <label htmlFor="ai-key">API key</label>
        <div className="ai-key-row">
          <input
            id="ai-key"
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-…"
            onChange={(e) => setApiKey(e.target.value)}
            onBlur={() => void persist()}
          />
          <button type="button" className="ai-btn" onClick={() => setShowKey((v) => !v)} aria-pressed={showKey}>
            {showKey ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>

      <div className="ai-row">
        <label htmlFor="ai-base-url">Base URL</label>
        <input
          id="ai-base-url"
          type="text"
          inputMode="url"
          value={baseUrl}
          spellCheck={false}
          placeholder="https://api.openai.com/v1"
          onChange={(e) => setBaseUrl(e.target.value)}
          onBlur={() => void persist()}
        />
      </div>

      <div className="ai-row">
        <label htmlFor="ai-model">Model</label>
        <input
          id="ai-model"
          type="text"
          value={model}
          spellCheck={false}
          placeholder="gpt-4.1-mini"
          onChange={(e) => setModel(e.target.value)}
          onBlur={() => void persist()}
        />
      </div>

      <div className="ai-actions-row">
        <button type="button" className="ai-btn" onClick={() => void test()} disabled={testing}>
          {testing ? 'Testing…' : 'Test'}
        </button>
        <span className="ai-notice">Sends one tiny message to check the key and model.</span>
      </div>

      {result && (
        <p className={result.ok ? 'ai-ok' : 'ai-error'} role="status">
          {result.message}
        </p>
      )}
    </section>
  );
}
