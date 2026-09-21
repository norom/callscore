import test from "node:test";
import assert from "node:assert/strict";

import { createSession, commit, undo, HISTORY_LIMIT } from "./session.js";

test("a session starts with nothing to undo", () => {
  const session = createSession({ points: [..."AB"], firstServer: "B" });

  assert.deepEqual(session.points, ["A", "B"]);
  assert.equal(session.firstServer, "B");
  assert.deepEqual(session.history, []);
});

test("a commit replaces the points and remembers what was there", () => {
  const before = createSession({ points: ["A"], firstServer: "A" });
  const after = commit(before, ["A", "B"]);

  assert.deepEqual(after.points, ["A", "B"]);
  assert.deepEqual(after.history, [["A"]]);
  assert.deepEqual(before.history, [], "the previous session is untouched");
});

test("committing the same points is not a step", () => {
  const session = createSession({ points: ["A"], firstServer: "A" });

  assert.equal(commit(session, session.points), session);
  assert.equal(commit(session, ["A"]), session);
});

test("one undo takes back one spoken command, however many points it was", () => {
  let session = createSession({ points: [..."AAAB"], firstServer: "A" });

  // A forgotten «гейм»: the call added the game point and the next one.
  session = commit(session, [..."AAABAB"]);
  session = undo(session);

  assert.deepEqual(session.points, [..."AAAB"]);
  assert.deepEqual(session.history, []);
});

test("undo steps back through touch and voice alike", () => {
  let session = createSession({ points: [], firstServer: "A" });
  session = commit(session, ["A"]);
  session = commit(session, ["A", "B", "B"]);
  session = commit(session, ["A", "B"]);

  session = undo(session);
  assert.deepEqual(session.points, ["A", "B", "B"]);
  session = undo(session);
  assert.deepEqual(session.points, ["A"]);
  session = undo(session);
  assert.deepEqual(session.points, []);
});

test("with no history, as after a restart, undo drops the last point", () => {
  const session = undo(createSession({ points: [..."AAB"], firstServer: "A" }));

  assert.deepEqual(session.points, ["A", "A"]);
});

test("undo on an empty match changes nothing", () => {
  const session = createSession({ points: [], firstServer: "A" });

  assert.equal(undo(session), session);
});

test("history is bounded, keeping the most recent steps", () => {
  let session = createSession({ points: [], firstServer: "A" });
  for (let i = 1; i <= HISTORY_LIMIT + 10; i++) session = commit(session, Array(i).fill("A"));

  assert.equal(session.history.length, HISTORY_LIMIT);
  assert.equal(undo(session).points.length, HISTORY_LIMIT + 9);
});
