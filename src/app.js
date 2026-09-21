/**
 * Wiring: touch input in, scoreboard out, everything persisted.
 */

import { derive, addPoint, undo, pointLabel } from "./match.js";
import { deriveAmericano, addAmericanoPoint, americanoLabel } from "./americano.js";
import { createStore } from "./storage.js";
import { createUI } from "./ui.js";

const store = createStore(window.localStorage);

let { points, firstServer, format } = store.load();

const ui = createUI({
  onPoint: score,
  onUndo: undoPoint,
  onNewMatch: newMatch,
});

// ------------------------------------------------------------------ formats

const isAmericano = () => format.kind === "americano";

function currentState() {
  return isAmericano() ? deriveAmericano(points, format.target) : derive(points);
}

/**
 * Turns a match state into what the screen shows. Keeping this here rather than
 * in the UI means a format is described in one place: how it scores, what it
 * calls itself, and which parts of the scoreboard apply to it.
 */
function view() {
  const state = currentState();

  if (isAmericano()) {
    return {
      labels: { A: americanoLabel(state, "A"), B: americanoLabel(state, "B") },
      stats: null,
      advantage: null,
      badge: state.draw ? "Draw" : state.winner ? `Team ${state.winner} wins` : "",
      status: state.matchOver ? "Round complete" : `Americano · to ${format.target}`,
      locked: state.matchOver,
    };
  }

  return {
    labels: { A: pointLabel(state, "A"), B: pointLabel(state, "B") },
    stats: { sets: state.setsWon, games: state.games },
    advantage: state.advantage,
    badge: state.matchOver
      ? `Team ${state.winner} wins`
      : state.tieBreak
        ? "Tie-break"
        : "",
    status: state.matchOver ? "Match complete" : "Best of 3",
    locked: state.matchOver,
  };
}

function show() {
  ui.render(view());
}

// ------------------------------------------------------------------ actions

function score(team) {
  const next = isAmericano()
    ? addAmericanoPoint(points, team, format.target)
    : addPoint(points, team);

  if (next === points) return; // the match or round is already decided

  points = next;
  store.savePoints(points);
  show();
  ui.flash(team);
}

function undoPoint() {
  if (points.length === 0) return;

  points = undo(points);
  store.savePoints(points);
  show();
}

function newMatch(chosen) {
  format = chosen;
  points = [];

  store.saveFormat(format);
  store.startMatch(firstServer);

  ui.renderFormats(format);
  show();
}

// -------------------------------------------------------------- screen wake

let wakeLock = null;

async function keepAwake() {
  if (!("wakeLock" in navigator)) return;

  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
    });
  } catch {
    // Denied or unsupported. The scoreboard still works, the screen just sleeps.
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !wakeLock) keepAwake();
});

// ------------------------------------------------------------------- start

ui.renderFormats(format);
show();

// A wake lock needs a user gesture on some builds, so try immediately and
// again on the first interaction.
keepAwake();
document.addEventListener("pointerdown", () => keepAwake(), { once: true });
