import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.aurapharmlab.pharmareader',
  appName: 'PharmaReader',
  webDir: 'dist',
  plugins: {
    // Article import fetches arbitrary sites; native HTTP avoids the WebView CORS wall.
    CapacitorHttp: { enabled: true },
  },
  android: {
    allowMixedContent: false,
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
