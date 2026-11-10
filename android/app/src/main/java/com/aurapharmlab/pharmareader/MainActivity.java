package com.aurapharmlab.pharmareader;

import android.content.pm.ApplicationInfo;
import android.os.Bundle;
import android.util.Log;
import android.webkit.WebView;

import com.aurapharmlab.pharmareader.kokoro.KokoroPlugin;
import com.getcapacitor.BridgeActivity;

import java.io.File;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // chrome://inspect is only useful (and only safe) on debug builds; must run before the Bridge builds its WebView.
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
        // Must run before super.onCreate(): the Bridge creates the WebView there.
        dropStaleServiceWorker();
        // On-device Kokoro speech (sherpa-onnx). Must be registered before super.onCreate(),
        // which is where the Capacitor Bridge instantiates its plugin set.
        registerPlugin(KokoroPlugin.class);
        super.onCreate(savedInstanceState);
        // NOTE: cross-origin isolation (COOP/COEP on the local asset server) was tried here and
        // does not work in the Android WebView: the headers reach the page, but
        // self.crossOriginIsolated stays false and COEP is not enforced. See docs/PERFORMANCE.md.
    }

    /**
     * Delete a service worker registration left behind by an older build.
     *
     * <p>A build that shipped the PWA (or a page loaded in the WebView while one was enabled)
     * installs a service worker whose precache answers every navigation with the index.html of
     * that build. The bundle then imports chunk names that no longer exist in the new install, so
     * an upgraded app either 404s its own assets or quietly runs the previous release — and it
     * never reaches the new code, so no JavaScript fix can repair it. The Android shell ships no
     * service worker (VitePWA is disabled for the native mode), which makes any registration here
     * stale by definition: drop the registration and its script cache, keeping CacheStorage so
     * the app's own runtime caches (onnx models and so on) survive.
     */
    private void dropStaleServiceWorker() {
        File root = new File(getApplicationInfo().dataDir, "app_webview/Default/Service Worker");
        int dropped = deleteTree(new File(root, "Database")) + deleteTree(new File(root, "ScriptCache"));
        if (dropped > 0) {
            Log.i("PharmaReader", "Dropped a service worker left by an older build (" + dropped + " entries)");
        }
    }

    /** Deletes {@code file} and everything under it; returns how many paths went away. */
    private static int deleteTree(File file) {
        int removed = 0;
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) {
                removed += deleteTree(child);
            }
        }
        //noinspection ResultOfMethodCallIgnored
        if (file.delete()) {
            removed++;
        }
        return removed;
    }
}
