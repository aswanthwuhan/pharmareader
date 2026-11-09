import { useEffect, type ReactNode } from 'react';
import packageJson from '../../package.json';
import { CachePanel, LexiconPanel, VoicePanel } from '../tts/TtsSettings';
import NeuralModelsPanel from '../tts/neural/NeuralModelsPanel';
import AiSettings from '../ai/AiSettings';
import BackupPanel from '../backup/BackupPanel';
import './settings.css';

const REPO_URL = 'https://github.com/aswanthwuhan/pharmareader';

const SECTIONS = [
  { id: 'voice', label: 'Voice' },
  { id: 'voice-models', label: 'On-device models' },
  { id: 'pronunciation', label: 'Pronunciation' },
  { id: 'cached-audio', label: 'Cached audio' },
  { id: 'ai', label: 'AI' },
  { id: 'backup', label: 'Backup' },
  { id: 'about', label: 'About' },
] as const;

/** Scroll to the section named by the URL hash, for links like /settings#voice-models. */
export function scrollToHash(): void {
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return;
  let id = raw;
  try {
    id = decodeURIComponent(raw);
  } catch {
    id = raw;
  }
  const target = document.getElementById(id);
  if (target && typeof target.scrollIntoView === 'function') {
    target.scrollIntoView({ block: 'start' });
  }
}

interface SectionProps {
  id: string;
  title: string;
  sub?: string;
  children: ReactNode;
}

function Section({ id, title, sub, children }: SectionProps) {
  return (
    <section id={id} className="settings-section" aria-labelledby={`${id}-h2`}>
      <h2 id={`${id}-h2`} className="settings-h2">
        {title}
      </h2>
      {sub ? <p className="settings-sub">{sub}</p> : null}
      <div className="card">{children}</div>
    </section>
  );
}

export default function SettingsPage() {
  useEffect(() => {
    scrollToHash();
    window.addEventListener('hashchange', scrollToHash);
    return () => window.removeEventListener('hashchange', scrollToHash);
  }, []);

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
          <Section id="voice" title="Voice" sub="Choose how the app speaks, and how fast.">
            <VoicePanel />
          </Section>

          <section id="voice-models" className="settings-section" aria-labelledby="voice-models-h2">
            <h2 id="voice-models-h2" className="settings-h2">
              On-device voice models
            </h2>
            <NeuralModelsPanel />
          </section>

          <Section
            id="pronunciation"
            title="Pronunciation"
            sub="Rules that rewrite drug names, enzymes and units before they are spoken. Built-in rules can be switched off but not edited; your own rules run first."
          >
            <LexiconPanel />
          </Section>

          <Section id="cached-audio" title="Cached audio" sub="Speech already synthesised on this device.">
            <CachePanel />
          </Section>

          <Section
            id="ai"
            title="AI (bring your own key)"
            sub="Optional: summaries, explanations and practice questions from the provider you choose."
          >
            <AiSettings />
          </Section>

          <section id="backup" className="settings-section" aria-labelledby="backup-h2">
            <h2 id="backup-h2" className="settings-h2">
              Backup
            </h2>
            <p className="settings-sub">Take your library with you, or bring it back.</p>
            <BackupPanel />
          </section>

          <section id="about" className="settings-section" aria-labelledby="about-h2">
            <h2 id="about-h2" className="settings-h2">
              About
            </h2>
            <div className="card about-card">
              <dl className="about-facts">
                <div>
                  <dt>Version</dt>
                  <dd className="tnum">{packageJson.version}</dd>
                </div>
                <div>
                  <dt>License</dt>
                  <dd>GNU GPL-3.0</dd>
                </div>
              </dl>

              <p className="card-body about-copy">
                PharmaReader is free software under the GNU General Public License v3.0. Everything runs on this device:
                no account, no server, and no text leaves the app unless you turn AI on.
              </p>

              <h3 className="about-h3">Credits</h3>
              <ul className="about-credits">
                <li>
                  <span className="about-credit-name">Pocket TTS</span> — Kyutai, model weights CC-BY-4.0
                </li>
                <li>
                  <span className="about-credit-name">Kokoro-82M</span> — hexgrad, Apache-2.0
                </li>
                <li>
                  <span className="about-credit-name">sherpa-onnx</span> — Apache-2.0, with espeak-ng under GPL-3.0
                </li>
                <li>
                  <span className="about-credit-name">Literata</span> — SIL Open Font License 1.1
                </li>
              </ul>

              <div className="about-links">
                <a className="btn btn-secondary" href={REPO_URL} target="_blank" rel="noopener noreferrer">
                  View source on GitHub
                </a>
                <a className="btn btn-ghost" href={`${REPO_URL}/issues/new`} target="_blank" rel="noopener noreferrer">
                  Report an issue
                </a>
              </div>
            </div>
          </section>
        </div>

        <nav className="settings-toc" aria-label="Settings sections">
          <p className="settings-toc-title">On this page</p>
          <ul>
            {SECTIONS.map((section) => (
              <li key={section.id}>
                <a href={`#${section.id}`}>{section.label}</a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </section>
  );
}
