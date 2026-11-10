package com.aurapharmlab.pharmareader.playback;

import android.Manifest;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Bridge between the reader's web player and {@link PlaybackService}.
 *
 * <p>JavaScript calls {@code start}, {@code setState} and {@code stop}; the service and the
 * media session's buttons arrive back as the {@code action} listener event. Every method
 * resolves: a service that refuses to start (background-start limits, a missing permission)
 * must not break playback, which happens in the WebView's audio stack regardless.
 *
 * <p>On Android 13+ the notification permission is asked exactly once, from the first
 * {@code start}; a refusal only hides the notification, it does not stop the reading.
 */
@CapacitorPlugin(
        name = "Playback",
        permissions = @Permission(
                strings = { Manifest.permission.POST_NOTIFICATIONS },
                alias = "notifications"))
public class PlaybackPlugin extends Plugin implements PlaybackService.ActionListener {

    private static final String TAG = "PlaybackPlugin";
    private static final String EVENT_ACTION = "action";
    private static final String PREFS = "playback";
    private static final String KEY_ASKED = "notificationAsked";

    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    /** The {@code start} call waiting for the notification prompt (null when none is open). */
    private PluginCall pendingStart;
    private String pendingTitle;
    private String pendingSubtitle;
    /**
     * The play state the deferred start will ask for. {@code setState} updates it while the
     * prompt is up: a start followed by a pause inside that window must not leave an ongoing
     * notification and a renewing wake lock behind when the user finally answers.
     */
    private boolean pendingPlaying = true;

    @Override
    public void load() {
        PlaybackService.setActionListener(this);
    }

    @Override
    protected void handleOnDestroy() {
        PlaybackService.setActionListener(null);
        // Never leave a call hanging if the bridge dies while the prompt is up.
        PluginCall waiting = pendingStart;
        clearPendingStart();
        if (waiting != null) {
            waiting.resolve();
        }
    }

    // ------------------------------------------------------------------------ methods

    @PluginMethod
    public void start(PluginCall call) {
        String title = call.getString("title", "Reading aloud");
        String subtitle = call.getString("subtitle", "");
        if (pendingStart != null) {
            // A start is already waiting on the prompt; asking again would queue a second one
            // (Android shows one dialog). The reader moved on, so keep its newest title and the
            // fact that it wants to play, and let the deferred start below resolve this call.
            pendingTitle = title;
            pendingSubtitle = subtitle;
            pendingPlaying = true;
            call.resolve();
            return;
        }
        if (shouldAskForNotifications()) {
            markNotificationAsked();
            pendingStart = call;
            pendingTitle = title;
            pendingSubtitle = subtitle;
            pendingPlaying = true;
            requestPermissionForAlias("notifications", call, "notificationsCallback");
            return;
        }
        startServiceAndResolve(call, title, subtitle, true);
    }

    @PluginMethod
    public void setState(PluginCall call) {
        boolean playing = "playing".equals(call.getString("state", "paused"));
        if (pendingStart != null) {
            // The service is not running yet, so this is only the state its start will use.
            pendingPlaying = playing;
        }
        try {
            PlaybackService.setPlaying(playing);
        } catch (Throwable t) {
            Log.w(TAG, "could not update the playback state", t);
        }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        // Cancel a start still waiting on the prompt. Otherwise the answer would start the
        // service after the reader already stopped, leaving an ongoing notification and a wake
        // lock with nothing playing behind them.
        PluginCall cancelled = pendingStart;
        clearPendingStart();
        if (cancelled != null) {
            cancelled.resolve();
        }
        try {
            PlaybackService.stop(getContext());
        } catch (Throwable t) {
            Log.w(TAG, "could not stop the playback service", t);
        }
        call.resolve();
    }

    @PermissionCallback
    private void notificationsCallback(PluginCall call) {
        PluginCall target = pendingStart;
        if (target == null) {
            // stop() (or the bridge going away) cancelled the waiting start and already resolved
            // it. There is nothing to begin, and the cancelled call must not be answered twice.
            return;
        }
        String title = pendingTitle;
        String subtitle = pendingSubtitle;
        boolean playing = pendingPlaying;
        clearPendingStart();
        startServiceAndResolve(target, title, subtitle, playing);
    }

    private void clearPendingStart() {
        pendingStart = null;
        pendingTitle = null;
        pendingSubtitle = null;
        pendingPlaying = true;
    }

    private void startServiceAndResolve(PluginCall call, String title, String subtitle, boolean playing) {
        try {
            PlaybackService.startFrom(getContext(), title, subtitle, playing);
        } catch (Throwable t) {
            // Includes BackgroundServiceStartNotAllowedException on Android 12+: the reader is
            // only in the background when the screen just locked, and the wake lock already
            // taken by the previous start covers the current sentence.
            Log.w(TAG, "could not start the playback service", t);
        }
        call.resolve();
    }

    // --------------------------------------------------------------------- permissions

    private boolean shouldAskForNotifications() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return false;
        }
        Context context = getContext();
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) {
            return false;
        }
        return !prefs().getBoolean(KEY_ASKED, false);
    }

    private void markNotificationAsked() {
        prefs().edit().putBoolean(KEY_ASKED, true).apply();
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // ------------------------------------------------------------------------ events

    @Override
    public void onPlaybackAction(String action) {
        if (action == null) {
            return;
        }
        // The service notifies from several threads (session callbacks, notification intents,
        // the noisy broadcast); the bridge wants its listener calls on the main thread.
        if (Looper.myLooper() == Looper.getMainLooper()) {
            emit(action);
        } else {
            mainHandler.post(() -> emit(action));
        }
    }

    private void emit(String action) {
        JSObject payload = new JSObject();
        payload.put("action", action);
        notifyListeners(EVENT_ACTION, payload);
    }
}
