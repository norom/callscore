/**
 * From heard words to a command.
 *
 * The recogniser supplies words and no structure, so all of it is here: a
 * command is the wake word followed at once by one complete phrase. Anything
 * else — the wake word adrift in chatter, half a score, words in the wrong
 * order — is not a command and is ignored without fuss.
 *
 * Every score comes out the same shape, a pair of labels with the server's
 * first, in the scoreboard's own vocabulary ("0", "15", "40", "AD", or a plain
 * count in a tie-break). Deuce and advantage are scores like any other, which
 * leaves the reconciler one thing to compare rather than five. «смена» is not
 * about the score at all: the players have changed ends and the board mirrors.
 */

import { WAKE, POINT_WORDS, COUNT_WORDS } from "./grammar.js";

const LONGEST_PHRASE = 2;

/** The model writes ё, people and other sources often do not. */
const plain = (word) => word.replaceAll("ё", "е");

const plainKeys = (table) =>
  Object.fromEntries(Object.entries(table).map(([word, label]) => [plain(word), label]));

const POINTS = plainKeys(POINT_WORDS);
const COUNTS = plainKeys(COUNT_WORDS);
const LEVEL = plainKeys({ нулям: "0", пятнадцати: "15", тридцати: "30" });

const score = (server, receiver) => ({ kind: "score", labels: [server, receiver] });

/** The tokens after the wake word, which must be exactly one whole phrase. */
export function parseCommand(tokens, { tieBreak }) {
  const [first, second, ...rest] = tokens.map(plain);
  if (first === undefined || rest.length > 0) return null;

  if (second === undefined) {
    if (first === "гейм") return { kind: "game" };
    if (first === "отмена") return { kind: "undo" };
    if (first === "смена" || first === "стороны") return { kind: "swap" };
    if (tieBreak) return null;

    if (first === "ровно") return score("40", "40");
    if (first === "больше") return score("AD", "40");
    if (first === "меньше") return score("40", "AD");
    return null;
  }

  const names = tieBreak ? COUNTS : POINTS;
  if (first in names && second in names) return score(names[first], names[second]);
  if (tieBreak) return null;

  if (first === "по" && second in LEVEL) return score(LEVEL[second], LEVEL[second]);
  if (second === "все" && (first === "пятнадцать" || first === "тридцать")) {
    return score(POINTS[first], POINTS[first]);
  }
  return null;
}

/**
 * The last command in an utterance, or null. `words` is Vosk's per-word result.
 *
 * The last one, because that is how a slip gets corrected: «счёт ноль
 * пятнадцать… счёт пятнадцать ноль». The words either side and the timing are
 * reported for the log — whether a command sat alone or in the middle of
 * running speech is the most promising way to tell the wearer from the crowd,
 * but that needs real matches to tune, not guesses.
 */
export function extractSpan(words, options) {
  if (!Array.isArray(words)) return null;

  const wake = plain(WAKE);

  for (let i = words.length - 1; i >= 0; i--) {
    if (plain(words[i].word) !== wake) continue;

    for (let length = LONGEST_PHRASE; length >= 1; length--) {
      const phrase = words.slice(i + 1, i + 1 + length);
      if (phrase.length < length) continue;

      const tokens = phrase.map((entry) => entry.word);
      const command = parseCommand(tokens, options);
      if (!command) continue;

      const last = phrase[phrase.length - 1];
      return {
        command,
        tokens,
        before: words[i - 1]?.word ?? null,
        after: words[i + 1 + length]?.word ?? null,
        startMs: Math.round(words[i].start * 1000),
        endMs: Math.round(last.end * 1000),
      };
    }
  }
  return null;
}
