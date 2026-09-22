import test from "node:test";
import assert from "node:assert/strict";

import { endsChanged } from "./ends.js";

const game = (team) => team.repeat(4);
const games = (n) => [...game("A").repeat(n)];
const toTieBreak = () => [...(game("A") + game("B")).repeat(6)];

test("ends are changed after the first game, then every two", () => {
  assert.equal(endsChanged([]), false);
  assert.equal(endsChanged([..."AAB"]), false);
  assert.equal(endsChanged(games(1)), true);
  assert.equal(endsChanged(games(2)), true);
  assert.equal(endsChanged(games(3)), false);
  assert.equal(endsChanged(games(4)), false);
  assert.equal(endsChanged(games(5)), true);
});

test("the count carries across sets, which is what the rule at a set's end amounts to", () => {
  // 6-3: nine games. The ninth changed ends, and the first game of the next
  // set does not.
  const oddSet = [...game("B").repeat(3), ...game("A").repeat(6)];
  assert.equal(endsChanged(oddSet), true);
  assert.equal(endsChanged([...oddSet, ...game("A")]), true);
  assert.equal(endsChanged([...oddSet, ...game("A"), ...game("B")]), false);

  // 6-4: ten games. Nothing at the set's end; the first game of the next set
  // changes ends.
  const evenSet = [...game("B").repeat(4), ...game("A").repeat(6)];
  assert.equal(endsChanged(evenSet), true);
  assert.equal(endsChanged([...evenSet, ...game("A")]), false);
});

test("in a tie-break the ends change every six points", () => {
  const start = toTieBreak();
  assert.equal(endsChanged(start), false);
  assert.equal(endsChanged([...start, ..."ABABA"]), false);
  assert.equal(endsChanged([...start, ..."ABABAB"]), true);
  assert.equal(endsChanged([...start, ..."ABABABABABA"]), true);
  assert.equal(endsChanged([...start, ..."ABABABABABAB"]), false);
});

test("a finished tie-break counts as one game", () => {
  assert.equal(endsChanged([...toTieBreak(), ..."AAAAAAA"]), true);
});
