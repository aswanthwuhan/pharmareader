import { useEffect, useState, type ReactNode } from 'react';
import { CachePanel, LexiconPanel, VoicePanel, TTS_ENGINE_SETTING, TTS_RATE_SETTING } from '../tts/TtsSettings';
import NeuralModelsPanel from '../tts/neural/NeuralModelsPanel';
import AlignModelPanel from '../tts/align/AlignModelPanel';
import ReadingOptions from '../reader/ReadingOptions';
import { DEFAULT_PAUSE_MS, PAUSE_KEY } from '../reader/reading';
import LayoutModelPanel from '../import/LayoutModelPanel';
import AiSettings from '../ai/AiSettings';
import { AI_DEFAULTS } from '../ai/client';
import BackupPanel from '../backup/BackupPanel';
import { LAST_EXPORT_SETTING, lastBackupLabel } from '../backup/backup';
import StoragePanel from '../core/StoragePanel';
import { setSetting, useSetting } from '../core/settings';
import { pushBackHandler } from '../core/backButton';
import { APP_VERSION } from '../core/version';
import { UPDATE_CHECK_KEY } from '../core/updateCheck';
import Disclosure from '../components/Disclosure';
import WhatsNew from '../components/WhatsNew';
import './settings.css';

const REPO_URL = 'https://github.com/aswanthwuhan/pharmareader';

const SECTIONS = [
  { id: 'voice', label: 'Voice' },
  { id: 'reading', label: 'Reading aloud' },
  { id: 'voice-models', label: 'On-device models' },
  { id: 'pdf-layout', label: 'PDF layout' },
  { id: 'pronunciation', label: 'Pronunciation' },
  { id: 'cached-audio', label: 'Cached audio' },
  { id: 'storage', label: 'Storage' },
  { id: 'ai', label: 'AI' },
  { id: 'backup', label: 'Backup' },
  { id: 'about', label: 'About' },
] as const;

/** Row ids that a deep link may open; anything else in the hash is ignored. */
const ROW_IDS: string[] = SECTIONS.map((section) => section.id);

/** Engine ids as saved in `tts.engine`, in the same words the panel shows. */
const ENGINE_NAMES: Record<string, string> = {
  auto: 'Auto',
  system: 'System',
  pocket: 'Pocket TTS',
  kokoro: 'Kokoro',
};

/** The part of the URL hash that names an element, decoded. */
function hashId(): string {
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Scroll to the section named by the URL hash, for links like /settings#voice-models. */
export function scrollToHash(): void {
  const id = hashId();
  if (!id) return;
  const target = document.getElementById(id);
  if (target && typeof target.scrollIntoView === 'function') {
    target.scrollIntoView({ block: 'start' });
  }
}

/** The pause between paragraphs, in the words the Reading panel uses. */
function pauseSummary(ms: number): string {
  if (ms <= 0) return 'No pause between paragraphs';
  return `Pause ${(ms / 1000).toFixed(2).replace(/0$/, '')} s`;
}

interface RowGroupProps {
  label: string;
  id: string;
  children: ReactNode;
}

/** A quiet label above one card of rows. Not a heading: the rows carry those. */
function RowGroup({ label, id, children }: RowGroupProps) {
  const labelId = `settings-group-${id}`;
  return (
    <div className="settings-group">
      <p className="settings-group-label" id={labelId}>
        {label}
      </p>
      <div className="card settings-group-card" role="group" aria-labelledby={labelId}>
        {children}
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const [openId, setOpenId] = useState<string | null>(null);
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);

  const engine = useSetting<string>(TTS_ENGINE_SETTING, 'auto');
  const rate = useSetting<number>(TTS_RATE_SETTING, 1);
  const pauseMs = useSetting<number>(PAUSE_KEY, DEFAULT_PAUSE_MS);
  const aiEnabled = useSetting<boolean>('ai.enabled', AI_DEFAULTS.enabled);
  const lastBackup = useSetting<number>(LAST_EXPORT_SETTING, 0);
  const updateCheck = useSetting<boolean>(UPDATE_CHECK_KEY, false);

  const voiceSummary = `${ENGINE_NAMES[engine] ?? engine} · ${rate.toFixed(1)}×`;

  /** Opening a row closes the previous one; clicking the open row closes it. */
  const toggle = (id: string) => {
    setOpenId((current) => (current === id ? null : id));
  };

  const openRow = (id: string) => setOpenId(id);

  // Deep links: /settings#backup arrives on mount, and later hash changes
  // (the section list) open their row and scroll to it.
  useEffect(() => {
    const openFromHash = () => {
      const id = hashId();
      if (ROW_IDS.includes(id)) setOpenId(id);
      scrollToHash();
    };
    openFromHash();
    window.addEventListener('hashchange', openFromHash);
    return () => window.removeEventListener('hashchange', openFromHash);
  }, []);

  // The header stays visible when a tall row opens under it.
  useEffect(() => {
    if (!openId) return;
    const target = document.getElementById(openId);
    if (target && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'start' });
    }
  }, [openId]);

  // Android back closes the open row before it leaves the page.
  useEffect(() => {
    if (!openId) return;
    return pushBackHandler(() => {
      setOpenId(null);
      return true;
    });
  }, [openId]);

  return (
    <section className="page settings-page">
      <header className="app-bar">
        <div>
          <h1>Settings</h1>
          <p className="app-bar-sub">Voice, models, AI and backups — all stored on this device</p>
        </div>
      </header>

      <div className="settings-layout">
        <div className="settings-main">
          <RowGroup label="Listening" id="listening">
            <Disclosure
              id="voice"
              title="Voice"
              summary={voiceSummary}
              open={openId === 'voice'}
              onToggle={() => toggle('voice')}
            >
              <p className="settings-sub">Choose how the app speaks, and how fast.</p>
              <VoicePanel />
            </Disclosure>

            <Disclosure
              id="reading"
              title="Reading aloud"
              summary={pauseSummary(pauseMs)}
              open={openId === 'reading'}
              onToggle={() => toggle('reading')}
            >
              <ReadingOptions />
            </Disclosure>
          </RowGroup>

          <RowGroup label="Models" id="models">
            <Disclosure
              id="voice-models"
              title="On-device voice models"
              open={openId === 'voice-models'}
              onToggle={() => toggle('voice-models')}
            >
              <NeuralModelsPanel />
              <AlignModelPanel />
            </Disclosure>

            <Disclosure
              id="pdf-layout"
              title="PDF layout"
              open={openId === 'pdf-layout'}
              onToggle={() => toggle('pdf-layout')}
            >
              <LayoutModelPanel />
            </Disclosure>
          </RowGroup>

          <RowGroup label="Speech details" id="speech">
            <Disclosure
              id="pronunciation"
              title="Pronunciation"
              open={openId === 'pronunciation'}
              onToggle={() => toggle('pronunciation')}
            >
              <p className="settings-sub">
                Rules that rewrite drug names, enzymes and units before they are spoken. Built-in rules can be
                switched off but not edited; your own rules run first.
              </p>
              <LexiconPanel />
            </Disclosure>

            <Disclosure
              id="cached-audio"
              title="Cached audio"
              open={openId === 'cached-audio'}
              onToggle={() => toggle('cached-audio')}
            >
              <p className="settings-sub">Speech already synthesised on this device.</p>
              <CachePanel />
            </Disclosure>
          </RowGroup>

          <RowGroup label="Your data" id="data">
            <Disclosure
              id="storage"
              title="Storage"
              open={openId === 'storage'}
              onToggle={() => toggle('storage')}
            >
              <StoragePanel />
            </Disclosure>

            <Disclosure
              id="ai"
              title="AI (bring your own key)"
              summary={aiEnabled ? 'On' : 'Off'}
              open={openId === 'ai'}
              onToggle={() => toggle('ai')}
            >
              <p className="settings-sub">
                Optional: summaries, explanations and practice questions from the provider you choose.
              </p>
              <AiSettings />
            </Disclosure>

            <Disclosure
              id="backup"
              title="Backup"
              summary={lastBackupLabel(lastBackup)}
              open={openId === 'backup'}
              onToggle={() => toggle('backup')}
            >
              <p className="settings-sub">Take your library with you, or bring it back.</p>
              <BackupPanel />
            </Disclosure>
          </RowGroup>

          <RowGroup label="About this app" id="about-group">
            <Disclosure
              id="about"
              title="About"
              summary={`v${APP_VERSION} · GPL-3.0`}
              open={openId === 'about'}
              onToggle={() => toggle('about')}
            >
              <div className="about-card">
                <dl className="about-facts">
                  <div>
                    <dt>Version</dt>
                    <dd className="tnum">{APP_VERSION}</dd>
                  </div>
                  <div>
                    <dt>License</dt>
                    <dd>GNU GPL-3.0</dd>
                  </div>
                </dl>

                <p className="card-body about-copy">
                  PharmaReader is free software under the GNU General Public License v3.0. Everything runs on this
                  device: no account, no server, and no text leaves the app unless you turn AI on or ask it to check
                  for new versions.
                </p>

                <label className="update-optin">
                  <input
                    id="update-check"
                    type="checkbox"
                    checked={updateCheck}
                    onChange={(event) => void setSetting(UPDATE_CHECK_KEY, event.target.checked)}
                  />
                  <span className="update-optin-text">
                    <span className="update-optin-label">Check for new versions when the app opens</span>
                    <span className="field-hint">
                      Asks GitHub (api.github.com) for the latest PharmaReader release once a day. Nothing else is
                      sent.
                    </span>
                  </span>
                </label>

                <div className="about-links">
                  <button type="button" className="btn btn-secondary" onClick={() => setWhatsNewOpen(true)}>
                    What’s new in v{APP_VERSION}
                  </button>
                  <a className="btn btn-secondary" href={REPO_URL} target="_blank" rel="noopener noreferrer">
                    View source on GitHub
                  </a>
                  <a
                    className="btn btn-ghost"
                    href={`${REPO_URL}/issues/new`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Report an issue
                  </a>
                </div>

                <details className="disc-sub">
                  <summary>Credits and licences</summary>
                  <div className="disc-sub-body">
                    <ul className="about-credits">
                      <li>
                        <span className="about-credit-name">Pocket TTS</span> — Kyutai, model weights CC-BY-4.0
                      </li>
                      <li>
                        <span className="about-credit-name">Kokoro-82M</span> — hexgrad, Apache-2.0
                      </li>
                      <li>
                        <span className="about-credit-name">sherpa-onnx</span> — Apache-2.0, with espeak-ng under
                        GPL-3.0
                      </li>
                      <li>
                        <span className="about-credit-name">Literata</span> — SIL Open Font License 1.1
                      </li>
                    </ul>
                  </div>
                </details>
              </div>
            </Disclosure>
          </RowGroup>
        </div>

        <nav className="settings-toc" aria-label="Settings sections">
          <p className="settings-toc-title">On this page</p>
          <ul>
            {SECTIONS.map((section) => (
              <li key={section.id}>
                <a href={`#${section.id}`} onClick={() => openRow(section.id)}>
                  {section.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>

      {/* The same sheet App opens on an upgrade, reachable any time from About. */}
      {whatsNewOpen ? <WhatsNew version={APP_VERSION} onClose={() => setWhatsNewOpen(false)} /> : null}
    </section>
  );
}
