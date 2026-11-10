package com.aurapharmlab.pharmareader;

import android.app.Activity;
import android.view.View;
import android.view.Window;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Native side of full-screen (immersive) reading; the JavaScript side is
 * {@code src/tts/native/systemUi.ts}.
 *
 * <p>The web Fullscreen API does nothing in this shell: Capacitor's
 * {@code BridgeWebChromeClient} inherits {@code onShowCustomView}, which only calls through to
 * the super implementation, so a page request never reaches the activity's decor view. Hiding
 * the system bars has to happen natively.
 *
 * <p>Insets: on Android 15+ (targetSdk 36) the activity is edge-to-edge, and on older releases
 * Capacitor's own SystemBars plugin pads the decor view and/or publishes
 * {@code env(safe-area-inset-*)} to the page. Hiding the bars zeroes those insets, so the decor
 * padding (or the CSS padding) collapses with them: the WebView grows into the space the bars
 * held, in both the edge-to-edge and the fitted window, and the page keeps its safe-area layout
 * when the bars come back. Nothing here changes how insets are handled.
 */
@CapacitorPlugin(name = "SystemUi")
public class SystemUiPlugin extends Plugin {

    /**
     * The last mode the web layer asked for. It survives a pause, so the activity can put it
     * back after a dialog, the notification shade or an app switch made Android show the bars
     * again ({@link MainActivity#onResume()} and {@link MainActivity#onWindowFocusChanged}).
     */
    private static volatile boolean immersive;

    @PluginMethod
    public void setImmersive(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", Boolean.FALSE));
        immersive = on;
        Activity activity = getActivity();
        if (activity == null) {
            call.resolve();
            return;
        }
        // The insets controller drives window flags, which belong to the UI thread. Capacitor
        // calls plugin methods on the bridge's thread, so hop over rather than touch the view
        // from here.
        activity.runOnUiThread(() -> {
            apply(activity, on);
            call.resolve();
        });
    }

    /** True while the reader should be full screen. */
    static boolean isImmersive() {
        return immersive;
    }

    /**
     * Hides (or shows) the status and navigation bars. Called by the plugin, and again by
     * {@link MainActivity} whenever the activity regains focus while immersive is on.
     */
    static void apply(Activity activity, boolean on) {
        // The caller runs on the UI thread; an activity that is already tearing down must not
        // touch its window.
        if (activity == null || activity.isFinishing() || activity.isDestroyed()) {
            return;
        }
        Window window = activity.getWindow();
        View decorView = window.getDecorView();
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, decorView);
        if (on) {
            // A swipe from the edge reveals the bars for a moment over the page and then they
            // slide away again, instead of leaving immersive mode.
            controller.setSystemBarsBehavior(
                    WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            controller.hide(WindowInsetsCompat.Type.systemBars());
        } else {
            controller.show(WindowInsetsCompat.Type.systemBars());
        }
    }

    @Override
    protected void handleOnDestroy() {
        // A relaunch must open with the bars in place: the reading view that asked for
        // immersive mode is not there any more, and its replacement will ask again if it wants
        // full screen. Otherwise the app would come back full screen with no way to tell why.
        immersive = false;
    }
}
