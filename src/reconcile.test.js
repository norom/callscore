import test from "node:test";
import assert from "node:assert/strict";

import { reconcile } from "./reconcile.js";
import { derive, pointLabel } from "./match.js";
import { serverAt } from "./serve.js";

const call = (server, receiver) => ({ kind: "score", labels: [server, receiver] });
const GAME = { kind: "game" };

const game = (team) => team.repeat(4);
const toTieBreak = () => [...(game("A") + game("B")).repeat(6)];

/** The board as it would be called aloud: server first. */
function called(points, firstServer = "A") {
  const state = derive(points);
  const server = serverAt(points, firstServer);
  const receiver = server === "A" ? "B" : "A";
  return [pointLabel(state, server), pointLabel(state, receiver)];
}

// --------------------------------------------------------------- one point

test("the next score adds the point it implies", () => {
  const result = reconcile([], "A", call("15", "0"));

  assert.equal(result.tier, "apply");
  assert.deepEqual(result.points, ["A"]);
});

test("the first number belongs to whoever is serving", () => {
  assert.deepEqual(reconcile([], "A", call("0", "15")).points, ["B"]);
  assert.deepEqual(reconcile([], "B", call("0", "15")).points, ["A"]);
  assert.deepEqual(reconcile([], "B", call("15", "0")).points, ["B"]);
});

test("the serve having changed hands is taken into account", () => {
  // A held serve, so B serves the second game and «пятнадцать ноль» is B's point.
  const result = reconcile([...game("A")], "A", call("15", "0"));

  assert.deepEqual(result.points, [...game("A"), "B"]);
});

test("calling the score already on the board changes nothing", () => {
  const points = [..."AB"];
  const result = reconcile(points, "A", call("15", "15"));

  assert.equal(result.tier, "noop");
  assert.equal(result.points, points);
});

// ------------------------------------------------------------ missed calls

test("a missed call is caught up by the next one", () => {
  const result = reconcile([], "A", call("15", "15"));

  assert.equal(result.tier, "apply");
  assert.deepEqual(called(result.points), ["15", "15"]);
  assert.equal(result.points.length, 2);
});

test("two points to the same team in one call", () => {
  assert.deepEqual(reconcile([], "A", call("30", "0")).points, ["A", "A"]);
});

test("three points away is too far to take on trust", () => {
  const result = reconcile([], "A", call("40", "0"));

  assert.equal(result.tier, "confirm");
  assert.deepEqual(called(result.points), ["40", "0"]);
});

// ------------------------------------------------------ deuce and advantage

test("deuce, advantage, and back again", () => {
  const deuce = [..."ABABAB"];
  assert.deepEqual(called(deuce), ["40", "40"]);

  const adServer = reconcile(deuce, "A", call("AD", "40"));
  assert.equal(adServer.tier, "apply");
  assert.deepEqual(adServer.points, [...deuce, "A"]);

  const adReceiver = reconcile(deuce, "A", call("40", "AD"));
  assert.deepEqual(adReceiver.points, [...deuce, "B"]);

  const back = reconcile(adServer.points, "A", call("40", "40"));
  assert.equal(back.tier, "apply");
  assert.deepEqual(back.points, [...deuce, "A", "B"]);
});

test("advantage changing sides is two points", () => {
  const adA = [..."ABABABA"];
  const result = reconcile(adA, "A", call("40", "AD"));

  assert.equal(result.tier, "apply");
  assert.deepEqual(result.points, [...adA, "B", "B"]);
});

test("deuce called at deuce changes nothing, however many points were played", () => {
  const deuce = [..."ABABAB"];

  assert.equal(reconcile(deuce, "A", call("40", "40")).tier, "noop");
});

// ---------------------------------------------------------- forgotten «гейм»

test("the first score of a new game implies the game nobody called", () => {
  // 40-15 to A, who serves. Then «пятнадцать ноль», called by the new server B.
  const before = [..."AAAB"];
  assert.deepEqual(called(before), ["40", "15"]);

  const result = reconcile(before, "A", call("15", "0"));

  assert.equal(result.tier, "apply");
  assert.deepEqual(result.points, [...before, "A", "B"]);
  assert.deepEqual(derive(result.points).games, { A: 1, B: 0 });
});

test("«по нулям» at game point is the game being won", () => {
  const result = reconcile([..."AAA"], "A", call("0", "0"));

  assert.equal(result.tier, "apply");
  assert.deepEqual(derive(result.points).games, { A: 1, B: 0 });
});

test("a forward reading is preferred to a correction", () => {
  // 0-40 to B. «пятнадцать ноль» could be A pulling one back on a wrong board,
  // but B winning the game and the next point says the same thing — and that
  // is the game being played rather than the scoreboard being wrong.
  const points = [..."BBB"];
  const result = reconcile(points, "A", call("15", "0"));

  assert.equal(result.tier, "apply");
  assert.deepEqual(result.points, [...points, "B", "B"]);
});

test("a score that fits two different boards is not guessed at", () => {
  // From deuce, 0-0 means somebody won the game — but not who.
  const result = reconcile([..."ABABAB"], "A", call("0", "0"));

  assert.equal(result.error, "ambiguous");
});

// -------------------------------------------------------------------- «гейм»

test("«гейм» goes to the team on game point", () => {
  const forA = reconcile([..."AAAB"], "A", GAME);
  assert.equal(forA.tier, "apply");
  assert.deepEqual(derive(forA.points).games, { A: 1, B: 0 });

  const forB = reconcile([..."ABBB"], "A", GAME);
  assert.deepEqual(derive(forB.points).games, { A: 0, B: 1 });
});

test("«гейм» goes to the team with the advantage", () => {
  const result = reconcile([..."ABABABB"], "A", GAME);

  assert.deepEqual(derive(result.points).games, { A: 0, B: 1 });
});

test("«гейм» with nobody on game point cannot be applied", () => {
  assert.equal(reconcile([..."ABABAB"], "A", GAME).error, "impossible");
  assert.equal(reconcile([..."AB"], "A", GAME).error, "impossible");
});

test("«гейм» ends a tie-break on set point", () => {
  const points = [...toTieBreak(), ..."AAAAAAB"];
  const result = reconcile(points, "A", GAME);

  assert.equal(result.tier, "apply");
  assert.deepEqual(derive(result.points).completedSets, [{ A: 7, B: 6 }]);
});

// ---------------------------------------------------------------- tie-break

test("a tie-break score follows the serve as it moves", () => {
  let points = toTieBreak();

  // A serves the first point and wins it. The serve passes to B, who calls the
  // score before serving: «ноль один».
  points = reconcile(points, "A", call("0", "1")).points;
  assert.deepEqual(derive(points).points, { A: 1, B: 0 });

  // B serves, A wins again, and B still has a serve left: «ноль два».
  const next = reconcile(points, "A", call("0", "2"));
  assert.equal(next.tier, "apply");
  assert.deepEqual(derive(next.points).points, { A: 2, B: 0 });
});

test("a finished tie-break score is not a score", () => {
  assert.equal(reconcile(toTieBreak(), "A", call("7", "0")).error, "impossible");
});

test("the set after a tie-break starts with the right server", () => {
  const setPoint = [...toTieBreak(), ..."AAAAAA"];

  // A takes the tie-break, then B — serving the new set — wins a point.
  const result = reconcile(setPoint, "A", call("15", "0"));

  assert.equal(result.tier, "apply");
  assert.deepEqual(result.points, [...setPoint, "A", "B"]);
});

// -------------------------------------------------------------- corrections

test("a score behind the board is a correction, and asks to be repeated", () => {
  const points = [..."AAB"];
  const result = reconcile(points, "A", call("15", "15"));

  assert.equal(result.tier, "confirm");
  assert.deepEqual(called(result.points), ["15", "15"]);
});

test("a correction rebuilds only the current game", () => {
  // 0-30, so no point or two from here reads «пятнадцать ноль».
  const points = [...game("A"), ...game("B"), ..."BB"];
  const result = reconcile(points, "A", call("15", "0"));

  assert.equal(result.tier, "confirm");
  assert.deepEqual(derive(result.points).games, { A: 1, B: 1 });
  assert.deepEqual(result.points.slice(0, 8), points.slice(0, 8));
  assert.deepEqual(called(result.points), ["15", "0"]);
});

test("a correction to advantage passes through deuce, not through a won game", () => {
  const result = reconcile([], "A", call("40", "AD"));

  assert.equal(result.tier, "confirm");
  assert.deepEqual(derive(result.points).games, { A: 0, B: 0 });
  assert.equal(derive(result.points).advantage, "B");
});

test("a correction inside a tie-break keeps the serve straight", () => {
  const points = [...toTieBreak(), ..."AAAAA"];
  const result = reconcile(points, "A", call("1", "1"));

  assert.equal(result.tier, "confirm");
  assert.deepEqual(derive(result.points).points, { A: 1, B: 1 });
  assert.equal(derive(result.points).tieBreak, true);
});

test("a stale call from the game just finished is not applied on the spot", () => {
  // The game was recorded; then somebody repeats its last score.
  const result = reconcile([...game("A")], "A", call("40", "15"));

  assert.equal(result.tier, "confirm");
});

// --------------------------------------------------------------- match over

test("a decided match takes no more calls", () => {
  const match = [...game("A").repeat(12)];
  assert.equal(derive(match).matchOver, true);

  assert.equal(reconcile(match, "A", call("15", "0")).error, "over");
  assert.equal(reconcile(match, "A", GAME).error, "over");
});

test("the point that decides the match can be called", () => {
  const matchPoint = [...game("A").repeat(11), ..."AAA"];
  const result = reconcile(matchPoint, "A", GAME);

  assert.equal(result.tier, "apply");
  assert.equal(derive(result.points).matchOver, true);
});
