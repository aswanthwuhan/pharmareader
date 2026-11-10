package com.aurapharmlab.pharmareader;

import android.content.pm.ApplicationInfo;
import android.os.Bundle;
import android.util.Log;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AlertDialog;

import com.aurapharmlab.pharmareader.kokoro.KokoroPlugin;
import com.aurapharmlab.pharmareader.playback.PlaybackPlugin;
import com.aurapharmlab.pharmareader.playback.PlaybackService;
import com.getcapacitor.BridgeActivity;

import java.io.File;

public class MainActivity extends BridgeActivity {

    /**
     * Asks the web app whether it handled the press: a sheet, drawer or dialog closes, or the
     * reader goes back to the library, and the answer is {@code true}. Only a library root with
     * nothing open answers {@code false}, which is when this activity offers to exit. Anything
     * thrown or missing counts as "not handled" so the press is never swallowed.
     */
    private static final String BACK_PROBE =
            "(function(){try{return !!(window.__pharmaBack&&window.__pharmaBack());}"
                    + "catch(e){return false;}})()";

    /**
     * One dialog at a time: a second back press while it is up must not stack another. This is
     * also what serialises the presses -- there is deliberately no "probe in flight" flag,
     * because a probe whose callback never arrives (a crashed renderer, a torn-down WebView)
     * would otherwise leave the back key dead for the rest of the session.
     */
    private boolean exitDialogShowing;
    private AlertDialog exitDialog;

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
        // Foreground media service that keeps reading alive with the screen locked.
        registerPlugin(PlaybackPlugin.class);
        // Immersive (full-screen) reading: the WebView has no custom-view support, so the bars
        // can only be hidden from here.
        registerPlugin(SystemUiPlugin.class);
        super.onCreate(savedInstanceState);
        // NOTE: cross-origin isolation (COOP/COEP on the local asset server) was tried here and
        // does not work in the Android WebView: the headers reach the page, but
        // self.crossOriginIsolated stays false and COEP is not enforced. See docs/PERFORMANCE.md.

        // Enabled, so it replaces AppCompat's default handler (which finishes the activity):
        // every back press goes to the web app first and the activity is closed only from the
        // confirmation dialog below.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                onSystemBackPressed();
            }
        });
    }

    @Override
    public void onResume() {
        super.onResume();
        // A permission dialog, the notification shade or another app makes Android show the
        // system bars again; put the reader back the way it asked to be.
        if (SystemUiPlugin.isImmersive()) {
            SystemUiPlugin.apply(this, true);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // Same reason as onResume(), and this is the callback Android actually delivers after
        // a transient-bar interaction or a dialog closes.
        if (hasFocus && SystemUiPlugin.isImmersive()) {
            SystemUiPlugin.apply(this, true);
        }
    }

    /** Lets the web app consume the press; offers to exit only when it says it did not. */
    private void onSystemBackPressed() {
        if (exitDialogShowing) {
            return;
        }
        WebView webView = bridge == null ? null : bridge.getWebView();
        if (webView == null) {
            confirmExit();
            return;
        }
        try {
            webView.evaluateJavascript(BACK_PROBE, value -> {
                // evaluateJavascript hands a boolean back as the bare string "true"/"false";
                // "null" (page gone) and "false" both mean the web app did not navigate.
                if (!"true".equals(value)) {
                    confirmExit();
                }
            });
        } catch (Throwable t) {
            Log.w("PharmaReader", "back probe failed", t);
            confirmExit();
        }
    }

    /**
     * The only place this activity finishes. "Exit" also stops the playback service so the
     * notification and the wake lock go with it.
     */
    private void confirmExit() {
        // isDestroyed(): a probe can answer after the activity is gone (the WebView was torn
        // down under it), and showing a dialog then throws BadTokenException and kills the app.
        if (exitDialogShowing || isFinishing() || isDestroyed()) {
            return;
        }
        exitDialogShowing = true;
        // Built from the activity's own (AppCompat) theme rather than the platform dialog: the
        // activity runs under R.style.AppTheme.NoActionBar, so this picks up the app's colours.
        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("Exit PharmaReader?")
                .setMessage("Your place is saved.")
                .setPositiveButton("Exit", (d, which) -> {
                    PlaybackService.stop(this);
                    finish();
                })
                .setNegativeButton("Stay", (d, which) -> d.dismiss())
                .create();
        exitDialog = dialog;
        dialog.setOnDismissListener(d -> {
            exitDialogShowing = false;
            exitDialog = null;
        });
        dialog.show();
    }

    @Override
    public void onDestroy() {
        // Dismiss it here: a dialog still attached to a destroyed activity leaks its window.
        if (exitDialog != null) {
            exitDialog.dismiss();
            exitDialog = null;
        }
        super.onDestroy();
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
