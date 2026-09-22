# Callscore (née padel_audio) — voice-scored padel scoreboard (base plan)

*Status 2026-09-22: M1–M5 done and confirmed on the phone (v0.1.0). M6 waits for a real match.
Added since the plan: changing ends («счёт смена», ⇄, and automatically by the rules —
`src/ends.js`), Team B recoloured orange, a native trace in the voice log, a route ladder
for the earbud mic, and a debug audio dump/replay.*

## Context

`../d10` is a courtside padel scoreboard APK (vanilla-JS web app in a Kotlin WebView
wrapper) that was meant to be scored from a Bluetooth camera remote. The remote's A/B
buttons turned out to be unreachable in firmware, so matches were scored by press-count
on one button. `padel_audio` is the next attempt at hands-free scoring: **the same
scoreboard and touch buttons, plus Russian voice commands through the mic of Bluetooth
earbuds** (Panasonic RB-F10, classic Bluetooth HFP — was Xiaomi OpenWear Stereo in the original brief). Wake word «счёт», then the score as called on court:
«счёт ноль пятнадцать».

`/root/python_projects/padel_audio` is empty today (no git). This is the base design for
the whole app.

## Decisions made

| Topic | Decision |
| --- | --- |
| Score order in a call | **Server first**, as on a real court → the app tracks who serves (new; d10 has no serve concept) |
| Speech recognition | **On-device Vosk** `vosk-model-small-ru-0.22` bundled in the APK, **closed phrase grammar**. No cloud, no Claude at match time — a closed grammar can only emit valid phrases, so there is nothing to interpret. The parser takes plain text, so a Claude fallback can be added later behind the same seam if real matches show a need |
| Audio capture | App records **itself** (own `AudioRecord` → Vosk); only then can it force the earbud mic instead of the phone mic |
| Ear feedback | **Short tones**, no TTS: *ok* blip = applied · *fail* buzz = heard «счёт» but can't apply · *confirm* tone = "implausible, say it again to apply" (added by the stress-test, see policy below) |
| Touch input | Unchanged from d10: `+ Team A` / `Undo` / `+ Team B` bottom buttons |
| D10 remote | **Dropped entirely** (BleRemote, MediaSession, press-count chain, volume-key capture). Removes the audio-focus conflict and frees the volume keys for tone volume |
| Formats | Voice for tennis/padel only in v1; Americano stays touch-only (voice disabled) |
| Target phone | **Galaxy S22 Ultra** (Android 12+) → `minSdk 31`, `arm64-v8a` only, modern `setCommunicationDevice` routing, no legacy SCO branch. Personal app: one user, one phone |

## Architecture

Same shape as d10: pure node-tested JS core · thin DOM layer · thin Kotlin host.
Voice is one more input channel that ends where touch does.

```
earbud mic ─▶ AudioRouter ─▶ VoiceEngine (AudioRecord 16 kHz → Vosk phrase grammar)
                                   │ evaluateJavascript
                                   ▼
                 window.padelVoice.final({vosk, rms, grammar, t})
                                   │
   voice-parse ─▶ command ─▶ reconcile ─▶ session (points + undo history) ─▶ storage + render
        │                        │                         ▲
        │                        └─▶ PadelNative.tone(ok|fail|confirm)
        └ strict span rule                touch +A / +B / Undo ─┘
```

### Reused from d10
- **Unchanged, with tests:** `src/match.js` (`derive`, `addPoint`, `pointLabel`), `src/americano.js` — 34 tests
- **Adapted:** `src/storage.js` — remove `bindings` (woven through `EMPTY`, `parse`, `saveBindings` and 4 tests), add `firstServer`, new key, `saveMatch({points, firstServer})`
- **Adapted:** `index.html`, `styles.css`, `src/ui.js`, `src/app.js` — cut everything that imports `input.js` (router, press-chain, bindings sheet, BLE status, `logInput`); reuse the `#netBadge` "pending" styling for the *heard…* badge and `.input-log` styling for the event log
- **Adapted:** `android/` — Gradle wrapper, `stageWebApp` copy task, `WebViewAssetLoader` host, immersive + keep-screen-on. `BleRemote.kt` is not copied; `dispatchKeyEvent`, MediaSession and audio-focus code are deleted
- **Dropped:** `src/input.js` (+43 tests), `sw.js`, `manifest.webmanifest`, `tools/d10-probe.html`

### New pure JS modules (TDD, `node --test`)
- **`src/serve.js`** — `serverAt(points, firstServer) → "A"|"B"`. No list walking:
  games played = Σ completed-set games + current games; even → first server. In a
  tie-break flip when `floor((p+1)/2)` is odd (p = tie-break points played). The tie-break
  counts as one game, which yields the correct next-set server for free.
- **`src/grammar.js`** — `GRAMMARS = { game: string[], tiebreak: string[] }`, the single
  source of truth: the command phrases, **plus ~140 decoy filler words**, plus `"[unk]"`.
  JS sends the active list to native. Vosk treats the list as a **bag of words — it does
  not enforce phrase structure or word order** (measured, see *Desktop probe* below), so
  all structure is enforced by `voice-parse.js`. The decoys give chatter somewhere to go
  other than score words. Spelling must be **`счёт` with ё** — `счет` is not in the model
  vocabulary and would be silently dropped. Include both `все` and `всё`; parser normalises ё→е.
- **`src/voice-parse.js`**
  - `extractSpan(finalPayload) → {tokens, before, after, startMs, endMs} | null` — last «счёт» + complete phrase; a decoy or `[unk]` inside rejects
  - `parseCommand(tokens, {tieBreak}) →` `{kind:"score",server,receiver}` («ноль пятнадцать», «по нулям», «по пятнадцати», «тридцать все») · `{kind:"deuce"}` («ровно», «сорок сорок») · `{kind:"adv",who}` («больше»/«меньше») · `{kind:"game"}` · `{kind:"undo"}` («отмена») · `null`
- **`src/reconcile.js`** — `reconcile(points, firstServer, command, {maxForward=2}) → {points, tier:"apply"|"noop"|"confirm"} | {error:"ambiguous"|"impossible"|"over"}`
  - **Search short futures with the real engine** (changed from my draft's "always
    truncate and rebuild"): for every sequence `f` over {A,B} of length 0,1,2, derive
    `points+f`, take `serverAt(points+f)`, compare server-first labels with the call;
    shortest match wins. No duplicated scoring rules, and the depth *is* the plausibility
    window. Prototyped against d10's `match.js`: normal step, missed call, AD→deuce,
    AD→AD-other, **forgotten «гейм»** (40-15 → «пятнадцать ноль» = game + first point of
    the next game, with the server flipped) and tie-break server flips all resolve correctly.
  - Same score as now → `noop` (ok tone, no undo snapshot). Two shortest matches with
    different boards → `ambiguous`. «гейм» = the unique 1-point future that ends a game;
    none at deuce → fail (say «больше», then «гейм»).
  - **Confirm tier** (legal but not reachable in ≤2 points, e.g. a backward correction):
    rebuild the current game only — truncate to game start, append `min(a,b)` × "AB" +
    remainder (never passes through a won state), assert games/sets unchanged. Applied
    only when the identical command is repeated within 8 s.
- **`src/session.js`** — pure reducer over `{points, firstServer, history}`:
  `touchPoint`, `applyPoints`, `undo`, `newMatch(firstServer)`. Undo restores the previous
  point list (bounded 50) because one voice command may change several points; with empty
  history it falls back to d10's `slice(0,-1)`. History is not persisted.

### DOM layer
- **`src/voice.js`** — `createVoice({native, now, getSession, commit, ui, config})` →
  `{partial, final, status}` installed as `window.padelVoice`. Owns the
  confirm/dedupe state, event log, tone requests, grammar switch on tie-break enter/leave.
  Injected `native`/`now` make it node-testable.
- **`ui.js` / `index.html`** — serve marker on the serving half · mic indicator showing the
  *actually routed* device (earbuds + name / phone / loading / off) · *heard…* badge on
  partials, commit on final · first-server choice in the New-match sheet · diagnostics
  sheet with copyable **event log** (time, transcript, per-word conf, RMS, action).

### False-positive policy (v1)
1. A command is «счёт» **immediately followed by one complete phrase**, found anywhere in
   an utterance; the last such span wins. A decoy word or `[unk]` inside the span rejects it.
2. **No confidence gate.** In grammar mode Vosk reports conf = 1.0 for everything,
   including chatter force-aligned to score words (measured), so it carries no signal.
3. Tones: *ok* = applied · *confirm* = legal but implausible, repeat within 8 s to apply ·
   *fail* = a complete command was understood but cannot be applied (illegal / ambiguous /
   match over). **«счёт» followed by anything unparseable is silent** (logged only) —
   chatter says «какой счёт…» too often for that to buzz.
4. Tier 1 apply now: reachable in ≤2 points, «гейм», «отмена». Tier 2 confirm. Tier 3 fail.
5. Repeated «гейм»/«отмена» within 8 s of being applied → no-op + ok tone (no accidental double undo).
6. Log per-utterance RMS, word start/end times and the words either side of the span from
   day one; enforce only after on-court data. Candidates: near-field loudness of the
   wearer's own voice; "command embedded in running speech" (no pause either side).

### Desktop probe (2026-09-21) — what was measured before building
Same model (`vosk-model-small-ru-0.22`) on Linux, Google-TTS Russian speech, babble made of
16 chatter sentences deliberately seeded with score words («сорок минут», «ноль шансов»,
«какой счёт»), mixed at the *same kind of loudness* as the voice — far harsher than an
earbud mic, where the wearer is near-field. Synthetic speech, so treat as directional.

| Grammar | Rule | Recall clean / 10 dB / 5 dB / 0 dB | False commands in 103 s chatter |
| --- | --- | --- | --- |
| free-form (no grammar) | text contains command | 7 / 3 / 1 / 0 | — |
| commands only | «счёт»+phrase anywhere | 10 / 9 / 6 / 3 | 6 |
| commands + decoys | «счёт»+phrase anywhere | **10 / 9 / 6 / 3** | **1** |
| commands + decoys | command is the whole utterance | 10 / 5 / 1 / 1 | 0 |

- Closed vocabulary is decisively better than free-form in noise — the approach holds.
- «пятнадцать счёт ноль» and the incomplete «счёт ноль» decode verbatim: **no phrase
  structure**. «хороший удар отлично сыграли…» decoded as «отмена сорок [unk]» at conf 1.0.
- Decoys cost no recall and cut false commands 6 → 1. Whole-utterance matching removes the
  last one but halves recall in continuous babble, so it is not the v1 rule.
- Free-form even mishears clean commands («гейм» → «не им», «ровно» → «ровная»).

Known limit, no v1 fix: in a tie-break at 0-0 both «один ноль» and «ноль один» are plausible, so a wrong-order call silently scores the wrong team. Touch/«отмена» recover.

### Kotlin host (`android/app/src/main/java/com/norom/padelaudio/`)
- **`MainActivity.kt`** — trimmed d10 host; permission flow; start capture in `onStart`, stop in `onStop` (not `onPause`, which fires for dialogs); always clear the communication device and restore `MODE_NORMAL` on stop; `volumeControlStream = STREAM_VOICE_CALL`. Activity-bound — no foreground service (screen stays on, app stays in front).
- **`AudioRouter.kt`** — strict order: `MODE_IN_COMMUNICATION` → `setCommunicationDevice` (priority `TYPE_BLE_HEADSET`, `TYPE_BLUETOOTH_SCO`) → wait for `OnCommunicationDeviceChangedListener` (≤5 s) → only then create `AudioRecord` + `setPreferredDevice`. Ground truth is `AudioRecord.getRoutedDevice()`. Watchdog every 5 s and on routing events: re-assert device; restart the record after >3 s of all-zero samples. Fallback: phone mic.
- **`VoiceEngine.kt`** — `StorageService.unpack` model once (needs a `uuid` file in the asset dir); capture thread, always 16 kHz mono PCM16 (the model cannot take 8 kHz), source `VOICE_COMMUNICATION` (compare with `VOICE_RECOGNITION` in the spike), buffer ≥1 s; `Recognizer` with `setWords(true)` for word timings; grammar swap by **building a new `Recognizer`** on the capture thread — `setGrammar()` on a live recogniser aborts the process with `KaldiFatalError` ("Can't add grammar to already running recognizer"), found on the emulator. Never stop the record to pause; discard buffers instead (an idle mode owner loses the mode).
- **`Tones.kt`** — `AudioTrack` with `USAGE_VOICE_COMMUNICATION` (media usage is unreliable while SCO is up); 400–2000 Hz, distinguished by **pattern** not low pitch (open-ear buds have little bass). Gate capture for tone length + 300 ms, then `recognizer.reset()` — prevents a tone → false command → tone loop.

### Bridge contract
- **native → JS** `window.padelVoice && window.padelVoice.X(<quoted JSON>)`
  - `status` `{state:"off|no-permission|loading|listening|error", mic:"earbuds|phone|none", device, deviceType, grammar, rtf, battery, message}`
  - `partial` `{text}` — only when the text changes
  - `final` `{vosk:<raw Vosk result>, rms, grammar, t}`
- **JS → native** `PadelNative` (`@JavascriptInterface`; hop off the bridge thread): `ready()`, `copy(text)`, `tone("ok"|"fail"|"confirm")`, `setGrammar(name, phrasesJson)`, `setVoiceEnabled(on)`

### Build
- `applicationId`/`namespace` `com.norom.padelaudio`; `minSdk 31`; `ndk { abiFilters += "arm64-v8a" }`
- Deps: `androidx.webkit:webkit:1.8.0`, `net.java.dev.jna:jna:5.18.1@aar`, `com.alphacephei:vosk-android:0.3.75@aar` (compatible with d10's AGP 8.1.4 / compileSdk 34; first build needs network)
- Model: `tools/fetch-model.sh` downloads the 46 MB zip into gitignored `android/model-assets/model-ru/` and writes `uuid`; second assets srcDir; staging task fails with a clear message if `model-ru/uuid` is missing. No `noCompress` (files are copied out anyway). APK ≈ 58 MB, +91 MB unpacked on device.
- Manifest: `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `BLUETOOTH_CONNECT` (denial non-fatal). **No `INTERNET`.** Keep `configChanges` so rotation doesn't restart the engine.

## Milestones (risk first)

1. **M1 Scaffold** — `git init`; copy + strip d10 as above; fix `storage.js`; touch scoring works in an APK. Save this design to `docs/superpowers/specs/2026-09-21-padel-audio-design.md`; record the design decisions in project memory.
2. **M2 Voice spike on the S22 Ultra**, built inside the diagnostics sheet so it is kept. Checks: routed device is SCO/BLE and audio is non-zero · `VOICE_COMMUNICATION` vs `VOICE_RECOGNITION` · mSBC 16 kHz not CVSD (`dumpsys bluetooth_manager`) · phrase grammar enforces word order · «счёт» decodes · final-result latency · tones audible, capture gating works · **Bluetooth range test on a real court** (glass + bodies block 2.4 GHz; the most likely real-world failure). **Go/no-go: ≥18 of 20 calls correct and 0 false commands in 5 min of nearby chatter.**
3. **M3 Serve tracking** — `serve.js`, first-server picker, serve marker. *(M3–M4 are pure node work and can proceed while M2 is tested on court.)*
4. **M4 Core by TDD** — `grammar.js`, `voice-parse.js`, `reconcile.js`, `session.js`.
5. **M5 Wire-up** — `voice.js`, tones, confirm/dedupe, tie-break grammar switch.
6. **M6 Tuning** from the event log after real matches: RMS gate, embedded-in-speech rule, forced-final on a stable partial only if finals arrive >1.5 s late.

**M2 result (2026-09-22, S22 Ultra on Android 16, Panasonic RB-F10):** earbud mic routes and
«счёт ноль пятнадцать» scores the board. Two phone-only findings on the way: `setGrammar()`
on a live recogniser aborts the process (recreate it instead), and registering an
`AudioDeviceCallback` is answered at once with the whole device list (ignore it, or the
recorder restarts forever). The go/no-go count and the range test are still to be done.

If M2 fails go/no-go, stop and revisit the recognition approach before M5 — M1, M3, M4 remain valid for any recogniser because the seam is plain text.

## Verification

- `cd /root/python_projects/padel_audio && npm test` — carried-over match/americano/storage suites plus:
  - `serve.test.js` — game alternation; tie-break pattern S,O,O,S,S; next set after a tie-break; third set
  - `voice-parse.test.js` — every `GRAMMARS` phrase parses; ё/е; «по нулям/пятнадцати/тридцати»; «сорок сорок» = deuce; numerals only in tie-break; last-span rule; `[unk]` rejects; incomplete rejects
  - `reconcile.test.js` — each prototyped case above; deuce ambiguity; «гейм» at deuce and in tie-break; confirm-tier rebuild leaves games/sets unchanged; match over
  - `session.test.js` — one undo reverts a multi-point voice change; empty-history fallback; bound
  - `voice.test.js` (fake `native`/`now`) — silent ignore of «счёт» + garbage; 8 s dedupe; confirm by repeat and expiry; correct tone per outcome; `setGrammar` on tie-break enter/leave
- `tools/fetch-model.sh && cd android && ./gradlew assembleDebug`; APK ≈ 58 MB and `unzip -l` lists `assets/model-ru/uuid`.
- On-device: both permission prompts · mic indicator goes loading → earbuds (product name) → phone when buds are removed → recovers on reconnect · live transcript visible · each tone audible in the ear, volume keys adjust it, a tone causes no false command · background/resume restores routing · incoming phone call and recovery · battery % over a 30-min soak · **a full set scored by voice only**, including a forgotten «гейм», a correction by repeat, and «отмена» · touch buttons work throughout.
