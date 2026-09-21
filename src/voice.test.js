import test from "node:test";
import assert from "node:assert/strict";

import { createVoice, REPEAT_WINDOW_MS } from "./voice.js";
import { createSession, commit, undo } from "./session.js";
import { derive } from "./match.js";
import { GRAMMARS } from "./grammar.js";

const game = (team) => team.repeat(4);
const toTieBreak = () => [...(game("A") + game("B")).repeat(6)];

/** A match, a clock and a recording of everything the voice channel did. */
function rig({ points = [], firstServer = "A", enabled = true } = {}) {
  const world = {
    session: createSession({ points, firstServer }),
    clock: 1_000_000,
    enabled,
    tones: [],
    grammars: [],
    log: [],
    heard: null,
  };

  world.voice = createVoice({
    now: () => world.clock,
    isEnabled: () => world.enabled,
    getMatch: () => world.session,
    commit: (next) => (world.session = commit(world.session, next)),
    undo: () => (world.session = undo(world.session)),
    tone: (kind) => world.tones.push(kind),
    setGrammar: (name, phrases) => world.grammars.push({ name, phrases }),
    log: (entry) => world.log.push(entry),
    showHeard: (text) => (world.heard = text),
    clearHeard: () => (world.heard = null),
  });

  world.say = (text, grammar = derive(world.session.points).tieBreak ? "tiebreak" : "game") => {
    const result = text.split(" ").map((word, i) => ({ word, start: i * 0.5, end: i * 0.5 + 0.4, conf: 1 }));
    world.voice.final(JSON.stringify({ vosk: { text, result }, rms: -20, grammar, t: world.clock }));
  };
  world.board = () => derive(world.session.points);

  return world;
}

// ------------------------------------------------------------------ applying

test("a called score moves the board and answers with the ok tone", () => {
  const world = rig();

  world.say("счёт пятнадцать ноль");

  assert.deepEqual(world.session.points, ["A"]);
  assert.deepEqual(world.tones, ["ok"]);
});

test("the score already showing is confirmed without changing anything", () => {
  const world = rig({ points: ["A"] });

  world.say("счёт пятнадцать ноль");

  assert.deepEqual(world.session.points, ["A"]);
  assert.deepEqual(world.session.history, []);
  assert.deepEqual(world.tones, ["ok"]);
});

test("chatter is ignored in silence", () => {
  const world = rig();

  world.say("давай быстрее подавай уже мяч");
  world.say("какой счёт я не помню");
  world.say("ноль пятнадцать");

  assert.deepEqual(world.session.points, []);
  assert.deepEqual(world.tones, []);
  assert.equal(world.log.length, 3);
  assert.ok(world.log.every((entry) => entry.action === "ignored"));
});

test("a command that cannot be applied gets the fail tone", () => {
  const world = rig({ points: [..."AB"] });

  world.say("счёт гейм");

  assert.deepEqual(world.session.points, ["A", "B"]);
  assert.deepEqual(world.tones, ["fail"]);
});

test("nothing is applied while voice is switched off", () => {
  const world = rig({ enabled: false });

  world.say("счёт пятнадцать ноль");

  assert.deepEqual(world.session.points, []);
  assert.deepEqual(world.tones, []);
});

// ---------------------------------------------------------------- confirming

test("a leap asks to be repeated, and the repeat applies it", () => {
  const world = rig();

  world.say("счёт сорок ноль");
  assert.deepEqual(world.session.points, []);
  assert.deepEqual(world.tones, ["confirm"]);

  world.clock += 3000;
  world.say("счёт сорок ноль");
  assert.deepEqual(world.board().points, { A: 3, B: 0 });
  assert.deepEqual(world.tones, ["confirm", "ok"]);
});

test("a repeat that comes too late is a fresh request", () => {
  const world = rig();

  world.say("счёт сорок ноль");
  world.clock += REPEAT_WINDOW_MS + 1;
  world.say("счёт сорок ноль");

  assert.deepEqual(world.session.points, []);
  assert.deepEqual(world.tones, ["confirm", "confirm"]);
});

test("a different call in between does not confirm the first", () => {
  const world = rig();

  world.say("счёт сорок ноль");
  world.say("счёт ноль сорок");

  assert.deepEqual(world.session.points, []);
  assert.deepEqual(world.tones, ["confirm", "confirm"]);
});

test("a point scored by touch in between cancels the pending leap", () => {
  const world = rig();

  world.say("счёт сорок пятнадцать");
  world.session = commit(world.session, ["B"]);
  world.say("счёт сорок пятнадцать");

  assert.deepEqual(world.session.points, ["B"]);
  assert.deepEqual(world.tones, ["confirm", "confirm"]);
});

// ---------------------------------------------------------- undo and «гейм»

test("«отмена» takes back the last change", () => {
  const world = rig();

  world.say("счёт тридцать ноль");
  world.clock += 20_000;
  world.say("счёт отмена");

  assert.deepEqual(world.session.points, []);
  assert.deepEqual(world.tones, ["ok", "ok"]);
});

test("«отмена» heard twice in a row undoes once", () => {
  const world = rig({ points: [..."AB"] });

  world.say("счёт отмена");
  world.clock += 2000;
  world.say("счёт отмена");

  assert.deepEqual(world.session.points, ["A"]);
  assert.deepEqual(world.tones, ["ok", "ok"]);
});

test("«отмена» again after a while is a second undo", () => {
  const world = rig({ points: [..."AB"] });

  world.say("счёт отмена");
  world.clock += REPEAT_WINDOW_MS + 1;
  world.say("счёт отмена");

  assert.deepEqual(world.session.points, []);
});

test("«отмена» with nothing to take back gets the fail tone", () => {
  const world = rig();

  world.say("счёт отмена");

  assert.deepEqual(world.tones, ["fail"]);
});

test("«гейм» heard twice in a row is one game", () => {
  const world = rig({ points: [..."AAA"] });

  world.say("счёт гейм");
  world.clock += 2000;
  world.say("счёт гейм");

  assert.deepEqual(world.board().games, { A: 1, B: 0 });
  assert.deepEqual(world.tones, ["ok", "ok"]);
});

// ------------------------------------------------------------------ grammar

test("the recogniser is given the game grammar to start with", () => {
  const world = rig();

  world.voice.sync();

  assert.deepEqual(world.grammars, [{ name: "game", phrases: GRAMMARS.game }]);
});

test("the grammar is sent once, not on every sync", () => {
  const world = rig();

  world.voice.sync();
  world.voice.sync();

  assert.equal(world.grammars.length, 1);
});

test("entering a tie-break by voice switches to numbers, and leaving switches back", () => {
  const world = rig({ points: toTieBreak().slice(0, -1) });
  world.voice.sync();

  world.say("счёт гейм");
  assert.equal(world.board().tieBreak, true);
  assert.equal(world.grammars.at(-1).name, "tiebreak");

  world.session = commit(world.session, [...world.session.points, ..."AAAAAAA"]);
  world.voice.sync();
  assert.equal(world.grammars.at(-1).name, "game");
});

test("a result decoded under the other grammar is dropped", () => {
  const world = rig({ points: toTieBreak() });

  // Decoded before the switch to numbers took effect.
  world.say("счёт ноль пятнадцать", "game");

  assert.deepEqual(world.tones, []);
  assert.equal(world.log.at(-1).action, "stale-grammar");
});

test("a native restart is given the grammar again", () => {
  const world = rig();

  world.voice.sync();
  world.voice.resync();

  assert.equal(world.grammars.length, 2);
});

// ------------------------------------------------------------------- display

test("a partial with the wake word is shown, the final clears it", () => {
  const world = rig();

  world.voice.partial(JSON.stringify({ text: "счёт ноль" }));
  assert.equal(world.heard, "счёт ноль");

  world.say("счёт ноль пятнадцать");
  assert.equal(world.heard, null);
});

test("a partial that is only chatter is not shown", () => {
  const world = rig();

  world.voice.partial(JSON.stringify({ text: "давай мяч" }));

  assert.equal(world.heard, null);
});

test("what was heard and what was done are logged", () => {
  const world = rig();

  world.say("ну счёт пятнадцать ноль да");

  const entry = world.log.at(-1);
  assert.equal(entry.text, "ну счёт пятнадцать ноль да");
  assert.equal(entry.action, "apply");
  assert.deepEqual(entry.tokens, ["пятнадцать", "ноль"]);
  assert.equal(entry.before, "ну");
  assert.equal(entry.after, "да");
  assert.equal(entry.rms, -20);
});

test("a payload that is not JSON does not take the scoreboard down", () => {
  const world = rig();

  assert.doesNotThrow(() => world.voice.final("{not json"));
  assert.doesNotThrow(() => world.voice.partial("{not json"));
});
