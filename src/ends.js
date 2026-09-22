/**
 * Which end each team is on.
 *
 * Players change ends after the first game and then every two, and every six
 * points of a tie-break. Counting games across the whole match rather than per
 * set gives the rule at a set's end for free: an odd set changes ends there, an
 * even one after the first game of the next.
 */

import { derive } from "./match.js";

const TIE_BREAK_CHANGE_EVERY = 6;

/** True when the teams are on the opposite ends from where they started. */
export function endsChanged(points) {
  const state = derive(points);

  const games =
    state.completedSets.reduce((sum, set) => sum + set.A + set.B, 0) +
    state.games.A +
    state.games.B;

  // Changed after games 1, 3, 5… so the teams are on the far ends after 1 and 2,
  // back after 3 and 4, and so on.
  const byGames = Math.floor((games + 1) / 2) % 2 === 1;

  const byTieBreak =
    state.tieBreak &&
    Math.floor((state.points.A + state.points.B) / TIE_BREAK_CHANGE_EVERY) % 2 === 1;

  return byGames !== byTieBreak;
}
