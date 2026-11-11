package com.aurapharmlab.pharmareader.kokoro;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.util.Base64;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Capacitor bridge for on-device Kokoro speech.
 *
 * <p>All heavy work runs on dedicated background threads — {@code kokoro-io} for the model
 * download/extraction, {@code kokoro-synth} for ONNX inference and {@code kokoro-status} for
 * the cheap file probes — because a 4-thread ONNX session on the WebView's main thread would
 * freeze the reader. Status has its own thread on purpose: a 334&nbsp;MiB download holds the
 * io thread for many minutes, and the settings panel must still be able to ask whether the
 * model is present.
 *
 * <p>Two model builds can exist on disk, and every method takes an optional {@code model}
 * argument ({@code "int8"} or {@code "fp32"}): fp32 is the build this plugin speaks with
 * and the default for a new install; the int8 graph v0.3.3 defaulted to is no longer
 * offered, but its files are still reported so the panel can delete them. Each build lives
 * in its own
 * directory, so both can be present at once.
 *
 * <p>The model itself is downloaded at runtime (132 MB or 334 MB) rather than shipped in
 * the APK.
 */
@CapacitorPlugin(name = "Kokoro")
public class KokoroPlugin extends Plugin {

    private static final String TAG = "KokoroPlugin";
    /** 2 threads: about 0.75x real time on a mid-range phone without keeping 4 cores hot. */
    private static final int DEFAULT_THREADS = 2;
    /** Longer text is a caller bug: one ONNX call per sentence, not per chapter. */
    private static final int MAX_TEXT_CHARS = 4000;

    private final ExecutorService ioExecutor =
            Executors.newSingleThreadExecutor(new NamedThreadFactory("kokoro-io"));
    private final ExecutorService synthExecutor =
            Executors.newSingleThreadExecutor(new NamedThreadFactory("kokoro-synth"));
    private final ExecutorService statusExecutor =
            Executors.newSingleThreadExecutor(new NamedThreadFactory("kokoro-status"));
    private final AtomicBoolean downloading = new AtomicBoolean(false);
    /**
     * Bumped by {@link #stop} and {@link #unload}: queued and running synthesis from an
     * older epoch resolves with {@code cancelled: true} instead of speaking stale audio.
     */
    private volatile int epoch;
    /** One store per model build; both can be installed side by side. */
    private final java.util.Map<String, KokoroStore> stores = new java.util.HashMap<>();

    @Override
    public void load() {
        // The stores are created on first use (they are plain file handles); this also keeps
        // the plugin usable when getContext() is only available after load().
    }

    /** The store for one model build. */
    private KokoroStore store(KokoroModel.Descriptor model) {
        synchronized (stores) {
            KokoroStore existing = stores.get(model.key());
            if (existing != null) {
                return existing;
            }
            KokoroStore created = new KokoroStore(getContext(), model);
            stores.put(model.key(), created);
            return created;
        }
    }

    /**
     * The model this call should <em>report on</em>: the requested build when it is installed,
     * otherwise the other build when <em>that</em> one is installed, otherwise the requested
     * build so the "not downloaded" answer names the model the caller asked for.
     *
     * <p>Only {@link #status} and the {@code stillDownloaded} information of
     * {@link #deleteModel} use this. {@link #load} and {@link #synthesize} take the requested
     * build as it is: fp32 is the only build the app speaks with, and quietly loading or
     * speaking the old int8 graph instead — which the user rejected — would poison the fp32
     * audio cache with int8 clips.
     */
    private KokoroModel.Descriptor resolveDownloaded(KokoroModel.Descriptor wanted) {
        if (store(wanted).isDownloaded()) {
            return wanted;
        }
        KokoroModel.Descriptor other = KokoroModel.other(wanted);
        return store(other).isDownloaded() ? other : wanted;
    }

    /** The model named by the call's {@code model} argument (fp32 when absent or unknown). */
    private static KokoroModel.Descriptor requested(PluginCall call) {
        return KokoroModel.forKey(call == null ? null : call.getString("model", null));
    }

    /** The {@code models} array of {@link #status}: one entry per build, installed or not. */
    private JSArray modelStates(KokoroModel.Descriptor active) {
        JSArray models = new JSArray();
        for (KokoroModel.Descriptor model : KokoroModel.ALL) {
            KokoroStore modelStore = store(model);
            JSObject entry = new JSObject();
            entry.put("key", model.key());
            entry.put("id", model.id());
            entry.put("label", model.label());
            entry.put("downloaded", modelStore.isDownloaded());
            entry.put("sizeBytes", modelStore.sizeBytes());
            entry.put("partialBytes", modelStore.partialBytes());
            entry.put("archiveBytes", model.archiveBytes());
            entry.put("requiredBytes", model.requiredFreeBytes());
            entry.put("extractedBytes", model.extractedBytes());
            entry.put("active", model.key().equals(active.key()));
            models.put(entry);
        }
        return models;
    }

    @Override
    protected void handleOnDestroy() {
        // Flip the epoch first: a generation running inside sherpa-onnx returns 0 from its
        // callback at the next chunk and unwinds, so the release below does not wait long.
        epoch++;
        ioExecutor.shutdownNow();
        statusExecutor.shutdownNow();
        synthExecutor.shutdownNow();
        // release() takes the engine monitor, so it must never run on the UI thread.
        Thread releaser = new Thread(KokoroTtsEngine.getInstance()::release, "kokoro-release");
        releaser.setDaemon(true);
        releaser.start();
    }

    // ------------------------------------------------------------------ status

    @PluginMethod
    public void status(PluginCall call) {
        try {
            KokoroModel.Descriptor wanted = requested(call);
            statusExecutor.execute(() -> {
                try {
                    KokoroTtsEngine engine = KokoroTtsEngine.getInstance();
                    KokoroModel.Descriptor active = resolveDownloaded(wanted);
                    KokoroStore store = store(active);
                    JSObject result = new JSObject();
                    result.put("downloaded", store.isDownloaded());
                    result.put("loaded", engine.isLoaded());
                    result.put("loadedModel", engine.isLoaded() && engine.modelKey() != null
                            ? engine.modelKey() : "");
                    result.put("sizeBytes", store.sizeBytes());
                    result.put("freeBytes", store.freeBytes());
                    result.put("partialBytes", store.partialBytes());
                    result.put("requiredBytes", active.requiredFreeBytes());
                    result.put("metered", isMetered());
                    result.put("model", active.key());
                    result.put("requested", wanted.key());
                    result.put("modelId", active.id());
                    result.put("modelLabel", active.label());
                    result.put("modelUrl", KokoroModel.SOURCE_URL);
                    result.put("archiveBytes", active.archiveBytes());
                    result.put("extractedBytes", active.extractedBytes());
                    result.put("attribution", KokoroModel.ATTRIBUTION);
                    result.put("sampleRate", engine.sampleRate());
                    result.put("threads", engine.isLoaded() ? engine.threads() : defaultThreads());
                    result.put("provider", engine.provider());
                    result.put("defaultSid", KokoroModel.DEFAULT_SID);
                    result.put("voiceCount", KokoroModel.count());
                    result.put("models", modelStates(active));
                    call.resolve(result);
                } catch (Throwable t) {
                    Log.e(TAG, "status failed", t);
                    safeReject(call, "Could not read the Kokoro model status: " + describe(t),
                            "STATUS_FAILED");
                }
            });
        } catch (RejectedExecutionException e) {
            call.reject("Kokoro plugin is shutting down", "SHUTDOWN");
        }
    }

    /** True when the active connection is mobile data (or another metered link). */
    private boolean isMetered() {
        try {
            ConnectivityManager manager =
                    (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
            if (manager == null) {
                return false;
            }
            Network network = manager.getActiveNetwork();
            if (network == null) {
                return false; // offline: a "use Wi-Fi" hint would be misleading
            }
            NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
            return capabilities == null
                    || !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED);
        } catch (Throwable t) {
            Log.w(TAG, "could not read the network state", t);
            return false;
        }
    }

    // ---------------------------------------------------------------- download

    @PluginMethod
    public void download(PluginCall call) {
        if (!downloading.compareAndSet(false, true)) {
            call.reject("A model download is already running", "BUSY");
            return;
        }
        // The download is always the build the caller named, never a fallback: the JS side
        // asks for fp32, and an older fp32 install must not make that answer "already here".
        KokoroModel.Descriptor wanted = requested(call);
        try {
            ioExecutor.execute(() -> {
                try {
                    KokoroStore store = store(wanted);
                    if (store.isDownloaded()) {
                        JSObject result = new JSObject();
                        result.put("downloaded", true);
                        result.put("sizeBytes", store.sizeBytes());
                        result.put("model", wanted.key());
                        call.resolve(result);
                        return;
                    }
                    long size = store.download((fraction, bytesRead, totalBytes) -> {
                        JSObject progress = new JSObject();
                        progress.put("fraction", fraction);
                        progress.put("bytes", bytesRead);
                        progress.put("totalBytes", totalBytes);
                        progress.put("model", wanted.key());
                        notifyListeners("downloadProgress", progress);
                    });
                    JSObject result = new JSObject();
                    result.put("downloaded", true);
                    result.put("sizeBytes", size);
                    result.put("model", wanted.key());
                    call.resolve(result);
                } catch (OutOfMemoryError e) {
                    Log.e(TAG, "download ran out of memory", e);
                    safeReject(call, MEMORY_MESSAGE, "OUT_OF_MEMORY");
                } catch (Throwable t) {
                    Log.e(TAG, "download failed", t);
                    String message = describe(t);
                    if (!message.startsWith("Model download")) {
                        message = "Download failed: " + message;
                    }
                    safeReject(call, message, "DOWNLOAD_FAILED");
                } finally {
                    downloading.set(false);
                }
            });
        } catch (RejectedExecutionException e) {
            downloading.set(false);
            call.reject("Kokoro plugin is shutting down", "SHUTDOWN");
        }
    }

    @PluginMethod
    public void deleteModel(PluginCall call) {
        if (downloading.get()) {
            call.reject(
                    "The model is still downloading. Wait for it to finish, or close and reopen "
                            + "the app to discard it.",
                    "BUSY");
            return;
        }
        // Only the named build is removed; the other one keeps working.
        KokoroModel.Descriptor wanted = requested(call);
        try {
            ioExecutor.execute(() -> {
                try {
                    KokoroTtsEngine engine = KokoroTtsEngine.getInstance();
                    KokoroStore store = store(wanted);
                    // Unloading is global, so only do it when the removed model is the loaded
                    // one — deleting the old int8 files while fp32 is in memory must not cost
                    // a 334 MB reload.
                    if (store.modelDir().getAbsolutePath().equals(engine.modelDirPath())) {
                        engine.release();
                    }
                    store.delete();
                    JSObject result = new JSObject();
                    result.put("downloaded", false);
                    result.put("sizeBytes", 0L);
                    result.put("model", wanted.key());
                    result.put("stillDownloaded", resolveDownloaded(wanted).key());
                    call.resolve(result);
                } catch (Throwable t) {
                    Log.e(TAG, "delete failed", t);
                    safeReject(call, "Could not delete the model: " + describe(t), "DELETE_FAILED");
                }
            });
        } catch (RejectedExecutionException e) {
            call.reject("Kokoro plugin is shutting down", "SHUTDOWN");
        }
    }

    // -------------------------------------------------------------------- load

    @PluginMethod
    public void load(PluginCall call) {
        Integer threadsArg = call.getInt("threads", null);
        boolean debug = Boolean.TRUE.equals(call.getBoolean("debug", Boolean.FALSE));
        int threads = threadsArg == null || threadsArg <= 0 ? defaultThreads() : threadsArg;
        String provider = call.getString("provider", KokoroTtsEngine.DEFAULT_PROVIDER);
        KokoroModel.Descriptor wanted = requested(call);
        try {
            synthExecutor.execute(() -> {
                try {
                    // The requested build only: falling back to the other one would speak
                    // (or load) the int8 graph the user rejected.
                    KokoroModel.Descriptor active = wanted;
                    KokoroStore store = store(active);
                    if (!store.isDownloaded()) {
                        safeReject(call, "The Kokoro model is not downloaded yet", "NOT_DOWNLOADED");
                        return;
                    }
                    KokoroTtsEngine engine = KokoroTtsEngine.getInstance();
                    engine.load(store.modelDir(), active, threads, debug, provider);
                    JSObject result = new JSObject();
                    result.put("loaded", true);
                    result.put("threads", engine.threads());
                    result.put("provider", engine.provider());
                    result.put("sampleRate", engine.sampleRate());
                    result.put("voiceCount", engine.voiceCount());
                    result.put("model", active.key());
                    call.resolve(result);
                } catch (OutOfMemoryError e) {
                    Log.e(TAG, "load ran out of memory", e);
                    KokoroTtsEngine.getInstance().release();
                    safeReject(call, MEMORY_MESSAGE, "OUT_OF_MEMORY");
                } catch (Throwable t) {
                    Log.e(TAG, "load failed", t);
                    safeReject(call, "Could not load the Kokoro model: " + describe(t),
                            "LOAD_FAILED");
                }
            });
        } catch (RejectedExecutionException e) {
            call.reject("Kokoro plugin is shutting down", "SHUTDOWN");
        }
    }

    @PluginMethod
    public void unload(PluginCall call) {
        epoch++;
        try {
            synthExecutor.execute(() -> {
                try {
                    KokoroTtsEngine.getInstance().release();
                    JSObject result = new JSObject();
                    result.put("loaded", false);
                    call.resolve(result);
                } catch (Throwable t) {
                    Log.e(TAG, "unload failed", t);
                    safeReject(call, "Could not unload the Kokoro model: " + describe(t),
                            "UNLOAD_FAILED");
                }
            });
        } catch (RejectedExecutionException e) {
            call.reject("Kokoro plugin is shutting down", "SHUTDOWN");
        }
    }

    // ------------------------------------------------------------------ voices

    @PluginMethod
    public void voices(PluginCall call) {
        JSArray voices = new JSArray();
        for (int sid = 0; sid < KokoroModel.count(); sid++) {
            JSObject voice = new JSObject();
            voice.put("id", sid);
            voice.put("name", KokoroModel.nameFor(sid));
            voice.put("lang", KokoroModel.langFor(sid));
            voice.put("english", KokoroModel.isEnglish(sid));
            voices.put(voice);
        }
        JSObject result = new JSObject();
        result.put("voices", voices);
        result.put("defaultSid", KokoroModel.DEFAULT_SID);
        call.resolve(result);
    }

    // -------------------------------------------------------------- synthesize

    @PluginMethod
    public void synthesize(PluginCall call) {
        String text = call.getString("text", "");
        if (text == null || text.trim().isEmpty()) {
            call.reject("No text to synthesize", "EMPTY_TEXT");
            return;
        }
        if (text.length() > MAX_TEXT_CHARS) {
            call.reject(
                    "That sentence is too long to speak in one piece (" + text.length()
                            + " characters, limit " + MAX_TEXT_CHARS + ").",
                    "TEXT_TOO_LONG");
            return;
        }
        int sid = call.getInt("sid", KokoroModel.DEFAULT_SID);
        Float speedArg = call.getFloat("speed", 1.0f);
        float speed = speedArg == null || speedArg <= 0f ? 1.0f : speedArg;
        Integer threadsArg = call.getInt("threads", null);
        final int myEpoch = epoch;
        KokoroModel.Descriptor wanted = requested(call);

        try {
            synthExecutor.execute(() -> {
                if (myEpoch != epoch) {
                    resolveCancelled(call);
                    return;
                }
                try {
                    KokoroTtsEngine engine = KokoroTtsEngine.getInstance();
                    // The requested build only: with only the old int8 files on the phone this
                    // rejects NOT_DOWNLOADED instead of quietly speaking the rejected graph,
                    // which the JS cache would then store under the fp32 cache key.
                    KokoroModel.Descriptor active = wanted;
                    KokoroStore store = store(active);
                    String dir = store.modelDir().getAbsolutePath();
                    // Reload when nothing is loaded or when another build is in memory: the
                    // engine keeps one session, and speaking one build's audio from the
                    // other's session is not what the caller asked for.
                    if (!engine.isLoaded() || !dir.equals(engine.modelDirPath())) {
                        if (!store.isDownloaded()) {
                            safeReject(call, "The Kokoro model is not downloaded yet",
                                    "NOT_DOWNLOADED");
                            return;
                        }
                        int threads = threadsArg == null || threadsArg <= 0
                                ? defaultThreads() : threadsArg;
                        engine.load(store.modelDir(), active, threads, false,
                                KokoroTtsEngine.DEFAULT_PROVIDER);
                    }
                    // In-memory WAV bytes only: nothing is written to disk (the JS player builds a
                    // blob URL from wavBase64), so there is no file to clean up afterwards.
                    KokoroTtsEngine.SynthResult synth = engine.synthesize(
                            text,
                            sid,
                            speed,
                            () -> myEpoch != epoch);

                    if (synth.cancelled || synth.wav == null) {
                        resolveCancelled(call);
                        return;
                    }
                    JSObject result = new JSObject();
                    result.put("durationMs", synth.durationMs);
                    result.put("sampleRate", synth.sampleRate);
                    result.put("rtf", synth.rtf);
                    result.put("elapsedMs", synth.elapsedMs);
                    result.put("bytes", (long) synth.wav.length);
                    result.put("model", active.key());
                    result.put("wavBase64", Base64.encodeToString(synth.wav, Base64.NO_WRAP));
                    call.resolve(result);
                } catch (OutOfMemoryError e) {
                    Log.e(TAG, "synthesis ran out of memory", e);
                    safeReject(call, MEMORY_MESSAGE, "OUT_OF_MEMORY");
                } catch (Throwable t) {
                    Log.e(TAG, "synthesize failed", t);
                    safeReject(call, "Synthesis failed: " + describe(t), "SYNTH_FAILED");
                }
            });
        } catch (RejectedExecutionException e) {
            call.reject("Kokoro plugin is shutting down", "SHUTDOWN");
        }
    }

    /**
     * Ask the running generation to stop at the next audio chunk and make queued
     * sentences resolve immediately with {@code cancelled: true}.
     */
    @PluginMethod
    public void stop(PluginCall call) {
        epoch++;
        JSObject result = new JSObject();
        result.put("stopped", true);
        call.resolve(result);
    }

    // ----------------------------------------------------------------- helpers

    private static final String MEMORY_MESSAGE =
            "This phone ran out of memory running Kokoro. Choose 2 threads in Settings, close "
                    + "other apps, or use the system voice instead.";

    private static int defaultThreads() {
        int cores = Runtime.getRuntime().availableProcessors();
        // No floor of 2: one thread is the coolest option the panel offers, and on a
        // single-core phone it is the only honest default.
        return Math.max(1, Math.min(DEFAULT_THREADS, cores));
    }

    private static void resolveCancelled(PluginCall call) {
        JSObject cancelled = new JSObject();
        cancelled.put("cancelled", true);
        call.resolve(cancelled);
    }

    private static void safeReject(PluginCall call, String message, String code) {
        try {
            call.reject(message, code);
        } catch (Throwable ignored) {
            Log.w(TAG, "could not reject (call already released): " + message);
        }
    }

    private static String describe(Throwable t) {
        String message = t.getMessage();
        if (message == null || message.isEmpty()) {
            return t.getClass().getSimpleName();
        }
        // Download/storage failures already read as full sentences; a class name would only
        // make the message shown in the panel harder to read.
        if (t instanceof java.io.IOException) {
            return message;
        }
        return String.format(Locale.US, "%s (%s)", message, t.getClass().getSimpleName());
    }

    private static final class NamedThreadFactory implements ThreadFactory {
        private final String name;

        NamedThreadFactory(String name) {
            this.name = name;
        }

        @Override
        public Thread newThread(Runnable runnable) {
            Thread thread = new Thread(runnable, name);
            thread.setPriority(Thread.NORM_PRIORITY);
            return thread;
        }
    }
}
