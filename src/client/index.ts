/**
 * Client bootstrap and the render loop.
 *
 * The shape of the netcode:
 *
 *   - The server is authoritative and runs `stepPlayer()` once per input.
 *   - We run the SAME `stepPlayer()` the instant a key is pressed, and the SDK's
 *     reconciler replays every unacknowledged input whenever server truth
 *     arrives. Local movement therefore has no latency at all.
 *   - Other runners are interpolated from the server stream - we never predict
 *     someone else's input.
 *   - The course is not networked. `state.seed` is, and `buildLevel(seed)`
 *     reproduces it exactly on both ends; moving parts are then a pure function
 *     of a world tick, which is why prediction can collide with a moving
 *     platform correctly instead of guessing where it is.
 */

import "./style.css";

import { ColyseusSDK } from "@colyseus/sdk";
import { Predict } from "@colyseus/sdk/predict";

import type { default as server } from "../app.config.js";
import type { Player, RaceInput, RacePhase } from "../rooms/schema/RaceState.js";

import {
  AMMO_MAX, COLLECT_TOKENS, MIN_PLAYERS, RECALL_TICKS, REMOTE_INTERP_MS,
  SHOT_EYE, TETHER_HAND, TICK_RATE,
} from "../shared/constants.js";
import { buildLevelWith, type Level } from "../shared/level.js";
import { clamp } from "../shared/math.js";
import type { EnemyView } from "../shared/enemies.js";
import type { OtherBody, SimWorld, StepCtx } from "../shared/movement.js";
import { stepPlayer } from "../shared/movement.js";
import type { WorldPhase } from "../shared/obstacles.js";
import { findAnchor, selectAnchor } from "../shared/tether.js";
import { clearRecallRing, makeRecallRing, recallSampleAt } from "../shared/recall.js";

import { Input } from "./input.js";
import { FollowCamera } from "./camera.js";
import { UI, type BoardRow, type Rival } from "./ui.js";
import { Stage } from "./render/scene.js";
import { Course } from "./render/course.js";
import { Avatars, type AvatarView } from "./render/avatars.js";
import { Fx } from "./render/fx.js";
import { Threats } from "./render/threats.js";

const STEP_MS = 1000 / TICK_RATE;

/**
 * Exactly the fields `stepPlayer` reads or writes. Listing them explicitly
 * keeps the server-owned ones (rank, finishMs, dnf...) out of the reconciler,
 * which would otherwise treat every rank change as a misprediction.
 */
const SIM_FIELDS = [
  "x", "y", "z", "vx", "vy", "vz", "yaw",
  "grounded", "groundId", "coyote", "jumpBuf", "jumpHeld",
  "stun", "respawn", "checkpoint", "progress",
  "chain", "impactBuf", "heavyHeld", "heavyArmed", "heavySince", "plantUntil", "chainDecayUntil",
  "carving", "carveUntil", "carveCool", "hopWindow",
  "knockTick", "knockX", "knockY", "knockZ",
  "ammo", "fireCool", "actionHeld", "useHeld", "pickupIn",
  "burnTick", "burnAmount", "shieldUntil",
  "anchorId", "ropeLen", "tension", "tetherCool", "tetherUntil",
  "recallCharges", "recallUntil", "recallHeld",
] as const;

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const plateHost = document.getElementById("nameplates")!;

const stage = new Stage(canvas);
const ui = new UI();
const keys = new Input(canvas);
const camera = new FollowCamera(stage);
const fx = new Fx(stage);
const avatars = new Avatars(stage, plateHost);

ui.setJoinStatus("Ready when you are.");
ui.setJoinEnabled(true);
ui.onJoin((name) => {
  ui.setJoinEnabled(false);
  ui.setJoinStatus("Joining a match…");
  fx.enableAudio();
  connect(name).catch((err) => {
    console.error(err);
    ui.setJoinStatus("Could not join a match. Is the server running?", true);
    ui.setJoinEnabled(true);
  });
});

async function connect(name: string) {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const client = new ColyseusSDK<typeof server>(`${scheme}://${location.host}`);
  const room = await client.joinOrCreate("race", { name });

  const predict = Predict.get(room);
  // Other runners are smoothed toward the server stream, never predicted.
  predict.attachAll("players", {
    mode: "lerp",
    fields: ["x", "y", "z", "yaw", "vy"],
    smoothMs: REMOTE_INTERP_MS,
  });

  const input = room.input<RaceInput>({ mode: "reliable" });

  // The first patch is what creates our own Player.
  await new Promise<void>((resolve) => room.onStateChange.once(() => resolve()));
  const self = room.state.players.get(room.sessionId) as Player | undefined;
  if (!self) { throw new Error("joined but no player was created"); }

  /**
   * The course, rebuilt exactly the way the room built it.
   *
   * The seed alone is no longer enough: a round's mutators are published, and
   * building without them produces a different course - a different section
   * count, a mirrored layout, different gravity. Reading both is what keeps
   * "the level is never transmitted" true while the deck exists.
   */
  const courseOptions = () => ({
    mutators: room.state.mutators ? room.state.mutators.split(",") : [],
    tokens: room.state.mode === "collect" ? COLLECT_TOKENS : 0,
  });
  let level: Level = buildLevelWith(room.state.seed, courseOptions());
  const course = new Course(stage, level);
  const threats = new Threats(stage);

  // ------------------------------------------------------- the client's world
  const phase: WorldPhase = {
    raceStartTick: -1,
    crumbleTicks: [],
    plateTicks: [],
    plateSince: [],
    breakerTicks: [],
    pickupTicks: [],
    shellTicks: [],
  };
  const others: OtherBody[] = [];
  const otherPool: OtherBody[] = [];
  // Our own Recall ring. The reconciler keeps an identical buffer for rollback;
  // this one is the same shape written from the same step, and neither is sent.
  const history = makeRecallRing();
  // Enemies are mirrored out of the schema once a frame, for the same reason
  // the room mirrors them in: the shared step reads them on every sub-step and
  // a change-tracking proxy is the wrong shape for that.
  const enemies: EnemyView[] = [];

  const world: SimWorld = {
    level,
    phase,
    tickBase: 0,
    others,
    enemies,
    history,
    fx: (kind, x, y, z) => {
      const d = Math.hypot(
        stage.camera.position.x - x,
        stage.camera.position.y - y,
        stage.camera.position.z - z,
      );
      fx.burst(kind, x, y, z, d);
      if (kind === "hit") { camera.impulse(0.85); }
      else if (kind === "land") { camera.impulse(0.16); }
    },
  };

  const me = predict.reconciler(self, {
    input,
    fields: SIM_FIELDS as unknown as (keyof Player & string)[],
    // The very same function the server runs. Determinism is the whole contract.
    step: (ctx: StepCtx, state, command) => stepPlayer(ctx, state as any, command as any, world),
    smoothMs: 60,
  });

  stage.setFog(level.mutators.includes("fog"));
  camera.reset(self.x, self.y, self.z);
  ui.enterGame();
  void keys.lock();

  // Escape, Alt+Tab and losing window focus all drop the pointer lock, and the
  // browser will not give it back without a fresh gesture - so ask for one
  // instead of leaving the player with a camera that no longer turns.
  keys.onLockChange((locked) => {
    if (locked) { ui.hideResume(); } else { ui.showResume(); }
  });
  ui.onResume(() => { void keys.lock(); });

  // Start a solo practice run once the lobby has let us.
  addEventListener("keydown", (e) => {
    if (e.key === "Enter" && room.state.phase === "waiting") {
      room.send("solo", {});
      return;
    }
    // The two deliberate purchases. Burn is on the input packet instead,
    // because it is a movement decision made at speed and has to land on an
    // exact tick; these two do not.
    if (e.key === "1") { room.send("buy", { item: "shield" }); }
    if (e.key === "2") { room.send("buy", { item: "key" }); }
    if (e.key === "3") { room.send("buy", { item: "recall" }); }
    // A finished runner's one charge, spent on the section it is aimed at.
    if (e.key === "x" && (self.finished || self.dnf)) {
      const target = nearestBreaker(level, me.value("x") as number, me.value("z") as number);
      if (target >= 0) { room.send("influence", { slot: target }); }
    }
  });

  room.onLeave(() => {
    ui.callout("left", "Disconnected", "Reload to rejoin", "warm", 1e9);
  });

  room.onMessage("raceOver", () => { /* results are driven from state.phase */ });

  // Attribution is the social payload: the fun is that runners know who did it.
  room.onMessage("influence", (msg: any) => {
    ui.callout(`inf-${msg.slot}`, "Incoming", `${msg.by} is changing the course`, "warm", 2400);
  });

  // ------------------------------------------------------------- render loop
  // Deliberately unset: the first frame seeds it, so no wall-clock gap between
  // wiring up and the first animation frame is ever accumulated.
  let lastNow = -1;
  let renderAcc = 0;
  let lastSeed = room.state.seed;
  let lastDeck = room.state.mutators;
  let lastRound = room.state.round;
  let lastCheckpoint = self.checkpoint;
  let wasFinished = false;
  let lastPhase = room.state.phase as RacePhase;
  // Hysteresis on the rival markers. Two runners a hair apart would otherwise
  // swap places every frame, which is unreadable and slightly maddening.
  let rivalAhead: string | null = null;
  let rivalBehind: string | null = null;
  const RIVAL_STICK = 0.004;

  /** Mirror the handful of synchronised integers the obstacles depend on. */
  function syncPhase() {
    phase.raceStartTick = room.state.raceStartTick;
    copyInto(phase.crumbleTicks as number[], room.state.crumbleTicks);
    copyInto(phase.plateTicks as number[], room.state.plateTicks);
    copyInto(phase.plateSince as number[], room.state.plateSince);
    copyInto(phase.breakerTicks as number[], room.state.breakerTicks);
    copyInto(phase.pickupTicks as number[], room.state.pickupTicks);
    copyInto(phase.shellTicks as number[], room.state.shellTicks);
  }

  function buildEnemies() {
    enemies.length = 0;
    for (const [, e] of room.state.enemies) {
      enemies.push({
        id: e.id, kind: e.kind, alive: e.alive, action: e.action,
        fromTick: e.fromTick, toTick: e.toTick,
        x0: e.x0, y0: e.y0, z0: e.z0,
        dx: e.dx, dz: e.dz, speed: e.speed, turn: e.turn,
      });
    }
  }

  function buildOthers() {
    others.length = 0;
    let i = 0;
    for (const [sessionId, player] of room.state.players) {
      if (sessionId === room.sessionId || !player.connected) { continue; }
      const slot = otherPool[i] ?? (otherPool[i] = { x: 0, y: 0, z: 0 });
      slot.x = predict.value(player, "x");
      slot.y = predict.value(player, "y");
      slot.z = predict.value(player, "z");
      others.push(slot);
      i++;
    }
  }

  function frame(now: number) {
    if (lastNow < 0) { lastNow = now; }
    const dtMs = Math.min(now - lastNow, 100);
    lastNow = now;
    const dt = dtMs / 1000;

    // A new round means a new seed, a new deck, and a whole new course.
    if (room.state.seed !== lastSeed || room.state.mutators !== lastDeck) {
      lastSeed = room.state.seed;
      lastDeck = room.state.mutators;
      level = buildLevelWith(lastSeed, courseOptions());
      world.level = level;
      course.rebuild(level);
      stage.setFog(level.mutators.includes("fog"));
      camera.reset(self.x, self.y, self.z);
    }
    if (room.state.round !== lastRound) {
      lastRound = room.state.round;
      lastCheckpoint = -1;
      wasFinished = false;
      clearRecallRing(history);
    }

    syncPhase();
    buildOthers();
    buildEnemies();
    world.tickBase = self.active
      ? self.tickBase
      : room.state.tick - input.sentCount;

    // --------------------------------------------------- input at the sim rate
    const steps = predict.tick(now);
    renderAcc += dtMs;
    const wantRespawn = keys.takeRespawn();
    for (let i = 0; i < steps; i++) {
      input.data.moveX = keys.moveX;
      input.data.moveZ = keys.moveZ;
      input.data.yaw = keys.yaw;
      input.data.pitch = keys.pitch;
      input.data.jump = keys.jump;
      input.data.action = keys.action;
      input.data.alt = keys.alt;
      input.data.use = keys.use;
      // One-shot: only the first step of this frame carries the press.
      input.data.respawn = i === 0 && wantRespawn;
      input.send();
    }
    renderAcc = clamp(renderAcc - steps * STEP_MS, 0, STEP_MS);

    // The world tick our own predicted body currently sits at, so the course is
    // drawn at the instant the collision resolved against it.
    const renderTick = world.tickBase + input.sentCount + renderAcc / STEP_MS;

    course.update(renderTick, phase);
    course.setReached(self.checkpoint);
    threats.update(enemies, renderTick);

    // The tether, drawn from the predicted body rather than the server's: the
    // rope has to be attached to where the player believes they are, or it
    // lags a frame behind the runner it is holding up.
    const px = me.value("x"), py = me.value("y"), pz = me.value("z");
    const held = me.value("anchorId") !== 0
      ? findAnchor(level, (me.value("anchorId") as number) - 1) ?? null
      : null;
    course.setTether(held, px, py + TETHER_HAND, pz);
    const target = held ?? selectAnchor(
      level, phase, renderTick, px, py + SHOT_EYE, pz, keys.yaw, keys.pitch,
    );
    course.setAim(target ? target.id : -1);

    // The ghost appears the moment the context action goes down, which is what
    // makes the four-tick arm a decision rather than a delay.
    const arming = (me.value("recallHeld") as number) > 0 && self.recallCharges > 0;
    const destination = arming
      ? recallSampleAt(history, Math.floor(world.tickBase + input.sentCount) - RECALL_TICKS)
      : null;
    course.setGhost(destination ? destination.x : null, destination?.y, destination?.z);

    // --------------------------------------------------------------- avatars
    const views: AvatarView[] = [];
    for (const [sessionId, player] of room.state.players) {
      views.push({
        sessionId,
        name: player.name,
        colour: player.colour,
        x: predict.value(player, "x"),
        y: predict.value(player, "y"),
        z: predict.value(player, "z"),
        yaw: predict.value(player, "yaw"),
        vy: predict.value(player, "vy"),
        grounded: player.grounded,
        carving: player.carving,
        respawning: player.respawn > 0,
        finished: player.finished,
        rank: player.rank,
        connected: player.connected,
        self: sessionId === room.sessionId,
      });
    }
    avatars.update(views, true);

    // ---------------------------------------------------------------- camera
    camera.update(
      me.value("x"), me.value("y"), me.value("z"),
      keys.yaw, keys.pitch, dt,
      level, phase, renderTick,
    );

    fx.update(dt);
    updateHud();
    stage.scene.render();
    requestAnimationFrame(frame);
  }

  function updateHud() {
    const state = room.state;
    const currentPhase = state.phase as RacePhase;

    // ------------------------------------------------------------ leaderboard
    const rows: BoardRow[] = [];
    for (const [sessionId, player] of state.players) {
      rows.push({
        sessionId,
        name: player.name,
        colour: player.colour,
        rank: player.rank,
        progress: player.progress,
        finished: player.finished,
        dnf: player.dnf,
        finishMs: player.finishMs,
        self: sessionId === room.sessionId,
        bot: player.bot,
        seriesPoints: player.seriesPoints,
      });
    }

    // ---------------------------------------------------------------- rivals
    //
    // The gap is progress converted to seconds at the pace the leader is
    // actually running, which reads far better than a raw percentage: "two
    // seconds back" is something a runner can act on.
    const pace = Math.max(6, Math.hypot(self.vx, self.vz));
    const asSeconds = (delta: number) => Math.abs(delta) * level.courseLength / pace;
    let ahead: Rival | null = null;
    let behind: Rival | null = null;
    let aheadGap = Infinity;
    let behindGap = Infinity;
    for (const [sessionId, player] of state.players) {
      if (sessionId === room.sessionId || !player.connected || player.dnf) { continue; }
      const delta = player.progress - self.progress;
      // Whoever currently holds the slot keeps it until somebody is clearly
      // closer, which is the hysteresis.
      const stick = (held: string | null) => (sessionId === held ? RIVAL_STICK : 0);
      if (delta > 0 && delta - stick(rivalAhead) < aheadGap) {
        aheadGap = delta - stick(rivalAhead);
        ahead = { name: player.name, colour: player.colour, seconds: asSeconds(delta) };
        rivalAhead = sessionId;
      } else if (delta <= 0 && -delta - stick(rivalBehind) < behindGap) {
        behindGap = -delta - stick(rivalBehind);
        behind = { name: player.name, colour: player.colour, seconds: asSeconds(delta) };
        rivalBehind = sessionId;
      }
    }
    ui.setRivals(currentPhase === "racing" ? ahead : null, currentPhase === "racing" ? behind : null);
    ui.setSeries(
      state.seriesRound, state.seriesLength, self.seriesPoints,
      state.seriesWinner ? (state.players.get(state.seriesWinner)?.name ?? "") : "",
    );
    rows.sort((a, b) => (a.rank || 99) - (b.rank || 99));
    ui.setBoard(rows);
    ui.setPosition(self.rank, rows.length);
    ui.setSection(sectionLabel(level, self.checkpoint));
    ui.setKit(
      self.ammo, AMMO_MAX, self.coins, self.recallCharges,
      self.shieldUntil >= 0 && state.tick < self.shieldUntil,
    );
    ui.setNotes(level.notes);
    ui.setRound(state.round, phaseLabel(currentPhase), state.mode);

    // ------------------------------------------------------------------ clock
    if (currentPhase === "racing" && state.raceStartTick >= 0) {
      const elapsed = (state.tick - state.raceStartTick) * STEP_MS;
      const remaining = (state.raceDeadlineTick - state.tick) * STEP_MS;
      ui.setClock(self.finished ? self.finishMs : elapsed, remaining < 30_000);
    } else if (currentPhase === "countdown") {
      ui.setClock(Math.max(0, (state.countdownEndTick - state.tick) * STEP_MS), false);
    } else {
      ui.setClock(0, false);
    }

    // --------------------------------------------------------------- callouts
    if (currentPhase !== lastPhase) {
      ui.clearCallout();
      if (currentPhase === "countdown" || currentPhase === "waiting") { ui.hideResults(); }
      lastPhase = currentPhase;
    }

    switch (currentPhase) {
      case "waiting": {
        const ready = countConnected(state);
        const unlocked = state.soloUnlockTick >= 0 && state.tick >= state.soloUnlockTick;
        ui.callout(
          `wait-${ready}-${unlocked}`,
          `${ready} / ${MIN_PLAYERS}`,
          unlocked ? "Press ENTER for a solo run" : "Waiting for runners…",
          "small",
          1e9,
        );
        break;
      }
      case "countdown": {
        const left = Math.ceil((state.countdownEndTick - state.tick) / TICK_RATE);
        if (left > 0) {
          ui.callout(`cd-${left}`, String(left), "Get ready", "warm", 1200);
        }
        break;
      }
      case "racing": {
        if (self.checkpoint !== lastCheckpoint) {
          if (self.checkpoint > lastCheckpoint && self.checkpoint >= 0) {
            // The split against the best time to this checkpoint - or against
            // the round before, if the best time is your own.
            const mine = self.splits[self.checkpoint] ?? 0;
            const best = state.bestSplits[self.checkpoint] ?? 0;
            const reference = best > 0 && best < mine
              ? best
              : (state.prevBestSplits[self.checkpoint] ?? 0);
            const delta = reference > 0 && mine > 0 ? (mine - reference) / 1000 : null;
            ui.callout(
              `cp-${self.checkpoint}`,
              delta === null
                ? "Checkpoint"
                : `${delta >= 0 ? "+" : "\u2212"}${Math.abs(delta).toFixed(1)}s`,
              level.checkpoints[self.checkpoint].label,
              delta !== null && delta < 0 ? "small good" : "small",
              2000,
            );
          }
          lastCheckpoint = self.checkpoint;
        }
        if (self.finished && !wasFinished) {
          wasFinished = true;
          fx.fanfare();
          ui.callout("fin", placeText(self.rank), "Finished", "good", 3200);
        }
        if (state.tick === state.raceStartTick) { ui.callout("go", "GO!", "", "good", 900); }
        break;
      }
      case "results": {
        const ordered = rows.slice().sort((a, b) => {
          if (a.finished !== b.finished) { return a.finished ? -1 : 1; }
          if (a.finished) { return a.rank - b.rank; }
          return b.progress - a.progress;
        });
        ui.showResults(ordered, "Final standings");
        ui.setResultsCountdown(Math.max(0, Math.ceil((state.resultsEndTick - state.tick) / TICK_RATE)));
        break;
      }
    }

    // Reconciled every frame rather than only on the lock-change event. The
    // initial lock request can be refused outright (a rate-limited re-lock, a
    // browser that wants its own gesture), and that never fires a change event -
    // which would strand the player with a camera that does not turn and no
    // prompt telling them how to get it back.
    if (!keys.pointerLocked) { ui.showResume(); }

    ui.tickCallout();
  }

  /**
   * A read-only snapshot for debugging and automated smoke tests. Exposing it
   * costs nothing and means a test can assert on simulation state rather than
   * on pixels.
   */
  (window as any).__gauntlet = () => ({
    phase: room.state.phase,
    tick: room.state.tick,
    round: room.state.round,
    seed: room.state.seed,
    players: room.state.players.size,
    raceStartTick: room.state.raceStartTick,
    self: {
      name: self.name,
      active: self.active,
      tickBase: self.tickBase,
      x: self.x, y: self.y, z: self.z,
      grounded: self.grounded,
      chain: self.chain,
      ammo: self.ammo,
      coins: self.coins,
      breaks: self.breaks,
      shieldUntil: self.shieldUntil,
      anchorId: self.anchorId,
      ropeLen: self.ropeLen,
      tension: self.tension,
      recallCharges: self.recallCharges,
      recallUntil: self.recallUntil,
      carving: self.carving,
      hopWindow: self.hopWindow,
      checkpoint: self.checkpoint,
      progress: self.progress,
      rank: self.rank,
      finished: self.finished,
      falls: self.falls,
    },
    predicted: { x: me.value("x"), y: me.value("y"), z: me.value("z") },
    tickBase: self.tickBase,
    sentCount: input.sentCount,
    lastProcessed: input.lastProcessed,
    enemies: room.state.enemies.size,
    fps: stage.engine.getFps(),
    meshes: stage.scene.meshes.length,
  });
  // The HUD, for driving screens in tests that would otherwise need a full
  // two-minute race to reach.
  (window as any).__ui = ui;

  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- helpers

function copyInto(target: number[], source: { length: number;[i: number]: number } | any) {
  const n = source?.length ?? 0;
  target.length = n;
  for (let i = 0; i < n; i++) { target[i] = source[i] ?? -1; }
}

function countConnected(state: any): number {
  let n = 0;
  for (const [, player] of state.players) { if (player.connected) { n++; } }
  return n;
}

/** The unbroken breaker nearest a spectator's camera, for an influence spend. */
function nearestBreaker(level: Level, x: number, z: number): number {
  let best = -1;
  let bestDistance = Infinity;
  for (const b of level.breakers) {
    const d = Math.hypot(b.x - x, b.z - z);
    if (d < bestDistance) { bestDistance = d; best = b.slot; }
  }
  return best;
}

/** The section a player is currently running is the one ending at their next checkpoint. */
function sectionLabel(level: Level, checkpoint: number): string {
  const next = checkpoint + 1;
  if (next < level.checkpoints.length) { return level.checkpoints[next].label; }
  // Past the last bank there is no checkpoint left to name, so the run-in is
  // whatever section the generator put last.
  return level.sections[level.sections.length - 1]?.title ?? "The Climb";
}

function phaseLabel(phase: RacePhase): string {
  switch (phase) {
    case "waiting": return "Lobby";
    case "countdown": return "Starting";
    case "racing": return "Racing";
    case "results": return "Results";
  }
}

function placeText(rank: number): string {
  if (rank === 1) { return "1st!"; }
  if (rank === 2) { return "2nd"; }
  if (rank === 3) { return "3rd"; }
  return `${rank}th`;
}
