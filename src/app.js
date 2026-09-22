/**
 * Wiring: touch and voice in, scoreboard out, everything persisted.
 */

import { derive, addPoint, pointLabel } from "./match.js";
import { deriveAmericano, addAmericanoPoint, americanoLabel } from "./americano.js";
import { createStore } from "./storage.js";
import { createSession, commit, undo } from "./session.js";
import { serverAt } from "./serve.js";
import { endsChanged } from "./ends.js";
import { createVoice } from "./voice.js";
import { createUI } from "./ui.js";

const store = createStore(window.localStorage);

const saved = store.load();
let format = saved.format;
let swapped = saved.swapped;
let autoEnds = saved.autoEnds;
let session = createSession(saved);

const ui = createUI({
  onPoint: score,
  onUndo: undoPoint,
  onNewMatch: newMatch,
  onSwap: swapSides,
  onAutoEnds: setAutoEnds,
});

/**
 * Which way round the board is: where the rules put the teams, if the board
 * follows the rules, corrected by however many times somebody said «смена».
 */
function sidesSwapped() {
  const byRule = autoEnds && !isAmericano() && endsChanged(session.points);
  return swapped !== byRule;
}

// ------------------------------------------------------------------ formats

const isAmericano = () => format.kind === "americano";

function currentState() {
  return isAmericano() ? deriveAmericano(session.points, format.target) : derive(session.points);
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
      server: null,
      swapped: sidesSwapped(),
      badge: state.draw ? "Draw" : state.winner ? `Team ${state.winner} wins` : "",
      status: state.matchOver ? "Round complete" : `Americano · to ${format.target}`,
      locked: state.matchOver,
    };
  }

  return {
    labels: { A: pointLabel(state, "A"), B: pointLabel(state, "B") },
    stats: { sets: state.setsWon, games: state.games },
    advantage: state.advantage,
    server: state.matchOver ? null : serverAt(session.points, session.firstServer),
    swapped: sidesSwapped(),
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

/** The points `after` adds to `before`, or none if it is not a continuation. */
function added(before, after) {
  const continues = after.length > before.length && before.every((team, i) => team === after[i]);
  return continues ? after.slice(before.length) : [];
}

/** Every change to the match, from a finger or a voice, goes through here. */
function apply(next) {
  if (next === session) return;

  const before = session.points;
  session = next;
  store.savePoints(session.points);
  show();

  // Flash whoever just scored — the at-distance sign that it landed. An undo or
  // a corrected game is not a point won, so it does not flash.
  for (const team of new Set(added(before, session.points))) ui.flash(team);

  // A point by touch can start or end a tie-break just as a spoken one can.
  voice.sync();
}

function score(team) {
  const next = isAmericano()
    ? addAmericanoPoint(session.points, team, format.target)
    : addPoint(session.points, team);

  apply(commit(session, next));
}

function undoPoint() {
  apply(undo(session));
}

/** The players changed ends: the board mirrors so each score stays on its side. */
function swapSides() {
  swapped = !swapped;
  store.saveSwapped(swapped);
  show();
}

function setAutoEnds(on) {
  autoEnds = on;
  store.saveAutoEnds(on);
  show();
}

function newMatch(chosen, firstServer) {
  format = chosen;
  session = createSession({ points: [], firstServer });
  swapped = false;
  store.saveSwapped(false);

  store.saveFormat(format);
  store.startMatch(firstServer);

  ui.renderFormats(format);
  syncVoiceEnabled();
  show();
  voice.sync();
}

// -------------------------------------------------------------------- voice

/**
 * The native side, when there is one. In a browser tab there is no recogniser,
 * and the scoreboard is simply a touch scoreboard.
 */
const native = window.PadelNative;
const callNative = (method, ...args) => {
  if (native && typeof native[method] === "function") native[method](...args);
};

const clock = (t) => new Date(t).toTimeString().slice(0, 8);

function logLine(entry) {
  const heard = entry.tokens
    ? `  [${entry.before ?? "·"} | ${entry.tokens.join(" ")} | ${entry.after ?? "·"}]`
    : "";
  const level = Number.isFinite(entry.rms) ? `  ${entry.rms.toFixed(0)} dB` : "";

  return `${clock(entry.t)}  ${entry.action.padEnd(14)} «${entry.text}»${heard}${level}`;
}

const voice = createVoice({
  now: () => Date.now(),
  // Americano counts plain points with no server to call them; it stays on touch.
  isEnabled: () => !isAmericano(),
  getMatch: () => session,
  commit: (points) => apply(commit(session, points)),
  undo: () => apply(undo(session)),
  swap: swapSides,
  tone: (kind) => callNative("tone", kind),
  setGrammar: (name, phrases) => callNative("setGrammar", name, JSON.stringify(phrases)),
  log: (entry) => ui.logVoice(logLine(entry)),
  showHeard: ui.showHeard,
  clearHeard: ui.clearHeard,
});

function syncVoiceEnabled() {
  callNative("setVoiceEnabled", !isAmericano());
}

const parse = (json) => {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
};

window.padelVoice = {
  partial: voice.partial,
  final: voice.final,
  /** The native side's own account of what it did, kept with everything heard. */
  log(json) {
    const entry = parse(json);
    if (entry) ui.logVoice(`${clock(entry.t)}  native         ${entry.text}`);
  },
  status(json) {
    const status = parse(json);
    if (status) ui.showVoiceStatus(status);
  },
};

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
ui.renderFirstServer(session.firstServer);
ui.renderAutoEnds(autoEnds);
show();

// Tell the native side the page is listening, then what it should listen for.
callNative("ready");
syncVoiceEnabled();
voice.resync();

// A wake lock needs a user gesture on some builds, so try immediately and
// again on the first interaction.
keepAwake();
document.addEventListener("pointerdown", () => keepAwake(), { once: true });
