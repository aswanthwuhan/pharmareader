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
 * <p>The model itself is downloaded at runtime (334 MiB) rather than shipped in the APK.
 */
@CapacitorPlugin(name = "Kokoro")
public class KokoroPlugin extends Plugin {

    private static final String TAG = "KokoroPlugin";
    private static final int DEFAULT_THREADS = 4;
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
    private KokoroStore store;

    @Override
    public void load() {
        store = new KokoroStore(getContext());
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
            statusExecutor.execute(() -> {
                try {
                    KokoroTtsEngine engine = KokoroTtsEngine.getInstance();
                    JSObject result = new JSObject();
                    result.put("downloaded", store.isDownloaded());
                    result.put("loaded", engine.isLoaded());
                    result.put("sizeBytes", store.sizeBytes());
                    result.put("freeBytes", store.freeBytes());
                    result.put("partialBytes", store.partialBytes());
                    result.put("requiredBytes", KokoroModel.REQUIRED_FREE_BYTES);
                    result.put("metered", isMetered());
                    result.put("modelId", KokoroModel.ID);
                    result.put("modelUrl", KokoroModel.SOURCE_URL);
                    result.put("archiveBytes", KokoroModel.ARCHIVE_BYTES);
                    result.put("attribution", KokoroModel.ATTRIBUTION);
                    result.put("sampleRate", engine.sampleRate());
                    result.put("threads", engine.threads());
                    result.put("provider", engine.provider());
                    result.put("defaultSid", KokoroModel.DEFAULT_SID);
                    result.put("voiceCount", KokoroModel.count());
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
        try {
            ioExecutor.execute(() -> {
                try {
                    if (store.isDownloaded()) {
                        JSObject result = new JSObject();
                        result.put("downloaded", true);
                        result.put("sizeBytes", store.sizeBytes());
                        call.resolve(result);
                        return;
                    }
                    long size = store.download((fraction, bytesRead, totalBytes) -> {
                        JSObject progress = new JSObject();
                        progress.put("fraction", fraction);
                        progress.put("bytes", bytesRead);
                        progress.put("totalBytes", totalBytes);
                        notifyListeners("downloadProgress", progress);
                    });
                    JSObject result = new JSObject();
                    result.put("downloaded", true);
                    result.put("sizeBytes", size);
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
        try {
            ioExecutor.execute(() -> {
                try {
                    KokoroTtsEngine.getInstance().release();
                    store.delete();
                    JSObject result = new JSObject();
                    result.put("downloaded", false);
                    result.put("sizeBytes", 0L);
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
        Integer requested = call.getInt("threads", null);
        boolean debug = Boolean.TRUE.equals(call.getBoolean("debug", Boolean.FALSE));
        int threads = requested == null || requested <= 0 ? defaultThreads() : requested;
        String provider = call.getString("provider", KokoroTtsEngine.DEFAULT_PROVIDER);
        try {
            synthExecutor.execute(() -> {
                try {
                    if (!store.isDownloaded()) {
                        safeReject(call, "The Kokoro model is not downloaded yet", "NOT_DOWNLOADED");
                        return;
                    }
                    KokoroTtsEngine engine = KokoroTtsEngine.getInstance();
                    engine.load(store.modelDir(), threads, debug, provider);
                    JSObject result = new JSObject();
                    result.put("loaded", true);
                    result.put("threads", engine.threads());
                    result.put("provider", engine.provider());
                    result.put("sampleRate", engine.sampleRate());
                    result.put("voiceCount", engine.voiceCount());
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

        try {
            synthExecutor.execute(() -> {
                if (myEpoch != epoch) {
                    resolveCancelled(call);
                    return;
                }
                try {
                    KokoroTtsEngine engine = KokoroTtsEngine.getInstance();
                    if (!engine.isLoaded()) {
                        if (!store.isDownloaded()) {
                            safeReject(call, "The Kokoro model is not downloaded yet",
                                    "NOT_DOWNLOADED");
                            return;
                        }
                        int threads = threadsArg == null || threadsArg <= 0
                                ? defaultThreads() : threadsArg;
                        engine.load(store.modelDir(), threads, false);
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
        return Math.max(2, Math.min(DEFAULT_THREADS, cores));
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
