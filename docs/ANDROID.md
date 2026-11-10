# Android build (PharmaReader)

## Prerequisites
- **JDK 21** — system Java is 26 and Gradle 8.14 / AGP 8.13 reject it; use the JDK bundled with
  Android Studio: `C:\Program Files\Android\Android Studio\jbr` (openjdk 21.0.9, verified).
- **Android SDK** — `ANDROID_HOME=C:\Users\albit\AppData\Local\Android\Sdk` (build-tools 36.0.0,
  platforms android-36). Android Studio itself is not needed to build.
- `minSdk 26` (Android 8.0; WebView 110+), `compileSdk`/`targetSdk 36` → `android/variables.gradle`.
- `pnpm install` once; only `dist/` is packaged, so build the web app first.

## Build → APK
```powershell
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
pnpm build
pnpm exec cap sync android                    # dist/ -> android/app/src/main/assets/public
cd android; .\gradlew.bat assembleDebug       # first run downloads Gradle 8.14.3
adb install -r app\build\outputs\apk\debug\app-debug.apk
adb shell am start -n com.aurapharmlab.pharmareader/.MainActivity
```
APK: `android\app\build\outputs\apk\debug\app-debug.apk` (~105 MB: sherpa-onnx native libraries for arm64, armeabi-v7a and, in debug only, x86_64).

## Release signing
Releases are still debug-signed so they install over earlier builds without losing data.
Moving to a release key changes the signature, and Android then refuses the update: the
app must be uninstalled, which deletes IndexedDB. Before switching, export a backup
(Settings → Backup, with books), install the release build, and import it.

To enable release signing, create a keystore outside the repo and add
`android/keystore.properties` (gitignored) with `storeFile` (forward slashes), `storePassword`,
`keyAlias` and `keyPassword`; `assembleRelease` then signs with it. Without the file the
release build stays unsigned. Keep a copy of the keystore: losing it means no further updates.

## Debugging the WebView
Debug builds call `WebView.setWebContentsDebuggingEnabled(true)` in `MainActivity`, guarded by
`FLAG_DEBUGGABLE` so release builds leave it off. Enable USB debugging, plug in, open
`chrome://inspect/#devices` in desktop Chrome and *inspect* the PharmaReader WebView; the JS console
also shows in `adb logcat -s Capacitor/Console`.

## Native notes
- `largeHeap="true"` + `hardwareAccelerated="true"` in the manifest (Kokoro/ONNX peaks near 800 MB).
- INTERNET only; mixed content and cleartext HTTP are off, so an `http://` Kokoro server needs a network-security-config entry.
- Speech speed (threads, execution providers, why GPU and multi-threaded WASM are unavailable) is measured and written up in [PERFORMANCE.md](PERFORMANCE.md); `Kokoro.load` accepts `provider: "cpu" | "xnnpack" | "nnapi"` and reports the one in use.
