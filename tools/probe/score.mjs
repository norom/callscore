/**
 * Score what decode.py heard, using the parser the app uses.
 *
 *   recall          commands spoken that came out as exactly that command
 *   wrong           commands spoken that came out as a different command
 *   false commands  commands found in chatter where none was spoken
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { extractSpan } from "../../src/voice-parse.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || path.join(process.env.PROBE_DIR || path.join(here, ".cache"), "cases.json");
const cases = JSON.parse(readFileSync(file, "utf8"));

const GAME = { tieBreak: false };
const heard = (results) =>
  results.map((r) => extractSpan(r.result, GAME)).filter(Boolean);
const key = (span) => JSON.stringify(span.command);
const expected = (said) => key(extractSpan(said.split(" ").map((word, i) => ({ word, start: i, end: i + 1 })), GAME));

console.log("commands            recall   wrong");
for (const snr of ["clean", 10, 5, 0]) {
  const rows = cases.filter((c) => c.kind === "command" && c.snr === snr);
  const right = rows.filter((c) => heard(c.results).some((s) => key(s) === expected(c.said)));
  const wrong = rows.filter((c) => heard(c.results).some((s) => key(s) !== expected(c.said)));

  const label = snr === "clean" ? "clean" : `babble at ${snr} dB`;
  console.log(`  ${label.padEnd(17)} ${String(right.length).padStart(2)}/${rows.length}    ${wrong.length}`);
  for (const c of rows.filter((c) => !right.includes(c))) {
    console.log(`      missed «${c.said}» — heard: ${c.results.map((r) => `«${r.text}»`).join(" ") || "nothing"}`);
  }
}

console.log("\nchatter, nothing spoken to the scoreboard");
for (const c of cases.filter((c) => c.kind === "chatter")) {
  const found = heard(c.results);
  console.log(`  ${c.said}, ${c.seconds} s: ${found.length} false command(s)`);
  for (const s of found) console.log(`      [${s.before ?? "·"} | счёт ${s.tokens.join(" ")} | ${s.after ?? "·"}]`);
}
