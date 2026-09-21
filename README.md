# Padel Audio

A courtside padel scoreboard for Android, scored by touch **and by voice**. Wear
Bluetooth earbuds, say «счёт» and then the score as you would call it on court,
server first — «счёт ноль пятнадцать» — and the phone's screen follows.

Successor to [d10_padel](https://github.com/norom/d10_padel): the same scoring
engine and screen, with the remote control replaced by speech recognised on the
phone (Vosk, Russian, closed vocabulary). Nothing leaves the device and the app
has no internet permission.

**Status:** milestone 1 of 6 — the scoreboard and touch scoring work; voice is not
wired in yet. The design and the milestones are in
[`docs/superpowers/specs/2026-09-21-padel-audio-design.md`](docs/superpowers/specs/2026-09-21-padel-audio-design.md).

## Layout

| Path | What it is |
| --- | --- |
| `src/match.js`, `src/americano.js` | Pure scoring engines. A match is the list of who won each point; everything else is derived |
| `src/storage.js` | Persistence of the point list, first server and format |
| `src/ui.js`, `src/app.js`, `index.html`, `styles.css` | The screen and its wiring |
| `android/` | Kotlin WebView host that serves the files above from the APK |

## Test

```sh
npm test
```

## Build

```sh
cd android
./gradlew assembleDebug
# app/build/outputs/apk/debug/app-debug.apk
```

Needs JDK 17 and an Android SDK with platform 34; point `android/local.properties`
at it with `sdk.dir=/path/to/android-sdk`. Requires Android 12 or newer.
