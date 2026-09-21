#!/usr/bin/env python3
"""
Decode synthesized speech with the production grammar, on the desktop.

The phone and this script use the same Vosk model and the same grammar (read
from src/grammar.js), so what the recogniser does with chatter, noise and word
order can be measured here before anyone walks to a court. It writes cases.json;
score.mjs then runs the real parser over it.

Synthetic speech and synthetic babble: treat the numbers as directional. The
chatter is deliberately seeded with score words and mixed as loud as the voice,
which is far harsher than an earbud microphone next to the wearer's mouth.

  pip install vosk gTTS numpy      (gTTS needs the network; ffmpeg must be on PATH)
  python3 tools/probe/decode.py && node tools/probe/score.mjs
"""
import json, os, random, subprocess, sys, wave
from pathlib import Path

import numpy as np
from gtts import gTTS
from vosk import KaldiRecognizer, Model, SetLogLevel

ROOT = Path(__file__).resolve().parents[2]
MODEL = ROOT / "android/model-assets/model-ru"
WORK = Path(os.environ.get("PROBE_DIR", ROOT / "tools/probe/.cache"))
RATE = 16000

COMMANDS = [
    "счёт ноль пятнадцать", "счёт тридцать сорок", "счёт сорок пятнадцать", "счёт пятнадцать тридцать",
    "счёт ровно", "счёт больше", "счёт меньше", "счёт гейм", "счёт отмена",
    "счёт по нулям", "счёт по пятнадцати", "счёт пятнадцать все",
]
CHATTER = [
    "давай быстрее подавай уже мяч", "хороший удар отлично сыграли молодцы ребята",
    "какой счёт я не помню кто подаёт", "мяч был в ауте я точно видел", "подожди дай воды попить",
    "кто сегодня платит за корт", "у меня ракетка новая посмотри какая лёгкая",
    "надо играть ближе к сетке и не отходить назад", "вчера смотрел финал там был сумасшедший розыгрыш",
    "сорок минут осталось потом следующая пара", "пятнадцать человек записалось на турнир в субботу",
    "по моему он задел сетку", "ровно в шесть начинаем не опаздывай", "больше так не подавай пожалуйста",
    "тридцать градусов жара невозможно играть", "ноль шансов было достать этот мяч",
]


def grammar(name):
    js = f'import("{ROOT}/src/grammar.js").then(m => console.log(JSON.stringify(m.GRAMMARS.{name})))'
    return subprocess.run(["node", "-e", js], check=True, capture_output=True, text=True).stdout.strip()


def speak(text):
    WORK.mkdir(parents=True, exist_ok=True)
    stem = WORK / text.replace(" ", "_")
    wav = stem.with_suffix(".wav")
    if not wav.exists():
        gTTS(text, lang="ru").save(str(stem.with_suffix(".mp3")))
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(stem.with_suffix(".mp3")),
                        "-ar", str(RATE), "-ac", "1", "-af", "apad=pad_dur=1.0", str(wav)], check=True)
    with wave.open(str(wav), "rb") as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32)


def rms(x):
    return float(np.sqrt(np.mean(x ** 2)) + 1e-9)


def decode(model, samples, phrases):
    rec = KaldiRecognizer(model, RATE, phrases)
    rec.SetWords(True)
    pcm = np.clip(samples, -32768, 32767).astype(np.int16).tobytes()
    out = []
    for i in range(0, len(pcm), 6400):  # 0.2 s, as on the phone
        if rec.AcceptWaveform(pcm[i:i + 6400]):
            out.append(json.loads(rec.Result()))
    out.append(json.loads(rec.FinalResult()))
    return [r for r in out if r.get("text")]


def main():
    SetLogLevel(-1)
    if not (MODEL / "uuid").exists():
        sys.exit("Speech model missing. Run tools/fetch-model.sh first.")

    model = Model(str(MODEL))
    phrases = grammar("game")
    babble = np.concatenate([speak(t) for t in CHATTER])
    cases = []

    random.seed(1)
    for snr in ("clean", 10, 5, 0):
        for said in COMMANDS:
            voice = speak(said)
            if snr == "clean":
                mix = voice
            else:
                at = random.randint(0, len(babble) - len(voice) - 1)
                noise = babble[at:at + len(voice)]
                mix = voice + noise * (rms(voice) / rms(noise)) / (10 ** (snr / 20))
            cases.append({"kind": "command", "said": said, "snr": snr, "results": decode(model, mix, phrases)})

    half = len(babble) // 2
    for name, audio in (("one talker", babble), ("two talkers", babble[:half] + babble[half:half * 2])):
        cases.append({"kind": "chatter", "said": name, "seconds": round(len(audio) / RATE),
                      "results": decode(model, audio, phrases)})

    out = WORK / "cases.json"
    out.write_text(json.dumps(cases, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(cases)} cases -> {out}")


if __name__ == "__main__":
    main()
