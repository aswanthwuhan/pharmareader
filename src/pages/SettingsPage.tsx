import TtsSettings from '../tts/TtsSettings';
import NeuralModelsPanel from '../tts/neural/NeuralModelsPanel';
import AiSettings from '../ai/AiSettings';
import BackupPanel from '../backup/BackupPanel';

export default function SettingsPage() {
  return (
    <section className="page">
      <h1>Settings</h1>
      <h2>Voice</h2>
      <TtsSettings />
      <h2>On-device voice models</h2>
      <NeuralModelsPanel />
      <h2>AI (optional)</h2>
      <AiSettings />
      <h2>Backup</h2>
      <BackupPanel />
      <h2>About</h2>
      <p>
        PharmaReader is free software under the GNU GPL-3.0. Everything runs on this device.
        Pocket TTS by Kyutai (model weights CC-BY-4.0). Kokoro-82M by hexgrad (Apache-2.0).
      </p>
    </section>
  );
}
