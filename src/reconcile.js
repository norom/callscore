/**
 * From a called score to a point list.
 *
 * The engine only understands "this team won a point", and a call is a
 * statement of where the game stands. The bridge is a search: play out every
 * way the next couple of points could go, through the real engine, and keep the
 * one that produces the called score from the server's side.
 *
 * Searching rather than computing means no scoring rule is written twice, and
 * the depth of the search is the plausibility check — a call one or two points
 * on is the game being played, anything further is more likely a mishearing.
 * It also gets the commonest slip right for free: nobody says «гейм», the next
 * thing called is «пятнадцать ноль», and the only future that reads that way is
 * the game being won and the new server taking the first point.
 */

import { derive, addPoint, pointLabel, TEAMS } from "./match.js";
import { serverAt } from "./serve.js";

const MAX_FORWARD = 2;

const other = (team) => (team === "A" ? "B" : "A");

/** The board the way it is called aloud: server first. */
function calledAt(points, firstServer) {
  const state = derive(points);
  const server = serverAt(points, firstServer);

  return [pointLabel(state, server), pointLabel(state, other(server))];
}

const sameCall = (a, b) => a[0] === b[0] && a[1] === b[1];

/** Two point lists can differ in order and still be the same scoreboard. */
const board = (points) => JSON.stringify(derive(points));

/** Every distinct way `length` more points could go. */
function futures(points, length) {
  let lists = [points];

  for (let i = 0; i < length; i++) {
    lists = lists.flatMap((list) =>
      TEAMS.map((team) => addPoint(list, team)).filter((next) => next !== list),
    );
  }
  return lists;
}

/** One candidate, or the reason there is not exactly one. */
function only(candidates) {
  if (candidates.length === 0) return null;

  const boards = new Set(candidates.map(board));
  return boards.size === 1 ? { points: candidates[0] } : { error: "ambiguous" };
}

function gamesPlayed(state) {
  return (
    state.completedSets.reduce((sum, set) => sum + set.A + set.B, 0) +
    state.games.A +
    state.games.B
  );
}

// -------------------------------------------------------------------- «гейм»

function reconcileGame(points) {
  const before = gamesPlayed(derive(points));
  const found = only(
    futures(points, 1).filter((next) => gamesPlayed(derive(next)) > before),
  );

  if (!found) return { error: "impossible" };
  return found.error ? found : { points: found.points, tier: "apply" };
}

// -------------------------------------------------------------- corrections

const GAME_COUNTS = { 0: 0, 15: 1, 30: 2, 40: 3 };

/** A called pair as points won in the game, or null if no game stands like that. */
function countsOf([first, second], tieBreak) {
  if (tieBreak) {
    const a = Number(first);
    const b = Number(second);
    const finished = Math.max(a, b) >= 7 && Math.abs(a - b) >= 2;

    return Number.isInteger(a) && Number.isInteger(b) && !finished ? [a, b] : null;
  }

  if (first === "AD" && second === "40") return [4, 3];
  if (first === "40" && second === "AD") return [3, 4];
  if (first in GAME_COUNTS && second in GAME_COUNTS) return [GAME_COUNTS[first], GAME_COUNTS[second]];
  return null;
}

/** Where the game in progress began. */
function gameStart(points) {
  const played = gamesPlayed(derive(points));
  let start = points.length;

  while (start > 0 && gamesPlayed(derive(points.slice(0, start - 1))) === played) start--;
  return start;
}

/**
 * Point by point up to the lower count and then the leader alone, so the game
 * is never won on the way — which the straight run to 40-AD would do.
 */
function sequence(serverCount, receiverCount, server) {
  const level = Math.min(serverCount, receiverCount);
  const leader = serverCount > receiverCount ? server : other(server);

  return [
    ...Array.from({ length: level }, () => [server, other(server)]).flat(),
    ...Array.from({ length: Math.abs(serverCount - receiverCount) }, () => leader),
  ];
}

/**
 * A call the next two points cannot explain: the board is wrong and is being
 * put right. Only the game in progress is rebuilt, and only once the call has
 * been repeated — the caller decides that, this just says what it would be.
 */
function rebuild(points, firstServer, labels) {
  const state = derive(points);
  const counts = countsOf(labels, state.tieBreak);
  if (!counts) return { error: "impossible" };

  const base = points.slice(0, gameStart(points));
  const played = gamesPlayed(state);

  // In a tie-break the server depends on how many points have been played, so
  // both readings are built and the one that calls back correctly is kept.
  const candidates = TEAMS.map((server) => [...base, ...sequence(counts[0], counts[1], server)]).filter(
    (next) =>
      gamesPlayed(derive(next)) === played && sameCall(calledAt(next, firstServer), labels),
  );

  const found = only(candidates);
  if (!found) return { error: "impossible" };
  return found.error ? found : { points: found.points, tier: "confirm" };
}

// ------------------------------------------------------------------- scores

function reconcileScore(points, firstServer, labels, maxForward) {
  for (let length = 0; length <= maxForward; length++) {
    const found = only(
      futures(points, length).filter((next) => sameCall(calledAt(next, firstServer), labels)),
    );
    if (!found) continue;
    if (found.error) return found;

    return length === 0 ? { points, tier: "noop" } : { points: found.points, tier: "apply" };
  }
  return rebuild(points, firstServer, labels);
}

/**
 * `{points, tier}` or `{error}`.
 *
 *   apply    the next point or two; take it
 *   noop     the board already says this
 *   confirm  legal but a leap — `points` is what it would become if repeated
 *
 *   ambiguous   fits two different boards
 *   impossible  fits none
 *   over        the match is decided
 */
export function reconcile(points, firstServer, command, { maxForward = MAX_FORWARD } = {}) {
  if (derive(points).matchOver) return { error: "over" };

  if (command.kind === "game") return reconcileGame(points);
  if (command.kind === "score") return reconcileScore(points, firstServer, command.labels, maxForward);
  return { error: "impossible" };
}
