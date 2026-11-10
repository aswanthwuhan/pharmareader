package com.aurapharmlab.pharmareader;

import android.content.pm.ApplicationInfo;
import android.os.Bundle;
import android.webkit.WebView;

import com.aurapharmlab.pharmareader.kokoro.KokoroPlugin;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // chrome://inspect is only useful (and only safe) on debug builds; must run before the Bridge builds its WebView.
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
        // On-device Kokoro speech (sherpa-onnx). Must be registered before super.onCreate(),
        // which is where the Capacitor Bridge instantiates its plugin set.
        registerPlugin(KokoroPlugin.class);
        super.onCreate(savedInstanceState);
        // NOTE: cross-origin isolation (COOP/COEP on the local asset server) was tried here and
        // does not work in the Android WebView: the headers reach the page, but
        // self.crossOriginIsolated stays false and COEP is not enforced. See docs/PERFORMANCE.md.
    }
}
