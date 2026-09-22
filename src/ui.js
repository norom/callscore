/**
 * Rendering and on-screen controls.
 *
 * Holds no match state of its own — it is handed a derived state and puts it on
 * the glass. The only thing it remembers is which side scored last, so it can
 * flash that field.
 */

const FLASH_MS = 420;

const el = (id) => document.getElementById(id);

export function createUI(handlers) {
  const nodes = {
    format: el("format"),
    sideA: el("sideA"),
    sideB: el("sideB"),
    scoreA: el("scoreA"),
    scoreB: el("scoreB"),
    setsA: el("setsA"),
    setsB: el("setsB"),
    gamesA: el("gamesA"),
    gamesB: el("gamesB"),
    serveA: el("serveA"),
    serveB: el("serveB"),
    badge: el("netBadge"),
    btnA: el("btnA"),
    btnB: el("btnB"),
    btnUndo: el("btnUndo"),
    newBtn: el("newBtn"),
    swapBtn: el("swapBtn"),
    autoEnds: el("autoEnds"),
    board: document.querySelector(".board"),
    voiceBtn: el("voiceBtn"),
    fullscreenBtn: el("fullscreenBtn"),
    probe: el("scoreProbe"),
    confirmSheet: el("confirmSheet"),
    confirmCancel: el("confirmCancel"),
    voiceSheet: el("voiceSheet"),
    voiceDone: el("voiceDone"),
    voiceCopy: el("voiceCopy"),
    voiceStatus: el("voiceStatus"),
    voiceLog: el("voiceLog"),
  };

  const flashTimers = { A: null, B: null };

  // ------------------------------------------------------------- rendering

  /**
   * Takes a view model rather than a match state, so the same screen serves
   * both formats without knowing how either of them scores.
   */
  function render(view) {
    nodes.scoreA.textContent = view.labels.A;
    nodes.scoreB.textContent = view.labels.B;

    // Sets and games mean nothing in Americano, so the row goes away entirely
    // rather than sitting there reading zero.
    const showStats = Boolean(view.stats);
    for (const stats of document.querySelectorAll(".stats")) stats.hidden = !showStats;

    // With the stats gone there are only two things left in the column, and
    // spreading two items evenly leaves the score sitting below centre.
    nodes.sideA.classList.toggle("side--simple", !showStats);
    nodes.sideB.classList.toggle("side--simple", !showStats);

    if (showStats) {
      nodes.setsA.textContent = view.stats.sets.A;
      nodes.setsB.textContent = view.stats.sets.B;
      nodes.gamesA.textContent = view.stats.games.A;
      nodes.gamesB.textContent = view.stats.games.B;
    }

    nodes.board.classList.toggle("board--swapped", Boolean(view.swapped));

    nodes.serveA.hidden = view.server !== "A";
    nodes.serveB.hidden = view.server !== "B";

    nodes.sideA.classList.toggle("side--advantage", view.advantage === "A");
    nodes.sideB.classList.toggle("side--advantage", view.advantage === "B");

    setBadge(view.badge);

    nodes.btnA.disabled = view.locked;
    nodes.btnB.disabled = view.locked;
    nodes.format.textContent = view.status;

    fitScores();
  }

  /**
   * Size the score to the widest string the slot can ever hold, not to the
   * string currently in it, so digits do not jump between 40 and AD. The system
   * font is whatever the device provides, so this is measured rather than
   * assumed.
   */
  const SIDE_GUTTER = 20;
  const MIN_SCORE_PX = 28;

  function fitScores() {
    nodes.scoreA.style.fontSize = "";
    nodes.scoreB.style.fontSize = "";

    let size = parseFloat(getComputedStyle(nodes.scoreA).fontSize);
    if (!Number.isFinite(size) || size <= 0) return;

    const available = nodes.sideA.clientWidth - SIDE_GUTTER;
    nodes.probe.style.fontSize = `${size}px`;

    const widest = nodes.probe.getBoundingClientRect().width;
    if (widest > available && widest > 0) {
      size = Math.max(MIN_SCORE_PX, Math.floor((size * available) / widest));
    }
    apply(size);

    // The slot can also be short rather than narrow, which happens in landscape
    // on a small phone.
    let guard = 0;
    while (guard++ < 14 && size > MIN_SCORE_PX && overflowsVertically()) {
      size = Math.max(MIN_SCORE_PX, Math.floor(size * 0.92));
      apply(size);
    }
  }

  function apply(size) {
    nodes.scoreA.style.fontSize = `${size}px`;
    nodes.scoreB.style.fontSize = `${size}px`;
  }

  function overflowsVertically() {
    return (
      nodes.sideA.scrollHeight > nodes.sideA.clientHeight + 1 ||
      nodes.sideB.scrollHeight > nodes.sideB.clientHeight + 1
    );
  }

  let badgeText = "";

  function setBadge(text) {
    badgeText = text;
    if (nodes.badge.hasAttribute("data-pending")) return;

    nodes.badge.textContent = text;
    if (text) nodes.badge.setAttribute("data-shown", "");
    else nodes.badge.removeAttribute("data-shown");
  }

  /**
   * Shows a spoken command as it arrives, while the score itself stays put.
   * The score moving word by word would read as the number changing by itself;
   * it moves once, when the phrase is complete.
   */
  function showHeard(text) {
    nodes.badge.textContent = text;
    nodes.badge.setAttribute("data-shown", "");
    nodes.badge.setAttribute("data-pending", "yes");
  }

  function clearHeard() {
    if (!nodes.badge.hasAttribute("data-pending")) return;

    nodes.badge.removeAttribute("data-pending");
    setBadge(badgeText);
  }

  /** Brief lift of a whole field — the at-distance confirmation that a press landed. */
  function flash(team) {
    const side = team === "A" ? nodes.sideA : nodes.sideB;

    side.classList.remove("side--scored");
    void side.offsetWidth; // restart the transition if points come quickly
    side.classList.add("side--scored");

    clearTimeout(flashTimers[team]);
    flashTimers[team] = setTimeout(() => side.classList.remove("side--scored"), FLASH_MS);
  }

  // ---------------------------------------------------------------- sheets

  function openSheet(sheet) {
    sheet.hidden = false;
  }

  function closeSheet(sheet) {
    sheet.hidden = true;
  }

  function confirmNewMatch() {
    openSheet(nodes.confirmSheet);
  }

  function formatOf(row) {
    return row.dataset.kind === "americano"
      ? { kind: "americano", target: Number(row.dataset.target) }
      : { kind: "tennis" };
  }

  function renderAutoEnds(on) {
    nodes.autoEnds.checked = on;
  }

  let chosenServer = "A";

  function renderFirstServer(team) {
    chosenServer = team;
    for (const option of document.querySelectorAll(".serve-option")) {
      option.toggleAttribute("data-current", option.dataset.team === team);
    }
  }

  /** Marks what is being played, so the sheet also answers "which format is this?". */
  function renderFormats(format) {
    for (const row of document.querySelectorAll(".format-row")) {
      const candidate = formatOf(row);
      const same =
        candidate.kind === format.kind &&
        (format.kind !== "americano" || candidate.target === format.target);

      row.toggleAttribute("data-current", same);
    }
  }

  // ------------------------------------------------------ voice diagnostics

  const MIC_NAMES = { earbuds: "Earbuds", phone: "Phone microphone", none: "No microphone" };

  /**
   * Which microphone is really in use, as the recorder reports it — not which
   * one was asked for. The phone's own mic courtside hears the whole court, so
   * a silent fallback to it would look like bad recognition, not bad routing.
   */
  function showVoiceStatus(status) {
    const mic = status.mic in MIC_NAMES ? status.mic : "none";
    nodes.voiceBtn.setAttribute("data-mic", status.state === "listening" ? mic : "none");

    const lines = [
      `${status.state}${status.message ? ` — ${status.message}` : ""}`,
      `${MIC_NAMES[mic]}${status.device ? `: ${status.device}` : ""}`,
    ];
    if (status.route) lines.push(`route: ${status.route}`);
    if (status.grammar) lines.push(`grammar: ${status.grammar}`);
    if (Number.isFinite(status.rtf)) lines.push(`decode load: ${Math.round(status.rtf * 100)}%`);
    if (Number.isFinite(status.level)) {
      // What the microphone delivers: a voice nearby reads around −20, an
      // empty room −60, a dead route −100 with a peak of 0.
      lines.push(`input: ${Math.round(status.level)} dB, peak ${status.peak}`);
      lines.push(`heard: ${status.chunks} chunks, ${status.partials} partials, ${status.finals} finals`);
    }
    if (Number.isFinite(status.battery)) lines.push(`battery: ${status.battery}%`);

    nodes.voiceStatus.textContent = lines.join("\n");
  }

  /**
   * A running list of what the recogniser heard and what was done about it.
   * Thresholds can only be tuned from what actually happened on court, and the
   * court is not where anyone reads a log — hence the copy button.
   */
  const heard = [];
  const HEARD_LIMIT = 200;

  function logVoice(line) {
    heard.push(line);
    if (heard.length > HEARD_LIMIT) heard.shift();

    nodes.voiceLog.classList.remove("empty");
    nodes.voiceLog.textContent = heard.slice(-12).join("\n");
  }

  function buildReport() {
    return [
      "CALLSCORE — DIAGNOSTICS",
      navigator.userAgent,
      "",
      "STATUS",
      nodes.voiceStatus.textContent,
      "",
      "HEARD",
      heard.join("\n") || "(nothing yet)",
    ].join("\n");
  }

  function copyReport() {
    const text = buildReport();

    // The wrapper hands this to Android's clipboard, which works where the
    // async clipboard API in a WebView often does not.
    if (window.PadelNative && typeof window.PadelNative.copy === "function") {
      window.PadelNative.copy(text);
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(text).catch(() => window.prompt("Copy this:", text));
    } else {
      window.prompt("Copy this:", text);
    }

    nodes.voiceCopy.textContent = "Copied";
    setTimeout(() => (nodes.voiceCopy.textContent = "Copy report"), 1500);
  }

  // ----------------------------------------------------------------- wiring

  nodes.btnA.addEventListener("click", () => handlers.onPoint("A"));
  nodes.btnB.addEventListener("click", () => handlers.onPoint("B"));
  nodes.btnUndo.addEventListener("click", () => handlers.onUndo());

  nodes.newBtn.addEventListener("click", confirmNewMatch);
  nodes.swapBtn.addEventListener("click", () => handlers.onSwap());
  nodes.autoEnds.addEventListener("change", () => handlers.onAutoEnds(nodes.autoEnds.checked));
  nodes.confirmCancel.addEventListener("click", () => closeSheet(nodes.confirmSheet));

  for (const row of document.querySelectorAll(".format-row")) {
    row.addEventListener("click", () => {
      closeSheet(nodes.confirmSheet);
      handlers.onNewMatch(formatOf(row), chosenServer);
    });
  }

  for (const option of document.querySelectorAll(".serve-option")) {
    option.addEventListener("click", () => renderFirstServer(option.dataset.team));
  }

  nodes.voiceBtn.addEventListener("click", () => openSheet(nodes.voiceSheet));
  nodes.voiceDone.addEventListener("click", () => closeSheet(nodes.voiceSheet));
  nodes.voiceCopy.addEventListener("click", copyReport);

  nodes.fullscreenBtn.addEventListener("click", toggleFullscreen);

  // The wrapper is already immersive, so the button would do nothing there.
  if (window.PadelNative) nodes.fullscreenBtn.hidden = true;

  window.addEventListener("resize", fitScores);
  // Android reports the new size a beat after the rotation animation.
  window.addEventListener("orientationchange", () => setTimeout(fitScores, 150));

  return {
    render,
    flash,
    renderFormats,
    renderFirstServer,
    renderAutoEnds,
    showHeard,
    clearHeard,
    showVoiceStatus,
    logVoice,
  };
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen({ navigationUI: "hide" });
  } catch {
    // Fullscreen is a nicety; a phone that refuses it still keeps score.
  }
}
