# The on-court spike

Everything else in this repository has been tested without a phone. This is the part that
cannot be: whether the earbud microphone can be captured, whether recognition holds up in
real court noise, and whether Bluetooth reaches from the player to a phone at the side of
the court. **Do it before trusting the app with a match.** It takes about twenty minutes.

Open the **Voice** sheet (top bar) and keep it open for steps 1–4: it shows which
microphone is live and everything that was heard. **Copy report** puts the whole log on
the clipboard — paste it into a message to yourself after each session; it is the only
record of what happened.

## 1. At home, earbuds in (5 min)

| Check | Expect | If not |
| --- | --- | --- |
| First launch | Two permission prompts: microphone, nearby devices | Microphone refused → voice is off; allow it in Settings |
| Voice sheet, first line | `loading` for a few seconds (first run copies the model), then `listening` | `error — …` says why |
| Second line | `Earbuds: <name of the buds>`, and the dot on the **Voice** button is yellow-green | `Phone microphone` / amber dot → the route was refused. Note the phone's Android version and the log; this is the main thing the spike exists to find |
| Say «счёт ноль пятнадцать» | One blip in the ear, the receiver's side shows 15, log line `apply` | Nothing in the log → not heard at all. Log line `ignored` with wrong words → misrecognised |
| Tone volume | Volume keys change it (call volume) | — |
| Say «счёт сорок ноль» from 0-0 | Two rising notes, board unchanged; say it again → blip, 40-0 | — |
| Say «счёт отмена» | Blip, board back | — |
| `decode load` | Well under 100 % (expect 10–30 %) | Near 100 % → the phone cannot keep up; report it |

**Check the link quality once**, with the app listening and a cable attached:

```sh
adb shell dumpsys bluetooth_manager | grep -iE "codec|msbc|cvsd|lc3|swb"
```

`mSBC` or `LC3` means 16 kHz and is what the model needs. `CVSD` is 8 kHz telephone
quality and recognition will be noticeably worse.

## 2. The go / no-go test (10 min, somewhere noisy — ideally at the court)

1. **Recall.** Say twenty calls at match pace, a mix of everything:
   «счёт пятнадцать ноль», «счёт тридцать пятнадцать», «счёт ровно», «счёт больше»,
   «счёт гейм», «счёт по нулям»… Count the blips.
2. **False commands.** Five minutes of ordinary talk with other people nearby — about the
   game, including the word «счёт» in normal sentences — without calling any score.
   Count the tones.

**Go:** at least 18 of 20 calls applied, and no tone at all during the five minutes.
**No-go:** copy the report. The `ignored` lines show what was heard instead, and the
`[before | command | after]` columns and the dB level on each line are what the next round
of tuning will use.

*Done 2026-09-22 across a flat: earbud mic routes, calls apply, range fine. Court noise is the open question.*

## 3. Range (5 min, on the court)

Phone where it will sit during a match. Walk to the far corner of your side, turn your back
to the phone, call a score. Then from behind a partner. Glass walls and bodies block
Bluetooth, and the call link retransmits very little.

| Check | Expect |
| --- | --- |
| Calls from the far corner | Still applied |
| The Voice dot during play | Stays yellow-green. Amber means the link dropped and the phone's own mic took over |

## 4. A soak (in the background of a real session)

Leave it running for a full 1.5 h session, scoring by voice. Afterwards note: battery used,
whether the dot ever went amber, whether it was still listening at the end, and how many
corrections by touch were needed. Copy the report before closing the app — the log lives in
memory only.

## What the log lines mean

```
21:04:17  apply          «счёт ноль пятнадцать»  [· | ноль пятнадцать | ·]  -19 dB
```

time · what was done · what Vosk heard · [word before | the command | word after] · loudness.

| Action | Meaning |
| --- | --- |
| `apply` | Applied: one or two points on from the board |
| `noop` | The board already said that |
| `confirm-asked` / `confirmed` | A leap; applied only on the repeat |
| `undo`, `echo` | «отмена»; a repeat of «гейм»/«отмена» within 8 s, deliberately not applied twice |
| `ignored` | No command in the utterance — silent |
| `impossible`, `ambiguous`, `over`, `nothing-to-undo` | Understood, refused — two flat notes |
| `swap` | «смена»: the board mirrored |
| `stale-grammar` | Decoded while switching between game and tie-break words; dropped |
| `native …` | The phone's own account: which route to the earbuds was taken, what the recorder was given, why it stopped |
