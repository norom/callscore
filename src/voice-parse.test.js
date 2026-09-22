import test from "node:test";
import assert from "node:assert/strict";

import { COMMAND_PHRASES, GRAMMARS, WAKE } from "./grammar.js";
import { parseCommand, extractSpan } from "./voice-parse.js";

const GAME = { tieBreak: false };
const TIE = { tieBreak: true };

const score = (server, receiver) => ({ kind: "score", labels: [server, receiver] });

/** What Vosk hands over: one entry per word, with times in seconds. */
const heard = (text) =>
  text.split(" ").map((word, i) => ({ word, start: i * 0.5, end: i * 0.5 + 0.4, conf: 1 }));

// ------------------------------------------------------------------ phrases

test("a score is two point names, server first", () => {
  assert.deepEqual(parseCommand(["ноль", "пятнадцать"], GAME), score("0", "15"));
  assert.deepEqual(parseCommand(["сорок", "тридцать"], GAME), score("40", "30"));
});

test("level scores have their own words", () => {
  assert.deepEqual(parseCommand(["по", "нулям"], GAME), score("0", "0"));
  assert.deepEqual(parseCommand(["по", "пятнадцати"], GAME), score("15", "15"));
  assert.deepEqual(parseCommand(["по", "тридцати"], GAME), score("30", "30"));
  assert.deepEqual(parseCommand(["пятнадцать", "все"], GAME), score("15", "15"));
  assert.deepEqual(parseCommand(["тридцать", "всё"], GAME), score("30", "30"));
});

test("deuce and advantage are scores too", () => {
  assert.deepEqual(parseCommand(["ровно"], GAME), score("40", "40"));
  assert.deepEqual(parseCommand(["сорок", "сорок"], GAME), score("40", "40"));
  assert.deepEqual(parseCommand(["больше"], GAME), score("AD", "40"));
  assert.deepEqual(parseCommand(["меньше"], GAME), score("40", "AD"));
});

test("game and undo", () => {
  assert.deepEqual(parseCommand(["гейм"], GAME), { kind: "game" });
  assert.deepEqual(parseCommand(["отмена"], GAME), { kind: "undo" });
  assert.deepEqual(parseCommand(["гейм"], TIE), { kind: "game" });
  assert.deepEqual(parseCommand(["отмена"], TIE), { kind: "undo" });
});

test("changing ends is a command in any part of the match", () => {
  assert.deepEqual(parseCommand(["смена"], GAME), { kind: "swap" });
  assert.deepEqual(parseCommand(["стороны"], GAME), { kind: "swap" });
  assert.deepEqual(parseCommand(["смена"], TIE), { kind: "swap" });
});

test("a tie-break is called in plain numbers", () => {
  assert.deepEqual(parseCommand(["три", "два"], TIE), score("3", "2"));
  assert.deepEqual(parseCommand(["ноль", "один"], TIE), score("0", "1"));
  assert.deepEqual(parseCommand(["двенадцать", "одиннадцать"], TIE), score("12", "11"));
});

test("point names mean nothing in a tie-break, and numbers nothing outside one", () => {
  assert.equal(parseCommand(["пятнадцать", "тридцать"], TIE), null);
  assert.equal(parseCommand(["ровно"], TIE), null);
  assert.equal(parseCommand(["три", "два"], GAME), null);
});

test("half a score is not a score", () => {
  assert.equal(parseCommand(["ноль"], GAME), null);
  assert.equal(parseCommand(["по"], GAME), null);
  assert.equal(parseCommand([], GAME), null);
  assert.equal(parseCommand(["ноль", "пятнадцать", "сорок"], GAME), null);
});

test("the spelling of ё does not matter", () => {
  assert.deepEqual(parseCommand(["тридцать", "все"], GAME), parseCommand(["тридцать", "всё"], GAME));
});

test("every phrase the recogniser is given is one the parser understands", () => {
  for (const [name, options] of [["game", GAME], ["tiebreak", TIE]]) {
    for (const phrase of COMMAND_PHRASES[name]) {
      const [wake, ...tokens] = phrase.split(" ");
      assert.equal(wake, WAKE, phrase);
      assert.notEqual(parseCommand(tokens, options), null, `${name}: ${phrase}`);
    }
  }
});

// ------------------------------------------------------------------ grammars

test("the wake word is spelled the way the model knows it", () => {
  // «счет» is not in the model's vocabulary; Vosk would drop it without a word.
  assert.equal(WAKE, "счёт");
});

test("a grammar is its commands, decoys for chatter to land on, and [unk]", () => {
  for (const name of ["game", "tiebreak"]) {
    const grammar = GRAMMARS[name];
    assert.ok(grammar.includes("[unk]"));
    for (const phrase of COMMAND_PHRASES[name]) assert.ok(grammar.includes(phrase), phrase);
    assert.ok(grammar.length > COMMAND_PHRASES[name].length + 100, "decoys are present");
  }
});

test("no decoy is also a command word, or it would swallow the command", () => {
  for (const name of ["game", "tiebreak"]) {
    const commandWords = new Set(COMMAND_PHRASES[name].flatMap((phrase) => phrase.split(" ")));
    const decoys = GRAMMARS[name].filter(
      (entry) => entry !== "[unk]" && !COMMAND_PHRASES[name].includes(entry),
    );
    for (const decoy of decoys) assert.ok(!commandWords.has(decoy), `${name}: ${decoy}`);
  }
});

// -------------------------------------------------------------------- spans

test("a command is the wake word and a complete phrase", () => {
  const span = extractSpan(heard("счёт ноль пятнадцать"), GAME);

  assert.deepEqual(span.command, score("0", "15"));
  assert.deepEqual(span.tokens, ["ноль", "пятнадцать"]);
});

test("without the wake word nothing is a command", () => {
  assert.equal(extractSpan(heard("ноль пятнадцать"), GAME), null);
});

test("the recogniser does not enforce word order, so the parser does", () => {
  assert.equal(extractSpan(heard("пятнадцать счёт ноль"), GAME), null);
  assert.equal(extractSpan(heard("ноль счёт"), GAME), null);
});

test("the wake word in the middle of chatter is not a command", () => {
  assert.equal(extractSpan(heard("какой счёт я не помню"), GAME), null);
  assert.equal(extractSpan(heard("счёт по по счёт"), GAME), null);
  assert.equal(extractSpan(heard("счёт [unk] пятнадцать"), GAME), null);
});

test("a command is found inside a longer utterance, and its neighbours are reported", () => {
  const span = extractSpan(heard("ну что счёт тридцать пятнадцать да"), GAME);

  assert.deepEqual(span.command, score("30", "15"));
  assert.equal(span.before, "что");
  assert.equal(span.after, "да");
});

test("the longest phrase wins, so a score is not cut short", () => {
  assert.deepEqual(extractSpan(heard("счёт сорок сорок"), GAME).command, score("40", "40"));
  assert.deepEqual(extractSpan(heard("счёт ровно сорок"), GAME).command, score("40", "40"));
});

test("said twice, the last call stands — that is how a slip is corrected", () => {
  const span = extractSpan(heard("счёт ноль пятнадцать счёт пятнадцать ноль"), GAME);

  assert.deepEqual(span.command, score("15", "0"));
});

test("a span carries its timing for the log", () => {
  const span = extractSpan(heard("да счёт гейм"), GAME);

  assert.equal(span.startMs, 500);
  assert.equal(span.endMs, 1400);
  assert.equal(span.after, null);
});

test("nothing heard is nothing", () => {
  assert.equal(extractSpan([], GAME), null);
  assert.equal(extractSpan(undefined, GAME), null);
});
