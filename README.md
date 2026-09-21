# Padel Audio

A courtside padel scoreboard for Android, scored by touch **and by voice**. Wear
Bluetooth earbuds, say «счёт» and then the score as you would call it on court,
server first — «счёт ноль пятнадцать» — and the phone's screen follows.

Successor to [d10_padel](https://github.com/norom/d10_padel): the same scoring
engine and screen, with the remote control replaced by speech recognised on the
phone (Vosk, Russian, closed vocabulary). Nothing leaves the device and the app
has no internet permission.

**Status:** everything is built and tested off the phone; **nothing has been tried on
a phone or a court yet.** The next step is the on-device spike in the design document
(earbud microphone, recognition in real noise, Bluetooth range), which decides whether
this approach holds — the procedure is in [`docs/on-court-spike.md`](docs/on-court-spike.md). The design, the measurements behind it and the milestones are in
[`docs/superpowers/specs/2026-09-21-padel-audio-design.md`](docs/superpowers/specs/2026-09-21-padel-audio-design.md).

## Layout

| Path | What it is |
| --- | --- |
| `src/match.js`, `src/americano.js` | Pure scoring engines. A match is the list of who won each point; everything else is derived |
| `src/serve.js` | Who is serving, derived from the point list and who served first |
| `src/grammar.js` | The closed list of phrases (and decoy words) the recogniser may hear |
| `src/voice-parse.js` | Heard words → a command: «счёт» followed at once by one complete phrase |
| `src/reconcile.js` | A called score → a new point list, by searching the next two points through the real engine |
| `src/session.js` | The match in progress and snapshot undo |
| `src/voice.js` | The voice policy: which tone, confirm-by-repeat, echo guard, grammar switching |
| `src/storage.js` | Persistence of the point list, first server and format |
| `src/ui.js`, `src/app.js`, `index.html`, `styles.css` | The screen and its wiring |
| `android/` | Kotlin host: serves the files above from the APK, routes audio to the earbud mic (`AudioRouter`), runs Vosk (`VoiceEngine`), plays the tones (`Tones`) |

## Speaking to it

Say «счёт», then the score **server first**, as it is called on court.

| Say | Means |
| --- | --- |
| «счёт ноль пятнадцать» | server 0, receiver 15 |
| «счёт по нулям / по пятнадцати / по тридцати», «счёт пятнадцать все» | level scores |
| «счёт ровно», «счёт сорок сорок» | deuce |
| «счёт больше» / «счёт меньше» | advantage server / receiver |
| «счёт гейм» | the team on game point wins the game |
| «счёт отмена» | take back the last change |
| «счёт три два» | in a tie-break: plain numbers, server first |

In the ear: one blip = done · two rising notes = that is a leap from the board, say it
again to apply · two flat notes = understood but impossible · silence = not taken as a
command. A forgotten «гейм» is inferred from the next call.

## Test

```sh
npm test
```

## Build

```sh
tools/fetch-model.sh          # once: the 46 MB Russian speech model
cd android
./gradlew assembleDebug
# app/build/outputs/apk/debug/app-debug.apk  (~60 MB)
```

Add `-Pemulator` to include the x86_64 library for an emulator.

Needs JDK 17 and an Android SDK with platform 34; point `android/local.properties`
at it with `sdk.dir=/path/to/android-sdk`. Requires Android 12 or newer.
