/**
 * The voice channel: recognised words in, a changed match and a tone out.
 *
 * The tones are the whole conversation with someone who cannot look at the
 * screen mid-rally, so what each one means is kept strict:
 *
 *   ok       the board now says what you called (or already did)
 *   confirm  understood, but it is a leap from the board — say it again
 *   fail     understood, and it cannot be applied
 *   silence  nothing was taken as a command
 *
 * Silence matters as much as the tones. Other people say «какой счёт?» all
 * match long, and a buzz for every one of those would teach the wearer to stop
 * listening.
 *
 * Everything this touches is handed in, so the policy is tested without a
 * phone, a microphone or a clock.
 */

import { derive } from "./match.js";
import { reconcile } from "./reconcile.js";
import { extractSpan } from "./voice-parse.js";
import { GRAMMARS, WAKE } from "./grammar.js";

/** How long a repeat still counts as the same request. */
export const REPEAT_WINDOW_MS = 8000;

const parse = (json) => {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
};

export function createVoice({
  now,
  isEnabled,
  getMatch,
  commit,
  undo,
  swap,
  tone,
  setGrammar,
  log,
  showHeard,
  clearHeard,
}) {
  let sentGrammar = null;

  /** A leap waiting to be said again: what, when, and the board it was a leap from. */
  let pending = null;

  /** The last «гейм» or «отмена» applied, so an echo of it is not a second one. */
  let lastOnce = null;

  const grammarName = () => (derive(getMatch().points).tieBreak ? "tiebreak" : "game");

  function sync() {
    const name = grammarName();
    if (name === sentGrammar) return;

    sentGrammar = name;
    setGrammar(name, GRAMMARS[name]);
  }

  /** The native side has started over and knows nothing. */
  function resync() {
    sentGrammar = null;
    sync();
  }

  function partial(json) {
    const text = parse(json)?.text ?? "";

    if (isEnabled() && text.includes(WAKE)) showHeard(text);
    else clearHeard();
  }

  function final(json) {
    clearHeard();

    const payload = parse(json);
    const text = payload?.vosk?.text;
    if (!text || !isEnabled()) return;

    const entry = { t: payload.t ?? now(), text, rms: payload.rms ?? null };
    const done = (action, extra = {}) => log({ ...entry, ...extra, action });

    // A switch of grammar takes a moment to reach the recogniser, and point
    // names decoded during a tie-break mean nothing.
    const expected = grammarName();
    if (payload.grammar && payload.grammar !== expected) return done("stale-grammar");

    const span = extractSpan(payload.vosk.result, { tieBreak: expected === "tiebreak" });
    if (!span) return done("ignored");

    const { command, ...heard } = span;
    const outcome = act(command);

    if (outcome.tone) tone(outcome.tone);
    done(outcome.action, heard);
    sync();
  }

  function act(command) {
    const at = now();
    const key = JSON.stringify(command);
    const match = getMatch();

    if (command.kind !== "score") {
      const echo = lastOnce && lastOnce.key === key && at - lastOnce.at <= REPEAT_WINDOW_MS;
      if (echo) return { tone: "ok", action: "echo" };
    }

    if (command.kind === "swap") {
      swap();
      lastOnce = { key, at };
      return { tone: "ok", action: "swap" };
    }

    if (command.kind === "undo") {
      if (match.points.length === 0 && match.history.length === 0) {
        return { tone: "fail", action: "nothing-to-undo" };
      }
      undo();
      pending = null;
      lastOnce = { key, at };
      return { tone: "ok", action: "undo" };
    }

    const result = reconcile(match.points, match.firstServer, command);
    if (result.error) return { tone: "fail", action: result.error };
    if (result.tier === "noop") return { tone: "ok", action: "noop" };

    if (result.tier === "confirm") {
      const repeated =
        pending &&
        pending.key === key &&
        pending.from === match.points &&
        at - pending.at <= REPEAT_WINDOW_MS;

      if (!repeated) {
        pending = { key, at, from: match.points };
        return { tone: "confirm", action: "confirm-asked" };
      }
    }

    commit(result.points);
    pending = null;
    if (command.kind === "game") lastOnce = { key, at };

    return { tone: "ok", action: result.tier === "confirm" ? "confirmed" : "apply" };
  }

  return { partial, final, sync, resync };
}
