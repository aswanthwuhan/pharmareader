package com.aurapharmlab.pharmareader.playback;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.graphics.drawable.Icon;
import android.media.AudioManager;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import com.aurapharmlab.pharmareader.MainActivity;
import com.aurapharmlab.pharmareader.R;

/**
 * Keeps the reader alive while the screen is locked: a {@code mediaPlayback} foreground
 * service, a media-style notification with previous / play-pause / next / stop, a
 * {@link MediaSession} for lock-screen and headset buttons, and a partial wake lock.
 *
 * <p>Audio itself is never played here — the WebView's Chromium media stack owns the sound.
 * This service only (a) keeps the process out of the freeze/kill the OS applies to a cached
 * app with the screen off, so the next sentence can still be synthesised, and (b) forwards
 * button presses to JavaScript as {@link ActionListener} events, which the reader acts on.
 * Two consequences matter:
 *
 * <ul>
 *   <li>Audio focus is deliberately <em>not</em> requested. Chromium requests it for its own
 *   audio element; a second request from this process would make the two fight and one of
 *   them would pause the other.</li>
 *   <li>The wake lock is held only while playing, always with a timeout and renewed, because
 *   a partial wake lock has no "forgotten lock" recovery on its own.</li>
 * </ul>
 */
public class PlaybackService extends Service {

    private static final String TAG = "PlaybackService";

    /** Show the notification, refresh its title/subtitle, start playing. */
    public static final String ACTION_START = "com.aurapharmlab.pharmareader.playback.START";
    /** A notification button was pressed; {@link #EXTRA_BUTTON} says which. */
    public static final String ACTION_BUTTON = "com.aurapharmlab.pharmareader.playback.BUTTON";

    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_SUBTITLE = "subtitle";
    public static final String EXTRA_PLAYING = "playing";
    public static final String EXTRA_BUTTON = "button";

    private static final String CHANNEL_ID = "reading_aloud";
    private static final String CHANNEL_NAME = "Reading aloud";
    private static final int NOTIFICATION_ID = 4210;

    // A partial wake lock is only ever held for a bounded time: the OS has no way to reclaim a
    // forgotten one, so it is taken for ten minutes and renewed every nine while still playing.
    private static final long WAKE_LOCK_TIMEOUT_MS = 10 * 60 * 1000L;
    private static final long WAKE_LOCK_RENEW_MS = 9 * 60 * 1000L;

    private static final int REQUEST_OPEN = 4201;
    private static final int REQUEST_PREVIOUS = 4202;
    private static final int REQUEST_PLAY_PAUSE = 4203;
    private static final int REQUEST_NEXT = 4204;
    private static final int REQUEST_STOP = 4205;

    /** Receives the button presses for the plugin to forward to JavaScript. */
    public interface ActionListener {
        void onPlaybackAction(String action);
    }

    /** The running instance (there is at most one; the process hosts the WebView too). */
    private static volatile PlaybackService instance;
    /** Set by the plugin while it is alive; null when the web layer is gone. */
    private static volatile ActionListener listener;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private MediaSession session;
    private PowerManager.WakeLock wakeLock;
    /** Set in onDestroy, so a state update queued around the teardown cannot wake the device. */
    private boolean destroyed;

    private String title = "Reading aloud";
    private String subtitle = "";
    private boolean playing = true;

    public static void setActionListener(ActionListener actionListener) {
        listener = actionListener;
    }

    /** Start (or refresh) the service in the playing state. */
    public static void startFrom(Context context, String title, String subtitle) {
        startFrom(context, title, subtitle, true);
    }

    /**
     * Start (or refresh) the service, arriving already paused when the reader moved on while
     * the notification prompt was up: otherwise the answer to the prompt would bring up an
     * ongoing notification and a wake lock for reading that is no longer happening.
     */
    public static void startFrom(Context context, String title, String subtitle, boolean playing) {
        Intent intent = new Intent(context, PlaybackService.class)
                .setAction(ACTION_START)
                .putExtra(EXTRA_TITLE, title)
                .putExtra(EXTRA_SUBTITLE, subtitle == null ? "" : subtitle)
                .putExtra(EXTRA_PLAYING, playing);
        // minSdk 26: startForegroundService is always available and always paired with a
        // startForeground() call in onStartCommand.
        context.startForegroundService(intent);
    }

    /**
     * Mirror play/pause in the notification and the wake lock. A no-op when the service is not
     * running: there is nothing to keep awake and no notification to update.
     */
    public static void setPlaying(boolean nowPlaying) {
        PlaybackService current = instance;
        if (current != null) {
            current.applyState(nowPlaying);
        }
    }

    /** Stop the service, its notification and its wake lock. Safe when it is not running. */
    public static void stop(Context context) {
        context.stopService(new Intent(context, PlaybackService.class));
    }

    // ------------------------------------------------------------------- lifecycle

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        createChannel();
        createSession();
        registerNoisyReceiver();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || intent.getAction() == null) {
            // Restarted without an intent: there is no reader state to mirror, so do not linger.
            stopSelf();
            return START_NOT_STICKY;
        }
        String action = intent.getAction();
        if (ACTION_START.equals(action)) {
            String newTitle = intent.getStringExtra(EXTRA_TITLE);
            if (newTitle != null && !newTitle.isEmpty()) {
                title = newTitle;
            }
            String newSubtitle = intent.getStringExtra(EXTRA_SUBTITLE);
            subtitle = newSubtitle == null ? "" : newSubtitle;
            updateMetadata();
            startInForeground();
            applyState(intent.getBooleanExtra(EXTRA_PLAYING, true));
        } else if (ACTION_BUTTON.equals(action)) {
            String button = intent.getStringExtra(EXTRA_BUTTON);
            if (button != null) {
                emit(button);
                if ("stop".equals(button)) {
                    stopSelf();
                    return START_NOT_STICKY;
                }
            }
            // A notification action can start the service again after a kill; keep it visible.
            startInForeground();
        }
        // Not sticky: the web layer drives playback, so a restart with no reader behind it
        // would only leave a notification that controls nothing.
        return START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // The task (and with it the WebView) is gone, so nothing is being read any more.
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        instance = null;
        destroyed = true;
        handler.removeCallbacksAndMessages(null);
        releaseWakeLock();
        try {
            unregisterReceiver(noisyReceiver);
        } catch (IllegalArgumentException ignored) {
            // Not registered (already torn down): nothing to undo.
        }
        if (session != null) {
            session.setActive(false);
            session.release();
            session = null;
        }
        stopForeground(STOP_FOREGROUND_REMOVE);
        NotificationManager manager =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.cancel(NOTIFICATION_ID);
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ------------------------------------------------------------------- notification

    private void createChannel() {
        NotificationManager manager =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Playback controls while reading aloud");
        channel.setShowBadge(false);
        channel.enableVibration(false);
        channel.setSound(null, null);
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        manager.createNotificationChannel(channel);
    }

    private void startInForeground() {
        try {
            Notification notification = buildNotification();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
        } catch (Throwable t) {
            // A background start restriction (Android 12+) rejects startForeground; the reader
            // keeps working in the foreground, so dropping the service is the graceful exit.
            Log.e(TAG, "could not start the playback service in the foreground", t);
            stopSelf();
        }
    }

    private void updateNotification() {
        NotificationManager manager =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.notify(NOTIFICATION_ID, buildNotification());
        }
    }

    private Notification buildNotification() {
        Notification.Builder builder = new Notification.Builder(this, CHANNEL_ID)
                .setContentTitle(title)
                .setContentText(subtitle)
                .setSmallIcon(R.drawable.ic_playback)
                .setContentIntent(openAppIntent())
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setCategory(Notification.CATEGORY_TRANSPORT)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setActions(
                        action(android.R.drawable.ic_media_previous, "Previous",
                                REQUEST_PREVIOUS, "previous"),
                        action(playing
                                        ? android.R.drawable.ic_media_pause
                                        : android.R.drawable.ic_media_play,
                                playing ? "Pause" : "Play",
                                REQUEST_PLAY_PAUSE, playing ? "pause" : "play"),
                        action(android.R.drawable.ic_media_next, "Next", REQUEST_NEXT, "next"),
                        action(android.R.drawable.ic_menu_close_clear_cancel, "Stop",
                                REQUEST_STOP, "stop"));
        // Attaching the session token is what makes the lock screen and headset buttons work
        // alongside the notification's own action buttons.
        Notification.MediaStyle style = new Notification.MediaStyle()
                .setMediaSession(session.getSessionToken())
                .setShowActionsInCompactView(0, 1, 2);
        builder.setStyle(style);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        }
        return builder.build();
    }

    private Notification.Action action(int iconRes, String label, int requestCode, String button) {
        Intent intent = new Intent(this, PlaybackService.class)
                .setAction(ACTION_BUTTON)
                .putExtra(EXTRA_BUTTON, button);
        PendingIntent pending = PendingIntent.getService(this, requestCode, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Action.Builder(
                Icon.createWithResource(this, iconRes), label, pending).build();
    }

    private PendingIntent openAppIntent() {
        Intent intent = new Intent(this, MainActivity.class)
                .setAction(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(this, REQUEST_OPEN, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    // --------------------------------------------------------------------- media session

    private void createSession() {
        session = new MediaSession(this, "PharmaReader:Playback");
        session.setCallback(new MediaSession.Callback() {
            @Override
            public void onPlay() {
                emit("play");
            }

            @Override
            public void onPause() {
                emit("pause");
                // Drop the notification and the wake lock right away: if the web layer never
                // answers (a dead page, a finished book), a pause must not keep the device awake.
                // Play is left to JavaScript, which calls setState({state:'playing'}) itself.
                applyState(false);
            }

            @Override
            public void onSkipToNext() {
                emit("next");
            }

            @Override
            public void onSkipToPrevious() {
                emit("previous");
            }

            @Override
            public void onStop() {
                emit("stop");
                stopSelf();
            }
        });
        session.setActive(true);
        updatePlaybackState();
    }

    private void updateMetadata() {
        if (session == null) {
            return;
        }
        session.setMetadata(new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, subtitle)
                .build());
    }

    private void updatePlaybackState() {
        if (session == null) {
            return;
        }
        PlaybackState.Builder state = new PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY
                        | PlaybackState.ACTION_PAUSE
                        | PlaybackState.ACTION_PLAY_PAUSE
                        | PlaybackState.ACTION_SKIP_TO_NEXT
                        | PlaybackState.ACTION_SKIP_TO_PREVIOUS
                        | PlaybackState.ACTION_STOP)
                .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                        PlaybackState.PLAYBACK_POSITION_UNKNOWN, playing ? 1f : 0f);
        session.setPlaybackState(state.build());
    }

    // ------------------------------------------------------------------------ play state

    /** Called from the plugin (main thread) and from onStartCommand. */
    private void applyState(final boolean nowPlaying) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            handler.post(() -> applyState(nowPlaying));
            return;
        }
        if (destroyed) {
            // The plugin thread queued this just as the service was torn down; taking the wake
            // lock here would hold it (and keep renewing it) with no service left to release it.
            return;
        }
        playing = nowPlaying;
        updatePlaybackState();
        if (playing) {
            acquireWakeLock();
        } else {
            releaseWakeLock();
        }
        updateNotification();
    }

    private final Runnable renewWakeLock = new Runnable() {
        @Override
        public void run() {
            if (playing) {
                acquireWakeLock();
            }
        }
    };

    private void acquireWakeLock() {
        try {
            PowerManager manager = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (manager == null) {
                return;
            }
            if (wakeLock == null) {
                wakeLock = manager.newWakeLock(
                        PowerManager.PARTIAL_WAKE_LOCK, "PharmaReader:playback");
                wakeLock.setReferenceCounted(false);
            }
            wakeLock.acquire(WAKE_LOCK_TIMEOUT_MS);
            handler.removeCallbacks(renewWakeLock);
            handler.postDelayed(renewWakeLock, WAKE_LOCK_RENEW_MS);
        } catch (Throwable t) {
            // A missing WAKE_LOCK permission or a vendor policy: playback still works, it just
            // may be frozen with the screen off.
            Log.w(TAG, "could not take the playback wake lock", t);
        }
    }

    private void releaseWakeLock() {
        handler.removeCallbacks(renewWakeLock);
        try {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
            }
        } catch (Throwable t) {
            Log.w(TAG, "could not release the playback wake lock", t);
        }
    }

    // ------------------------------------------------------------------ noisy headphones

    /**
     * Unplugging headphones fires ACTION_AUDIO_BECOMING_NOISY. Pausing here (through
     * JavaScript) keeps a ward from hearing a textbook read out loud.
     */
    private final BroadcastReceiver noisyReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction())) {
                emit("pause");
                applyState(false);
            }
        }
    };

    private void registerNoisyReceiver() {
        IntentFilter filter = new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(noisyReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(noisyReceiver, filter);
        }
    }

    // ----------------------------------------------------------------------------- events

    private static void emit(String action) {
        ActionListener current = listener;
        if (current != null) {
            current.onPlaybackAction(action);
        }
    }
}
