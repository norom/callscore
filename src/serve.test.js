import test from "node:test";
import assert from "node:assert/strict";

import { serverAt } from "./serve.js";
import { derive } from "./match.js";

/** Points that give `team` a love game. */
const game = (team) => team.repeat(4);

/** Six games apiece, so the next point is the first of a tie-break. */
const toTieBreak = () => [...(game("A") + game("B")).repeat(6)];

test("the first server serves the first point", () => {
  assert.equal(serverAt([], "A"), "A");
  assert.equal(serverAt([], "B"), "B");
});

test("the serve does not move during a game", () => {
  assert.equal(serverAt([..."ABA"], "A"), "A");
});

test("the serve changes hands after every game", () => {
  assert.equal(serverAt([...game("A")], "A"), "B");
  assert.equal(serverAt([...(game("A") + game("A"))], "A"), "A");
  assert.equal(serverAt([...(game("A") + game("B") + game("A"))], "A"), "B");
});

test("who won the game does not matter, only that it ended", () => {
  assert.equal(serverAt([...game("B")], "A"), "B");
  assert.equal(serverAt([...game("B")], "B"), "A");
});

test("the serve keeps alternating into the next set", () => {
  // 6-0 is six games, an even number, so the first server starts set two.
  const set = [...game("A").repeat(6)];
  assert.equal(derive(set).setsWon.A, 1);
  assert.equal(serverAt(set, "A"), "A");

  // 6-1 is seven games, so set two starts with the other team.
  const longer = [...(game("B") + game("A").repeat(6))];
  assert.equal(derive(longer).setsWon.A, 1);
  assert.equal(serverAt(longer, "A"), "B");
});

test("a tie-break is served one point, then two each", () => {
  const start = toTieBreak();
  assert.equal(derive(start).tieBreak, true);

  // Twelve games played, so the first server has the first tie-break point.
  const servers = [];
  let points = start;
  for (let i = 0; i < 7; i++) {
    servers.push(serverAt(points, "A"));
    points = [...points, i % 2 ? "B" : "A"];
  }
  assert.deepEqual(servers, ["A", "B", "B", "A", "A", "B", "B"]);
});

test("the set after a tie-break is started by the team that received first in it", () => {
  const afterTieBreak = [...toTieBreak(), ..."AAAAAAA"];
  const state = derive(afterTieBreak);

  assert.equal(state.setsWon.A, 1);
  assert.deepEqual(state.completedSets, [{ A: 7, B: 6 }]);
  assert.equal(serverAt(afterTieBreak, "A"), "B");
});
