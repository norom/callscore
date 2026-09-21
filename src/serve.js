/**
 * Who is serving.
 *
 * A score called on court is called server first, so turning «ноль пятнадцать»
 * into a scoreboard means knowing which team the «ноль» belongs to. Like
 * everything else this is derived from the point list, plus the one fact the
 * points cannot supply: who served the first game.
 */

import { derive } from "./match.js";

const other = (team) => (team === "A" ? "B" : "A");

export function serverAt(points, firstServer) {
  const state = derive(points);

  // The serve changes hands every game for the whole match, and a tie-break
  // counts as one game — which is also what hands the first game of the next
  // set to the team that received first in the tie-break.
  const played =
    state.completedSets.reduce((sum, set) => sum + set.A + set.B, 0) +
    state.games.A +
    state.games.B;

  const due = played % 2 === 0 ? firstServer : other(firstServer);
  if (!state.tieBreak) return due;

  // One point, then two each: the serve turns over after points 1, 3, 5…
  const turnovers = Math.floor((state.points.A + state.points.B + 1) / 2);
  return turnovers % 2 === 0 ? due : other(due);
}
