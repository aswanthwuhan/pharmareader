package com.aurapharmlab.pharmareader.kokoro;

import android.content.res.AssetManager;
import android.os.SystemClock;
import android.util.Log;

import com.k2fsa.sherpa.onnx.GeneratedAudio;
import com.k2fsa.sherpa.onnx.OfflineTts;
import com.k2fsa.sherpa.onnx.OfflineTtsConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsKokoroModelConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Locale;

import kotlin.jvm.functions.Function1;

/**
 * Owns the single {@link OfflineTts} instance and turns text into WAV files.
 *
 * <p>sherpa-onnx's Kokoro model is a 310&nbsp;MiB ONNX graph; constructing the runtime and
 * running inference are both CPU-bound and multi-second, so this class is a lazy
 * singleton that the plugin only touches from its background executor. Loading, generating
 * and releasing are all {@code synchronized}: one sentence at a time, never two ONNX
 * sessions fighting for the same four threads, and never a release racing a generation.
 *
 * <p>The read-only accessors ({@link #isLoaded()}, {@link #threads()},
 * {@link #sampleRate()}, {@link #voiceCount()}) read {@code volatile} fields instead of
 * entering the monitor, so the plugin's {@code status()} call answers immediately even
 * while a ten-second sentence is being generated.
 *
 * <p>The frontend is configured exactly as the sherpa-onnx 1.13.x docs prescribe for
 * {@code kokoro-multi-lang-v1_0}: the English lexicon drives pronunciation and
 * {@code espeak-ng-data} is the fallback for every word the lexicon does not contain
 * (drug names, brand names, newly coined terms).
 */
public final class KokoroTtsEngine {

    private static final String TAG = "KokoroTts";
    private static final int MAX_CACHED_WAVS = 8;
    private static final int DEFAULT_SAMPLE_RATE = 24000;

    /** Cooperative cancellation for a generation already running inside sherpa-onnx. */
    public interface StopSignal {
        boolean isStopped();
    }

    /** One synthesized sentence. */
    public static final class SynthResult {
        public String path;
        public byte[] wav;
        public long durationMs;
        public int sampleRate;
        public int sampleCount;
        public long elapsedMs;
        public double rtf;
        /** True when {@link StopSignal} cut the generation short; no WAV was written. */
        public boolean cancelled;
    }

    private static KokoroTtsEngine instance;

    private volatile OfflineTts tts;
    private volatile int threads;
    private volatile int sampleRate = DEFAULT_SAMPLE_RATE;
    private volatile int voiceCount;
    private volatile String modelDirPath;
    private int sequence;

    private KokoroTtsEngine() {}

    public static synchronized KokoroTtsEngine getInstance() {
        if (instance == null) {
            instance = new KokoroTtsEngine();
        }
        return instance;
    }

    public boolean isLoaded() {
        return tts != null;
    }

    public int threads() {
        return threads;
    }

    public int sampleRate() {
        return sampleRate;
    }

    public int voiceCount() {
        return voiceCount;
    }

    /**
     * Build the ONNX session. Re-loads only when the model directory or the thread count
     * actually changed, because loading costs several seconds and a few hundred MiB.
     */
    public synchronized void load(File modelDir, int threads, boolean debug)
            throws IOException {
        String path = modelDir.getAbsolutePath();
        int wanted = clampThreads(threads);
        if (tts != null && wanted == this.threads && path.equals(modelDirPath)) {
            return;
        }
        release();

        OfflineTtsKokoroModelConfig kokoro = new OfflineTtsKokoroModelConfig();
        kokoro.setModel(new File(modelDir, KokoroModel.MODEL_FILE).getAbsolutePath());
        kokoro.setVoices(new File(modelDir, KokoroModel.VOICES_FILE).getAbsolutePath());
        kokoro.setTokens(new File(modelDir, KokoroModel.TOKENS_FILE).getAbsolutePath());
        kokoro.setLexicon(new File(modelDir, KokoroModel.LEXICON_FILE).getAbsolutePath());
        // Honoured by sherpa-onnx 1.x only: 2.0+ dropped espeak-ng and would silently skip
        // out-of-vocabulary words, which is why this plugin pins 1.13.8.
        kokoro.setDataDir(new File(modelDir, KokoroModel.ESPEAK_DIR).getAbsolutePath());

        OfflineTtsModelConfig model = new OfflineTtsModelConfig();
        model.setKokoro(kokoro);
        model.setNumThreads(wanted);
        model.setDebug(debug);
        model.setProvider("cpu");

        OfflineTtsConfig config = new OfflineTtsConfig();
        config.setModel(model);
        config.setMaxNumSentences(1);
        config.setSilenceScale(0.2f);

        Log.i(TAG, String.format(Locale.US,
                "Loading Kokoro from %s with %d threads", path, wanted));
        // A null AssetManager makes the Kotlin constructor read the model from files.
        OfflineTts created = new OfflineTts((AssetManager) null, config);
        this.threads = wanted;
        this.sampleRate = created.sampleRate() > 0 ? created.sampleRate() : DEFAULT_SAMPLE_RATE;
        this.voiceCount = created.numSpeakers();
        this.modelDirPath = path;
        this.tts = created;
        Log.i(TAG, String.format(Locale.US,
                "Kokoro ready: %d Hz, %d speakers", sampleRate, voiceCount));
    }

    public synchronized void release() {
        OfflineTts current = tts;
        tts = null;
        modelDirPath = null;
        voiceCount = 0;
        sampleRate = DEFAULT_SAMPLE_RATE;
        if (current != null) {
            try {
                current.release();
            } catch (Throwable t) {
                Log.w(TAG, "release() failed", t);
            }
        }
    }

    /**
     * Synthesize one sentence and write it as 16-bit PCM WAV into {@code audioCacheDir}.
     *
     * @param sid Kokoro speaker id (0..52), clamped into the model's range
     * @param speed 1.0 = natural pace (Kokoro's own speed control, faster than resampling)
     */
    public synchronized SynthResult synthesize(
            File audioCacheDir, String text, int sid, float speed, StopSignal stop)
            throws IOException {
        OfflineTts current = tts;
        if (current == null) {
            throw new IOException("Kokoro model is not loaded");
        }
        String trimmed = text == null ? "" : text.trim();
        if (trimmed.isEmpty()) {
            throw new IOException("Nothing to synthesize");
        }
        int speakers = current.numSpeakers();
        int speaker = sid;
        if (speakers > 0) {
            speaker = Math.max(0, Math.min(speakers - 1, sid));
        }
        float rate = speed <= 0f ? 1f : Math.max(0.5f, Math.min(2f, speed));

        long startNanos = SystemClock.elapsedRealtimeNanos();
        GeneratedAudio audio;
        if (stop != null) {
            Function1<float[], Integer> callback = new Function1<float[], Integer>() {
                @Override
                public Integer invoke(float[] samples) {
                    return stop.isStopped() ? 0 : 1;
                }
            };
            audio = current.generateWithCallback(trimmed, speaker, rate, callback);
        } else {
            audio = current.generate(trimmed, speaker, rate);
        }
        long elapsedMs = (SystemClock.elapsedRealtimeNanos() - startNanos) / 1_000_000L;

        // stop() flips the signal mid-generation; the partial waveform is useless, and writing
        // it to the cache would only make the next sentence slower.
        if (stop != null && stop.isStopped()) {
            return cancelledResult();
        }
        if (audio == null) {
            throw new IOException("sherpa-onnx returned no audio");
        }

        float[] samples = audio.getSamples();
        int generatedRate =
                audio.getSampleRate() > 0 ? audio.getSampleRate() : current.sampleRate();
        if (samples == null || samples.length == 0) {
            throw new IOException("sherpa-onnx generated an empty waveform");
        }

        byte[] wav = WavWriter.toBytes(samples, generatedRate);
        if (!audioCacheDir.isDirectory() && !audioCacheDir.mkdirs()
                && !audioCacheDir.isDirectory()) {
            throw new IOException("Cannot create " + audioCacheDir.getAbsolutePath());
        }
        sequence = (sequence + 1) % 1000;
        File file = new File(audioCacheDir,
                String.format(Locale.US, "sentence-%03d-%d.wav", sequence, System.currentTimeMillis()));
        try (OutputStream out = new FileOutputStream(file)) {
            out.write(wav);
        }

        SynthResult result = new SynthResult();
        result.path = file.getAbsolutePath();
        result.wav = wav;
        result.sampleRate = generatedRate;
        result.sampleCount = samples.length;
        result.durationMs = WavWriter.durationMs(samples.length, generatedRate);
        result.elapsedMs = elapsedMs;
        result.rtf = result.durationMs > 0 ? (elapsedMs / (double) result.durationMs) : 0.0;
        Log.i(TAG, String.format(Locale.US,
                "synthesized %d chars sid=%d speed=%.2f in %d ms -> %d ms audio (RTF %.2f)",
                trimmed.length(), speaker, rate, elapsedMs, result.durationMs, result.rtf));

        pruneCache(audioCacheDir);
        return result;
    }

    private SynthResult cancelledResult() {
        SynthResult result = new SynthResult();
        result.cancelled = true;
        result.sampleRate = sampleRate;
        return result;
    }

    static int clampThreads(int threads) {
        return Math.max(1, Math.min(8, threads));
    }

    /** Keep the cache small: a chapter of sentences would otherwise pile up in cacheDir. */
    private static void pruneCache(File dir) {
        File[] files = dir.listFiles((d, name) -> name.endsWith(".wav"));
        if (files == null || files.length <= MAX_CACHED_WAVS) {
            return;
        }
        Arrays.sort(files, Comparator.comparingLong(File::lastModified));
        for (int i = 0; i < files.length - MAX_CACHED_WAVS; i++) {
            KokoroStore.deleteRecursively(files[i]);
        }
    }
}
