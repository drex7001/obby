/**
 * The DOM layer: HUD, callouts and the results screen.
 *
 * Everything is written imperatively and only when a value actually changes -
 * the render loop calls into here 60 times a second, and rebuilding the
 * leaderboard's DOM on every one of those frames is a real cost for no gain.
 */

import { formatClock, ordinal } from "../shared/math.js";
import { PLAYER_COLOURS } from "./render/scene.js";

export interface BoardRow {
  sessionId: string;
  name: string;
  colour: number;
  rank: number;
  progress: number;
  finished: boolean;
  dnf: boolean;
  finishMs: number;
  self: boolean;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class UI {
  private hud = $("hud");
  private posRank = $("pos-rank");
  private posOf = $("pos-of");
  private section = $("section");
  private clock = $("clock");
  private round = $("round");
  private board = $<HTMLOListElement>("board");
  private notes = $("notes");
  private centre = $("centre");

  private overlay = $("overlay");
  private joinBtn = $<HTMLButtonElement>("join-btn");
  private nameInput = $<HTMLInputElement>("name-input");
  private joinStatus = $("join-status");

  private resume = $("resume");
  private resumeBtn = $<HTMLButtonElement>("resume-btn");

  private results = $("results");
  private resultsTitle = $("results-title");
  private resultsList = $<HTMLOListElement>("results-list");
  private resultsNext = $("results-next");

  private lastClock = "";
  private lastPos = "";
  private lastSection = "";
  private lastNotes = "";
  private lastBoardKey = "";
  private calloutUntil = 0;
  private calloutKey = "";

  constructor() {
    this.nameInput.value = localStorage.getItem("gauntlet.name") ?? "";
  }

  // ------------------------------------------------------------------- join

  onJoin(handler: (name: string) => void) {
    const go = () => {
      const name = this.nameInput.value.trim();
      localStorage.setItem("gauntlet.name", name);
      handler(name);
    };
    this.joinBtn.addEventListener("click", go);
    this.nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !this.joinBtn.disabled) { go(); }
    });
  }

  setJoinEnabled(enabled: boolean) { this.joinBtn.disabled = !enabled; }

  setJoinStatus(text: string, error = false) {
    this.joinStatus.textContent = text;
    this.joinStatus.classList.toggle("error", error);
  }

  enterGame() {
    this.overlay.hidden = true;
    this.hud.hidden = false;
  }

  // ----------------------------------------------------------------- resume

  /**
   * Clicking anywhere on the prompt counts, not just the button - after an
   * Alt+Tab the natural thing to do is click back into the window, and that
   * click should be the one that recaptures the mouse.
   */
  onResume(handler: () => void) {
    this.resume.addEventListener("mousedown", handler);
    this.resumeBtn.addEventListener("click", handler);
  }

  showResume() {
    if (this.results.hidden) { this.resume.hidden = false; }
  }

  hideResume() { this.resume.hidden = true; }

  // -------------------------------------------------------------------- HUD

  setPosition(rank: number, total: number) {
    const key = `${rank}/${total}`;
    if (key === this.lastPos) { return; }
    this.lastPos = key;
    this.posRank.textContent = rank > 0 ? ordinal(rank) : "--";
    this.posOf.textContent = total > 0 ? `of ${total}` : "";
  }

  setSection(label: string) {
    if (label === this.lastSection) { return; }
    this.lastSection = label;
    this.section.textContent = label;
  }

  setClock(ms: number, urgent: boolean) {
    const text = formatClock(ms);
    if (text !== this.lastClock) {
      this.lastClock = text;
      this.clock.textContent = text;
    }
    this.clock.classList.toggle("urgent", urgent);
  }

  setRound(round: number, phase: string) {
    this.round.textContent = `Round ${round + 1} · ${phase}`;
  }

  setNotes(notes: string[]) {
    const text = notes.join(" · ");
    if (text === this.lastNotes) { return; }
    this.lastNotes = text;
    this.notes.textContent = text;
  }

  setBoard(rows: BoardRow[]) {
    // Rebuild only when the visible content actually changed.
    const key = rows.map((r) =>
      `${r.sessionId}:${r.rank}:${r.finished ? 1 : 0}:${r.dnf ? 1 : 0}:${Math.round(r.progress * 200)}`,
    ).join("|");
    if (key === this.lastBoardKey) { return; }
    this.lastBoardKey = key;

    this.board.replaceChildren(...rows.map((r) => {
      const li = document.createElement("li");
      if (r.self) { li.classList.add("self"); }
      if (r.finished) { li.classList.add("done"); }
      else if (r.dnf) { li.classList.add("out"); }

      const n = document.createElement("span");
      n.className = "n";
      n.textContent = String(r.rank || "-");

      const pip = document.createElement("span");
      pip.className = "pip";
      pip.style.background = PLAYER_COLOURS[r.colour % PLAYER_COLOURS.length];

      const who = document.createElement("span");
      who.className = "who";
      who.textContent = r.name;

      const val = document.createElement("span");
      val.className = "val";
      val.textContent = r.finished
        ? formatClock(r.finishMs)
        : r.dnf ? "out" : `${Math.round(r.progress * 100)}%`;

      li.append(n, pip, who, val);
      return li;
    }));
  }

  /**
   * A transient centre-screen message. `key` dedupes repeats, so calling this
   * every frame with the same content does not restart the animation.
   */
  callout(key: string, text: string, sub = "", cls = "", holdMs = 1100) {
    const now = performance.now();
    if (key === this.calloutKey && now < this.calloutUntil) { return; }
    this.calloutKey = key;
    this.calloutUntil = now + holdMs;

    const main = document.createElement("div");
    main.className = `callout ${cls}`.trim();
    main.textContent = text;
    const nodes: HTMLElement[] = [main];
    if (sub) {
      const s = document.createElement("div");
      s.className = "callout sub";
      s.textContent = sub;
      nodes.push(s);
    }
    this.centre.replaceChildren(...nodes);
  }

  tickCallout() {
    if (this.calloutKey && performance.now() > this.calloutUntil) {
      this.calloutKey = "";
      this.centre.replaceChildren();
    }
  }

  clearCallout() {
    this.calloutKey = "";
    this.calloutUntil = 0;
    this.centre.replaceChildren();
  }

  // ---------------------------------------------------------------- results

  showResults(rows: BoardRow[], title: string) {
    this.resume.hidden = true;
    this.resultsTitle.textContent = title;
    this.resultsList.replaceChildren(...rows.map((r) => {
      const li = document.createElement("li");
      if (r.self) { li.classList.add("self"); }

      const place = document.createElement("span");
      place.className = "place";
      place.textContent = r.finished ? ordinal(r.rank) : "—";

      const pip = document.createElement("span");
      pip.className = "pip";
      pip.style.background = PLAYER_COLOURS[r.colour % PLAYER_COLOURS.length];

      const who = document.createElement("span");
      who.className = "who";
      who.textContent = r.name;

      const time = document.createElement("span");
      time.className = r.finished ? "time" : "time out";
      time.textContent = r.finished ? formatClock(r.finishMs) : "did not finish";

      li.append(place, pip, who, time);
      return li;
    }));
    this.results.hidden = false;
  }

  setResultsCountdown(seconds: number) {
    this.resultsNext.textContent = seconds > 0
      ? `Next round in ${seconds}…`
      : "Starting the next round…";
  }

  hideResults() { this.results.hidden = true; }

  get resultsVisible() { return !this.results.hidden; }
}
