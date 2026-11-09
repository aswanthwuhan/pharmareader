import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.aurapharmlab.pharmareader',
  appName: 'PharmaReader',
  webDir: 'dist',
  plugins: {
    // Article import fetches arbitrary sites; native HTTP avoids the WebView CORS wall.
    // Off: the global fetch patch base64-encodes bodies over the bridge, which breaks 100+ MB model downloads.
    // Web-article import calls CapacitorHttp explicitly instead.
    CapacitorHttp: { enabled: false },
  },
  android: {
    allowMixedContent: false,
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
