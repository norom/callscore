import test from "node:test";
import assert from "node:assert/strict";

import { createStore, EMPTY } from "./storage.js";

/** Stand-in for localStorage. */
function fakeStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    get size() {
      return data.size;
    },
  };
}

test("an empty store reads as a fresh match", () => {
  const store = createStore(fakeStorage());

  assert.deepEqual(store.load(), EMPTY);
});

test("points survive a reload", () => {
  const storage = fakeStorage();

  createStore(storage).savePoints([..."AAB"]);

  assert.deepEqual(createStore(storage).load().points, ["A", "A", "B"]);
});

test("which way round the board is survives a reload", () => {
  const storage = fakeStorage();

  createStore(storage).saveSwapped(true);

  assert.equal(createStore(storage).load().swapped, true);
  assert.equal(createStore(fakeStorage()).load().swapped, false);
});

test("changing ends automatically is on unless switched off", () => {
  const storage = fakeStorage();
  assert.equal(createStore(storage).load().autoEnds, true);

  createStore(storage).saveAutoEnds(false);
  assert.equal(createStore(storage).load().autoEnds, false);
});

test("a fresh store has team A serving first", () => {
  assert.equal(createStore(fakeStorage()).load().firstServer, "A");
});

test("starting a match records who serves first and clears the points", () => {
  const storage = fakeStorage();
  const store = createStore(storage);

  store.savePoints([..."AAB"]);
  store.startMatch("B");

  const loaded = createStore(storage).load();
  assert.deepEqual(loaded.points, []);
  assert.equal(loaded.firstServer, "B");
});

test("saving points leaves the first server alone", () => {
  const storage = fakeStorage();
  const store = createStore(storage);

  store.startMatch("B");
  store.savePoints([..."AB"]);

  const loaded = createStore(storage).load();
  assert.equal(loaded.firstServer, "B");
  assert.deepEqual(loaded.points, ["A", "B"]);
});

test("a first server that is not a team falls back to team A", () => {
  const store = createStore(fakeStorage({ "padel-audio": '{"firstServer":"Z"}' }));

  assert.equal(store.load().firstServer, "A");
});

test("corrupt stored data reads as a fresh match instead of throwing", () => {
  const store = createStore(fakeStorage({ "padel-audio": "{not json" }));

  assert.deepEqual(store.load(), EMPTY);
});

test("stored data of the wrong shape is discarded", () => {
  const store = createStore(fakeStorage({ "padel-audio": '{"points":"AAB"}' }));

  assert.deepEqual(store.load().points, []);
});

test("unknown teams in stored points are rejected", () => {
  const store = createStore(fakeStorage({ "padel-audio": '{"points":["A","Z","B"]}' }));

  assert.deepEqual(store.load().points, []);
});

test("a storage that throws does not take the scoreboard down", () => {
  const hostile = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("quota");
    },
    removeItem() {
      throw new Error("denied");
    },
  };

  const store = createStore(hostile);

  assert.deepEqual(store.load(), EMPTY);
  assert.doesNotThrow(() => store.savePoints([..."A"]));
});

test("a fresh store plays tennis", () => {
  assert.deepEqual(createStore(fakeStorage()).load().format, { kind: "tennis" });
});

test("the chosen format survives a reload", () => {
  const storage = fakeStorage();

  createStore(storage).saveFormat({ kind: "americano", target: 21 });

  assert.deepEqual(createStore(storage).load().format, { kind: "americano", target: 21 });
});

test("saving the format leaves the match alone", () => {
  const storage = fakeStorage();
  const store = createStore(storage);

  store.startMatch("B");
  store.savePoints([..."AB"]);
  store.saveFormat({ kind: "americano", target: 24 });

  const loaded = createStore(storage).load();
  assert.equal(loaded.firstServer, "B");
  assert.deepEqual(loaded.points, ["A", "B"]);
  assert.deepEqual(loaded.format, { kind: "americano", target: 24 });
});

test("an unknown format falls back to tennis", () => {
  const store = createStore(fakeStorage({ "padel-audio": '{"format":{"kind":"chess"}}' }));

  assert.deepEqual(store.load().format, { kind: "tennis" });
});

test("an americano target that is not a sensible number falls back to the default", () => {
  const nonsense = ['{"format":{"kind":"americano","target":"lots"}}',
                    '{"format":{"kind":"americano","target":0}}',
                    '{"format":{"kind":"americano"}}'];

  for (const raw of nonsense) {
    const loaded = createStore(fakeStorage({ "padel-audio": raw })).load();
    assert.deepEqual(loaded.format, { kind: "americano", target: 24 }, raw);
  }
});
