import { Room, type Client, type CloseCode, type StepContext } from "colyseus";

import { Player, RaceInput, RaceState, type RacePhase } from "./schema/RaceState.js";
import {
  COUNTDOWN_TICKS, FINISH_GRACE_TICKS, MAX_PLAYERS, MIN_PLAYERS,
  HEAVY_KNOCK, RACE_LIMIT_TICKS, RESULTS_TICKS,
  PLAYER_RADIUS, SOLO_UNLOCK_TICKS, SUB_STEPS, TICK_RATE,
} from "../shared/constants.js";
import { inVolume } from "../shared/collision.js";
import { sanitizeRaceInput } from "../shared/input.js";
import {
  buildLevel, CRUMBLE_DELAY_TICKS, CRUMBLE_GONE_TICKS, type Level, lobbySlot,
} from "../shared/level.js";
import type { WorldPhase } from "../shared/obstacles.js";
import { stepPlayer, type OtherBody, type SimWorld } from "../shared/movement.js";

/**
 * Drift control for a player's seq->tick mapping.
 *
 * The mapping only has to AGREE between the two ends, so ordinary latency needs
 * no correction at all. What does need correcting is slow divergence: a client
 * that sends slightly fewer than `TICK_RATE` inputs per second (a dropped frame
 * here and there is enough) walks its own world-tick steadily into the past,
 * until it is colliding with obstacles where they were seconds ago while every
 * other player sees them somewhere else.
 *
 * The measured offset is noisy - it moves with every packet - so it is smoothed
 * before being acted on, and then corrected one tick at a time. One tick is
 * 33ms of obstacle motion, small enough that the reconciler absorbs it.
 */
const REBASE_SMOOTHING = 0.05;
/** Deadband, in ticks, around the smoothed offset. Absorbs residual jitter. */
const REBASE_DEADBAND = 2;
/** Minimum ticks between single-tick corrections. */
const REBASE_COOLDOWN = 12;
/** Beyond this the client stalled outright (a backgrounded tab); snap instead. */
const REBASE_SNAP_AT = 40;

/**
 * The authoritative race.
 *
 * The server owns the simulation outright: it runs the same `stepPlayer()` the
 * client predicts with, once per input it actually receives. Nothing about a
 * player's position is taken on trust - the client's inputs are the only thing
 * that crosses the wire, and `defineInput`'s sanitiser clamps those before the
 * simulation ever sees them.
 *
 * The course itself is never transmitted. `state.seed` is, and both sides build
 * an identical `Level` from it.
 */
export class RaceRoom extends Room<{ state: RaceState; input: RaceInput }> {
  maxClients = MAX_PLAYERS;
  state = new RaceState();

  inputs = this.defineInput(RaceInput, {
    bufferMaxSize: 64,
    /**
     * Never trust the wire - and note this COERCES rather than clamps.
     *
     * A declarative `{ moveX: [-1, 1] }` clamp is not enough: a client that
     * simply omits a field decodes it as `undefined`, and one `Math.hypot(
     * undefined, 1)` inside the step turns a player's position into NaN for the
     * rest of the match. Forcing every field to a finite value here means the
     * simulation cannot be handed a number it does not understand.
     */
    sanitize: (f) => { sanitizeRaceInput(f); },
  });

  private level!: Level;

  /**
   * Simulation-side mirrors of the tick arrays in state. The schema collections
   * are proxied for change tracking, which is the wrong shape for something the
   * step reads thousands of times a second.
   */
  private crumbleTicks: number[] = [];
  private plateTicks: number[] = [];
  private plateSince: number[] = [];

  private phase: WorldPhase = {
    raceStartTick: -1,
    crumbleTicks: this.crumbleTicks,
    plateTicks: this.plateTicks,
    plateSince: this.plateSince,
  };

  /** Reused per step: the shared simulation never sees a fresh object. */
  private world: SimWorld = {
    level: null as unknown as Level,
    phase: this.phase,
    tickBase: 0,
    others: [],
    onCrumble: (slot, tick) => this.touchCrumble(slot, tick),
    onPlate: (plate, tick) => this.touchPlate(plate, tick),
    onHeavyPlate: (plate, tick) => this.touchPlate(plate, tick),
    hasLandingContact: (x, y, z) => this.hasLandingContact(x, y, z),
    onRespawn: (voluntary) => {
      if (this.stepping && !voluntary) { this.stepping.falls += 1; }
    },
    onHeavy: (x, y, z, radius, tick) => this.applyHeavy(x, y, z, radius, tick),
  };

  /**
   * The server's `StepContext` is indexed by the room's fixed step, but the
   * shared step has to be indexed by the player's INPUT SEQUENCE - that is the
   * index the client replays under. Same dt, different clock.
   */
  private simCtx = { dt: 0, tick: 0, subSteps: 1, subDt: 0, isReplay: false };

  private otherPool: OtherBody[] = [];
  private stepping: Player | null = null;
  private lastRebase = new Map<string, number>();
  private driftEma = new Map<string, number>();
  private firstFinishTick = -1;
  private soloRun = false;
  private joinCount = 0;

  messages = {
    /** Set a display name. Cosmetic, so it is simply clamped rather than rejected. */
    name: (client: Client, message: any) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) { return; }
      player.name = sanitizeName(String(message?.name ?? ""), player.colour);
    },

    /** A lone player asking to practise the course rather than wait for a lobby. */
    solo: (client: Client) => {
      if (this.state.phase !== "waiting") { return; }
      if (this.connectedCount() !== 1) { return; }
      if (this.state.soloUnlockTick < 0 || this.state.tick < this.state.soloUnlockTick) { return; }
      if (!this.state.players.has(client.sessionId)) { return; }
      this.soloRun = true;
      this.beginCountdown(this.state.tick);
    },
  };

  onCreate() {
    this.armLevel(randomSeed());
    this.setFixedTimestep((ctx) => this.step(ctx), TICK_RATE, { subSteps: SUB_STEPS });
  }

  onJoin(client: Client, options: any) {
    const colour = this.freeColour();
    const slot = lobbySlot(this.joinCount++ % MAX_PLAYERS);
    const player = new Player();
    player.name = sanitizeName(String(options?.name ?? ""), colour);
    player.colour = colour;
    player.x = slot.x;
    player.y = this.level.spawn.y;
    player.z = slot.z;
    // Someone arriving mid-race runs for fun but is not ranked; the next round
    // resets them into the field properly.
    player.dnf = this.state.phase === "racing" || this.state.phase === "results";
    this.state.players.set(client.sessionId, player);
  }

  onDrop(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (player) { player.connected = false; }
    // Not awaited on purpose: the framework routes the outcome to onReconnect()
    // or onLeave(). The catch only silences the rejection when the room is
    // already disposing.
    this.allowReconnection(client, 25).catch(() => {});
  }

  onReconnect(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (player) { player.connected = true; }
  }

  onLeave(client: Client, _code: CloseCode) {
    this.state.players.delete(client.sessionId);
    this.lastRebase.delete(client.sessionId);
    this.driftEma.delete(client.sessionId);
    if (this.connectedCount() < MIN_PLAYERS && this.state.phase === "countdown" && !this.soloRun) {
      this.toWaiting();
    }
  }

  // =========================================================== simulation loop

  private step(ctx: StepContext) {
    const tick = ctx.tick;
    this.state.tick = tick;

    this.simCtx.dt = ctx.dt;
    this.simCtx.subSteps = ctx.subSteps;
    this.simCtx.subDt = ctx.subDt;

    this.advanceObstacles(tick);
    this.simulatePlayers(ctx, tick);
    this.detectFinishes(tick);
    this.rankField();
    this.advancePhase(tick);
  }

  /** Retire crumble platforms whose respawn is due, and cool expired plates. */
  private advanceObstacles(tick: number) {
    for (let i = 0; i < this.crumbleTicks.length; i++) {
      const trig = this.crumbleTicks[i];
      if (trig >= 0 && tick > trig + CRUMBLE_DELAY_TICKS + CRUMBLE_GONE_TICKS) {
        this.crumbleTicks[i] = -1;
        this.state.crumbleTicks[i] = -1;
      }
    }
    for (let i = 0; i < this.plateTicks.length; i++) {
      const until = this.plateTicks[i];
      if (until >= 0 && tick > until) {
        this.plateTicks[i] = -1;
        this.plateSince[i] = -1;
        this.state.plateTicks[i] = -1;
        this.state.plateSince[i] = -1;
      }
    }
  }

  private simulatePlayers(ctx: StepContext, tick: number) {
    for (const [sessionId, player] of this.state.players) {
      const channel = this.inputs.get(sessionId);
      if (!channel) { continue; }

      this.fillOthers(sessionId);
      this.stepping = player;

      for (const cmd of channel) {
        const seq = channel.consumedCount;

        // The first input a player sends fixes their seq->tick mapping, and
        // publishing it is what lets them predict moving geometry at all. The
        // result is signed: a client that connected before the room had ticked
        // much legitimately maps seq 0 to a negative tick, which is why `active`
        // rather than the sign is the "already assigned" test.
        if (!player.active) {
          player.tickBase = tick - seq;
          player.active = true;
        }

        this.world.tickBase = player.tickBase;
        this.simCtx.tick = seq;
        stepPlayer(this.simCtx, player, cmd, this.world);
      }

      this.stepping = null;
      if (player.active) {
        this.rebase(sessionId, player, tick, channel.consumedCount);
      }
    }
  }

  /** Keep a player's seq->tick mapping anchored near real time. @see REBASE_SMOOTHING */
  private rebase(sessionId: string, player: Player, tick: number, seq: number) {
    const observed = tick - seq;

    const previous = this.driftEma.get(sessionId);
    const ema = previous === undefined
      ? observed
      : previous + (observed - previous) * REBASE_SMOOTHING;
    this.driftEma.set(sessionId, ema);

    const drift = ema - player.tickBase;
    if (Math.abs(drift) >= REBASE_SNAP_AT) {
      player.tickBase = Math.round(ema);
      this.driftEma.set(sessionId, ema);
      this.lastRebase.set(sessionId, tick);
      return;
    }
    if (Math.abs(drift) < REBASE_DEADBAND) { return; }
    const last = this.lastRebase.get(sessionId) ?? -Infinity;
    if (tick - last < REBASE_COOLDOWN) { return; }
    player.tickBase += Math.sign(drift);
    this.lastRebase.set(sessionId, tick);
  }

  /** Everyone except `self`, as the plain bodies the shove pass wants. */
  private fillOthers(self: string) {
    const out: OtherBody[] = [];
    let i = 0;
    for (const [sessionId, player] of this.state.players) {
      if (sessionId === self || !player.connected) { continue; }
      const slot = this.otherPool[i] ?? (this.otherPool[i] = { x: 0, y: 0, z: 0 });
      slot.x = player.x; slot.y = player.y; slot.z = player.z;
      out.push(slot);
      i++;
    }
    this.world.others = out;
  }

  private touchCrumble(slot: number, tick: number) {
    if (this.crumbleTicks[slot] >= 0) { return; }
    this.crumbleTicks[slot] = tick;
    this.state.crumbleTicks[slot] = tick;
  }

  private touchPlate(plate: number, tick: number) {
    // Refresh the expiry on every touch, but only stamp `since` on a cold->hot
    // edge, or the swing-in ramp would restart under a player who stands still.
    if (this.plateTicks[plate] < 0) {
      this.plateSince[plate] = tick;
      this.state.plateSince[plate] = tick;
    }
    const until = tick + this.level.plates[plate].holdTicks;
    this.plateTicks[plate] = until;
    this.state.plateTicks[plate] = until;
  }

  /** Publish a Heavy shockwave as stamps on the victims' own simulation state. */
  private applyHeavy(x: number, y: number, z: number, radius: number, tick: number) {
    for (const [, victim] of this.state.players) {
      if (victim === this.stepping || !victim.connected || victim.respawn > 0) { continue; }
      if (victim.plantUntil >= tick) { continue; }
      const dx = victim.x - x;
      const dz = victim.z - z;
      const d = Math.hypot(dx, dz);
      if (d > radius || Math.abs(victim.y - y) > 2.4) { continue; }
      // Coincident runners need a stable direction. The lander's yaw is synced,
      // so it remains deterministic and gives the victim a clear way out.
      const nx = d > 1e-6 ? dx / d : Math.sin(this.stepping?.yaw ?? 0);
      const nz = d > 1e-6 ? dz / d : Math.cos(this.stepping?.yaw ?? 0);
      victim.knockTick = tick;
      victim.knockX = nx * HEAVY_KNOCK;
      victim.knockY = HEAVY_KNOCK * 0.38;
      victim.knockZ = nz * HEAVY_KNOCK;
    }
  }

  /** Contact during a landing window is server-authored, never interpolated client state. */
  private hasLandingContact(x: number, y: number, z: number): boolean {
    const minDistance = PLAYER_RADIUS * 2;
    for (const [, other] of this.state.players) {
      if (other === this.stepping || !other.connected || other.respawn > 0) { continue; }
      const dx = x - other.x;
      const dz = z - other.z;
      if (Math.abs(y - other.y) <= 1.6 && dx * dx + dz * dz < minDistance * minDistance) {
        return true;
      }
    }
    return false;
  }

  // ================================================================== scoring

  private detectFinishes(tick: number) {
    if (this.state.phase !== "racing") { return; }
    const lastCheckpoint = this.level.checkpoints.length - 1;

    for (const [, player] of this.state.players) {
      if (player.finished || player.dnf) { continue; }
      // The finish only counts with every checkpoint banked, which is what
      // makes skipping a section impossible rather than merely unrewarding.
      if (player.checkpoint < lastCheckpoint) { continue; }
      if (!inVolume(player.x, player.y, player.z, this.level.finish)) { continue; }

      player.finished = true;
      player.progress = 1;
      player.finishMs = Math.max(0, Math.round((tick - this.state.raceStartTick) * (1000 / TICK_RATE)));
      this.state.finishers += 1;
      player.rank = this.state.finishers;
      if (this.firstFinishTick < 0) { this.firstFinishTick = tick; }
      this.broadcast("finish", { sessionId: keyOf(this.state.players, player), rank: player.rank });
    }
  }

  /**
   * Rank by course progress, not by distance to the finish line.
   *
   * Finishers hold the place they earned; everyone else is ordered by how far
   * along the centre-line they have actually got.
   */
  private rankField() {
    const running: Player[] = [];
    for (const [, player] of this.state.players) {
      if (player.finished) { continue; }
      running.push(player);
    }
    running.sort((a, b) => {
      if (a.dnf !== b.dnf) { return a.dnf ? 1 : -1; }
      if (b.progress !== a.progress) { return b.progress - a.progress; }
      return b.checkpoint - a.checkpoint;
    });
    let rank = this.state.finishers;
    for (const player of running) { player.rank = ++rank; }
  }

  // =============================================================== match flow

  private advancePhase(tick: number) {
    const connected = this.connectedCount();

    switch (this.state.phase as RacePhase) {
      case "waiting": {
        if (connected >= MIN_PLAYERS) {
          this.soloRun = false;
          this.beginCountdown(tick);
        } else if (connected === 1) {
          if (this.state.soloUnlockTick < 0) {
            this.state.soloUnlockTick = tick + SOLO_UNLOCK_TICKS;
          }
        } else {
          this.state.soloUnlockTick = -1;
        }
        break;
      }

      case "countdown": {
        if (connected < MIN_PLAYERS && !this.soloRun) { this.toWaiting(); break; }
        if (tick >= this.state.countdownEndTick) { this.beginRace(tick); }
        break;
      }

      case "racing": {
        if (connected === 0) { this.endRace(tick); break; }

        let contenders = 0;
        let done = 0;
        for (const [, player] of this.state.players) {
          if (player.dnf || !player.connected) { continue; }
          contenders++;
          if (player.finished) { done++; }
        }

        const everyoneHome = contenders > 0 && done === contenders;
        const graceExpired = this.firstFinishTick >= 0
          && tick >= this.firstFinishTick + FINISH_GRACE_TICKS;
        const timedOut = tick >= this.state.raceDeadlineTick;

        if (everyoneHome || graceExpired || timedOut) { this.endRace(tick); }
        break;
      }

      case "results": {
        if (tick >= this.state.resultsEndTick) { this.resetRound(tick); }
        break;
      }
    }
  }

  private toWaiting() {
    this.state.phase = "waiting";
    this.state.countdownEndTick = -1;
    this.state.raceStartTick = -1;
    this.phase.raceStartTick = -1;
    this.state.soloUnlockTick = -1;
    this.soloRun = false;
  }

  private beginCountdown(tick: number) {
    this.state.phase = "countdown";
    this.state.countdownEndTick = tick + COUNTDOWN_TICKS;
    this.state.soloUnlockTick = -1;
    this.resetPlayersToLobby();
  }

  private beginRace(tick: number) {
    this.state.phase = "racing";
    this.state.raceStartTick = tick;
    this.phase.raceStartTick = tick;
    this.state.raceDeadlineTick = tick + RACE_LIMIT_TICKS;
    this.state.finishers = 0;
    this.firstFinishTick = -1;
    for (const [, player] of this.state.players) {
      if (player.connected) { player.dnf = false; }
    }
  }

  private endRace(tick: number) {
    this.state.phase = "results";
    this.state.resultsEndTick = tick + RESULTS_TICKS;
    for (const [, player] of this.state.players) {
      if (!player.finished) { player.dnf = true; }
    }
    this.rankField();
    this.broadcast("raceOver", {});
  }

  /** New seed, fresh course, everyone back on the line. */
  private resetRound(tick: number) {
    this.armLevel(randomSeed());
    this.state.round += 1;
    this.state.finishers = 0;
    this.firstFinishTick = -1;
    this.soloRun = false;
    this.state.resultsEndTick = -1;
    this.state.raceDeadlineTick = -1;
    this.resetPlayersToLobby();
    this.toWaiting();
    // Fall straight into the countdown when the room is already full enough.
    this.advancePhase(tick);
  }

  private resetPlayersToLobby() {
    let i = 0;
    for (const [, player] of this.state.players) {
      const slot = lobbySlot(i++ % MAX_PLAYERS);
      player.x = slot.x; player.y = this.level.spawn.y; player.z = slot.z;
      player.vx = 0; player.vy = 0; player.vz = 0;
      player.yaw = 0;
      player.grounded = true;
      player.groundId = 0;
      player.coyote = 0; player.jumpBuf = 0; player.jumpHeld = false;
      player.stun = 0; player.respawn = 0;
      player.checkpoint = -1;
      player.progress = 0;
      player.chain = 0;
      player.impactBuf = 0;
      player.heavyHeld = false;
      player.heavyArmed = false;
      player.heavySince = -1;
      player.plantUntil = -1;
      player.chainDecayUntil = -1;
      player.carving = false;
      player.carveUntil = -1;
      player.carveCool = -1;
      player.hopWindow = 0;
      player.knockTick = -1;
      player.knockX = 0; player.knockY = 0; player.knockZ = 0;
      player.rank = 0;
      player.finished = false;
      player.finishMs = 0;
      player.dnf = false;
      player.falls = 0;
    }
  }

  /** Build the course for `seed` and publish everything clients need to match it. */
  private armLevel(seed: number) {
    this.level = buildLevel(seed);
    this.world.level = this.level;
    this.state.seed = seed;

    this.crumbleTicks.length = 0;
    this.state.crumbleTicks.clear();
    for (let i = 0; i < this.level.crumbleCount; i++) {
      this.crumbleTicks.push(-1);
      this.state.crumbleTicks.push(-1);
    }

    this.plateTicks.length = 0;
    this.plateSince.length = 0;
    this.state.plateTicks.clear();
    this.state.plateSince.clear();
    for (let i = 0; i < this.level.plates.length; i++) {
      this.plateTicks.push(-1);
      this.plateSince.push(-1);
      this.state.plateTicks.push(-1);
      this.state.plateSince.push(-1);
    }
    this.state.plateHoldTicks = this.level.plates[0]?.holdTicks ?? 0;

    this.phase.raceStartTick = -1;
    this.state.raceStartTick = -1;
  }

  private connectedCount(): number {
    let n = 0;
    for (const [, player] of this.state.players) { if (player.connected) { n++; } }
    return n;
  }

  private freeColour(): number {
    const taken = new Set<number>();
    for (const [, player] of this.state.players) { taken.add(player.colour); }
    for (let c = 0; c < MAX_PLAYERS; c++) { if (!taken.has(c)) { return c; } }
    return 0;
  }
}

const NAME_MAX = 14;

function sanitizeName(raw: string, colour: number): string {
  const cleaned = raw.replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, NAME_MAX);
  return cleaned.length >= 2 ? cleaned : `Runner ${colour + 1}`;
}

function randomSeed(): number {
  return (Math.random() * 0x7ffffffe) | 0 || 1;
}

/** MapSchema has no reverse lookup; the field is only needed for one broadcast. */
function keyOf(map: Map<string, Player> | any, value: Player): string {
  for (const [key, entry] of map) { if (entry === value) { return key; } }
  return "";
}
