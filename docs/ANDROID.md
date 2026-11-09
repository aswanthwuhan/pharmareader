# Android build (PharmaReader)

## Prerequisites
- **JDK 21** — system Java is 26 and Gradle 8.14 / AGP 8.13 reject it; use the JDK bundled with
  Android Studio: `C:\Program Files\Android\Android Studio\jbr` (openjdk 21.0.9, verified).
- **Android SDK** — `ANDROID_HOME=C:\Users\albit\AppData\Local\Android\Sdk` (build-tools 36.0.0,
  platforms android-36). Android Studio itself is not needed to build.
- `minSdk 24` (WebView WebAssembly SIMD/threads), `compileSdk`/`targetSdk 36` → `android/variables.gradle`.
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
APK: `android\app\build\outputs\apk\debug\app-debug.apk` (~4.2 MB)

## Debugging the WebView
Debug builds call `WebView.setWebContentsDebuggingEnabled(true)` in `MainActivity`, guarded by
`FLAG_DEBUGGABLE` so release builds leave it off. Enable USB debugging, plug in, open
`chrome://inspect/#devices` in desktop Chrome and *inspect* the PharmaReader WebView; the JS console
also shows in `adb logcat -s Capacitor/Console`.

## Native notes
- `largeHeap="true"` + `hardwareAccelerated="true"` in the manifest (Kokoro/ONNX peaks near 800 MB).
- INTERNET only; mixed content and cleartext HTTP are off, so an `http://` Kokoro server needs a network-security-config entry.
