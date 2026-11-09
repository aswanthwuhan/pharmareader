import TtsSettings from '../tts/TtsSettings';
import NeuralModelsPanel from '../tts/neural/NeuralModelsPanel';
import AiSettings from '../ai/AiSettings';
import BackupPanel from '../backup/BackupPanel';

export default function SettingsPage() {
  return (
    <section className="page">
      <h1>Settings</h1>
      <TtsSettings />
      <h2>On-device voice models</h2>
      <NeuralModelsPanel />
      <AiSettings />
      <BackupPanel />
      <h2>About</h2>
      <p>
        PharmaReader is free software under the GNU GPL-3.0. Everything runs on this device.
        Pocket TTS by Kyutai (model weights CC-BY-4.0). Kokoro-82M by hexgrad (Apache-2.0).
      </p>
    </section>
  );
}
