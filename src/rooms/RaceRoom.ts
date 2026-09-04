import { Room, type Client, type CloseCode, type StepContext } from "colyseus";

import { Enemy, Player, RaceInput, RaceState, type RacePhase } from "./schema/RaceState.js";
import { Threats, type ThreatTarget } from "./threats.js";
import { Recorder, StampKind, type RaceRecording } from "./replay.js";
import { blankInput, BotChannel, BotController, BOT_PROFILES } from "./bot.js";
import type { SimInput } from "../shared/movement.js";
import {
  BOT_FILL, CHAIN_MAX, COIN_MAX, COUNTDOWN_TICKS, DRAFT_CONE, DRAFT_MAX, DRAFT_MIN,
  DRAFT_TICKS, FINISH_GRACE_TICKS, INFLUENCE_LOCKOUT_TICKS,
  INFLUENCE_TELEGRAPH_TICKS, MAX_PLAYERS, MIN_PLAYERS,
  PLATE_CONTEST_MIN_PLAYERS, PLATE_CONTEST_TICKS,
  HEAVY_KNOCK, POD_COINS, POD_SHARE_TICKS, RACE_LIMIT_TICKS, RESULTS_TICKS,
  PLAYER_RADIUS, SEAL_KEY_COST, SHIELD_COST, SHIELD_TICKS,
  COLLECT_TARGET, COLLECT_TOKENS, HUNT_CATCH_RADIUS, HUNT_COOL_TICKS,
  RACE_MODES, RECALL_COST, RECALL_MAX_CHARGES, type RaceMode,
  SURVIVAL_CLOSE_RATE, SURVIVAL_GRACE_TICKS,
  SERIES_FINAL_MULTIPLIER, SERIES_LENGTH, SERIES_POINTS, SERIES_TARGET,
  SOLO_UNLOCK_TICKS, SUB_STEPS, TICK_RATE,
} from "../shared/constants.js";
import { inVolume } from "../shared/collision.js";
import { sanitizeRaceInput } from "../shared/input.js";
import {
  buildLevelWith, CRUMBLE_DELAY_TICKS, CRUMBLE_GONE_TICKS, type Level, lobbySlot,
} from "../shared/level.js";
import {
  drawMutators, seriesMultiplier, type MutatorId,
} from "../shared/mutators.js";
import type { WorldPhase } from "../shared/obstacles.js";
import { stepPlayer, type OtherBody, type SimWorld } from "../shared/movement.js";
import { clearRecallRing, makeRecallRing, type RecallRing } from "../shared/recall.js";

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
  private breakerTicks: number[] = [];
  private pickupTicks: number[] = [];
  private shellTicks: number[] = [];

  private phase: WorldPhase = {
    raceStartTick: -1,
    crumbleTicks: this.crumbleTicks,
    plateTicks: this.plateTicks,
    plateSince: this.plateSince,
    breakerTicks: this.breakerTicks,
    pickupTicks: this.pickupTicks,
    shellTicks: this.shellTicks,
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
    hasLandingContact: (x, y, z) =>
      this.mode !== "timeattack" && this.hasLandingContact(x, y, z),
    onRespawn: (voluntary) => {
      if (!this.stepping) { return; }
      if (!voluntary) { this.stepping.falls += 1; }
      // Sudden death: there are no checkpoints to go back to. One fall is the
      // whole round, which is exactly as brutal as it sounds and is the point.
      if (this.mutators.includes("suddendeath") && this.state.phase === "racing"
        && !this.stepping.finished) {
        this.stepping.dnf = true;
      }
    },
    onHeavy: (x, y, z, radius, tick) => this.applyHeavy(x, y, z, radius, tick),
    onShot: (slot, tick) => this.touchBreaker(slot, tick, this.stepping),
    onPickup: (slot, tick) => this.takePickup(slot, tick),
    onSpend: (tick) => this.burn(tick),
    onShell: (slot, tick) => this.shootDownShell(slot, tick),
    onEnemyHit: (id, tick) => this.hitEnemy(id, tick),
    // Filled in by armLevel(), which is where the field is built. A field
    // initialiser cannot reach `threats` - it is declared after this one.
    enemies: [],
  };

  /**
   * The server's `StepContext` is indexed by the room's fixed step, but the
   * shared step has to be indexed by the player's INPUT SEQUENCE - that is the
   * index the client replays under. Same dt, different clock.
   */
  private simCtx = { dt: 0, tick: 0, subSteps: 1, subDt: 0, isReplay: false };

  /**
   * Per-player Recall history. Server-side only and outside the schema, exactly
   * like the crumble stamps: what crosses the wire is the *result* of a
   * restore, which is ordinary simulated state the reconciler already handles.
   *
   * Sixty ticks of nine numbers is about 3.6 KB a player, and it is bounded by
   * construction - the ring never grows.
   */
  private histories = new Map<string, RecallRing>();

  /**
   * The enemy field. Plain records here, mirrored into `state.enemies` - the
   * same reason `crumbleTicks` is mirrored: the schema collections are proxied
   * for change tracking, which is the wrong shape for something the shared step
   * reads on every sub-step.
   */
  private threats = new Threats();
  private targets: ThreatTarget[] = [];

  /**
   * The bots.
   *
   * A bot is not a special case in the simulation - it is an object that fills
   * an input channel, and `simulatePlayers()` cannot tell the difference. That
   * indirection is the whole integration, and it is also what makes cheating
   * structurally impossible: a bot presses the same nine fields a human does
   * and they go through the same `sanitize`.
   */
  private bots = new Map<string, { controller: BotController; channel: BotChannel }>();
  private botFrame: SimInput = blankInput();
  private botCount = 0;
  /** Ticks each player has been drafting cleanly behind somebody. */
  private draft = new Map<string, number>();
  /** Influence stamps a spectator has bought, waiting out their telegraph. */
  private pending: Array<{ slot: number; at: number; by: string }> = [];
  /** This round's deck. Drawn once, published, and never rolled again. */
  private mutators: MutatorId[] = [];
  private mode: RaceMode = "race";
  /** Hunt: the last tick each hunter scored, so a catch is not a hold. */
  private caught = new Map<string, number>();
  /**
   * The round's recording.
   *
   * Everything a replay needs is data the room already has, so recording is a
   * handful of pushes around the step rather than anything inside it. The
   * payoff is that a race can be re-run and *checked*, which turns determinism
   * from something the codebase relies on into something it proves.
   */
  private recorder: Recorder | null = null;
  private lastRecording: RaceRecording | null = null;

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

    /**
     * Buy something with banked coins.
     *
     * Burn is on the input packet because it is a movement decision made at
     * speed; these two are messages because they are deliberate, rare, and
     * neither one has to land on an exact tick. Both are validated here - the
     * client never gets to decide it could afford something.
     */
    buy: (client: Client, message: any) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || this.state.phase !== "racing" || player.finished) { return; }
      const tick = this.state.tick;

      switch (String(message?.item ?? "")) {
        case "shield": {
          if (player.coins < SHIELD_COST) { return; }
          if (player.shieldUntil >= 0 && tick < player.shieldUntil) { return; }
          player.coins -= SHIELD_COST;
          player.shieldUntil = tick + SHIELD_TICKS;
          break;
        }
        case "recall": {
          if (player.coins < RECALL_COST) { return; }
          if (player.recallCharges >= RECALL_MAX_CHARGES) { return; }
          player.coins -= RECALL_COST;
          player.recallCharges += 1;
          break;
        }
        case "key": {
          if (player.coins < SEAL_KEY_COST) { return; }
          const slot = this.nearestSeal(player, tick);
          if (slot < 0) { return; }
          player.coins -= SEAL_KEY_COST;
          this.touchBreaker(slot, tick, null);
          break;
        }
      }
    },

    /**
     * A finished runner spending their one charge on the live course.
     *
     * It affects the *section*, never a chosen runner: that is what stops it
     * being griefing and what stops it being collusion. It is announced by name
     * the moment it is bought and nothing moves for over a second, so everyone
     * still running gets to react - and the attribution is the point, because
     * the fun is that runners know who did it.
     */
    influence: (client: Client, message: any) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || this.state.phase !== "racing") { return; }
      // Running players do not get to reach into the course they are in.
      // One shot hands a charge to everybody, runners included: the point of
      // that mutator is that the course is being changed by people who are
      // still in it, which is a different kind of race.
      if (!this.mutators.includes("oneshot") && !player.finished && !player.dnf) { return; }
      if (player.influence <= 0) { return; }
      if (this.state.raceDeadlineTick - this.state.tick < INFLUENCE_LOCKOUT_TICKS) { return; }

      const slot = Number(message?.slot);
      if (!Number.isInteger(slot) || slot < 0 || slot >= this.level.breakerCount) { return; }
      if (this.breakerTicks[slot] >= 0) { return; }
      if (this.pending.some((p) => p.slot === slot)) { return; }

      player.influence -= 1;
      const at = this.state.tick + INFLUENCE_TELEGRAPH_TICKS;
      this.pending.push({ slot, at, by: player.name });
      this.broadcast("influence", { slot, at, by: player.name });
    },

    /**
     * Pick the mode for the next round.
     *
     * Only in the lobby, and only between rounds: a mode is a rule about who
     * wins, and changing one mid-race would change the answer to a question
     * people are in the middle of answering.
     */
    mode: (client: Client, message: any) => {
      if (this.state.phase !== "waiting") { return; }
      if (!this.state.players.has(client.sessionId)) { return; }
      const wanted = String(message?.mode ?? "");
      if (!RACE_MODES.includes(wanted as RaceMode)) { return; }
      this.mode = wanted as RaceMode;
      this.armLevel(this.state.seed);
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
    player.seriesPoints = this.seedSeriesPoints();
    this.sizeSplits(player);
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
    this.histories.delete(client.sessionId);
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
    this.advanceThreats(tick);
    this.simulatePlayers(ctx, tick);
    this.recordSplits(tick);
    this.advanceMode(tick);
    this.applyDraft(tick);
    this.applyInfluence(tick);
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

  /**
   * One tick of the enemy field, before anybody is simulated against it.
   *
   * Ordering matters and is deliberate: commits are published first, so every
   * player in this tick is stepped against exactly the same arcs, in the same
   * order, whichever of them the server happens to reach first.
   */
  private advanceThreats(tick: number) {
    this.targets.length = 0;
    for (const [, player] of this.state.players) {
      if (!player.connected || player.finished || player.dnf) { continue; }
      this.targets.push({ x: player.x, y: player.y, z: player.z, live: player.respawn <= 0 });
    }

    this.threats.update(this.level, tick, this.targets);
    this.mirrorThreats();
  }

  /** Copy changed enemy records into state, and drop the ones that are gone. */
  private mirrorThreats() {
    const records = this.threats.records;
    const live = new Set<string>();
    for (const source of records as any[]) {
      const key = String(source.id);
      live.add(key);
      let target = this.state.enemies.get(key);
      if (!target) {
        target = new Enemy();
        this.state.enemies.set(key, target);
        source.dirty = true;
      }
      // Written only when the AI says something moved: an unchanged enemy
      // encodes to nothing at all.
      if (source.dirty) {
        target.id = source.id;
        target.kind = source.kind;
        target.alive = source.alive;
        target.hp = source.hp;
        target.downUntil = source.downUntil;
        target.action = source.action;
        target.fromTick = source.fromTick;
        target.toTick = source.toTick;
        target.x0 = source.x0; target.y0 = source.y0; target.z0 = source.z0;
        target.dx = source.dx; target.dz = source.dz;
        target.speed = source.speed;
        target.turn = source.turn;
        source.dirty = false;
      }
    }
    for (const [key] of this.state.enemies) {
      if (!live.has(key)) { this.state.enemies.delete(key); }
    }
  }

  private shootDownShell(slot: number, tick: number) {
    // Unlike a breaker, a shell stamp is re-written on every hit: the turret is
    // not destroyed, only the round in the air, and the next cycle fires as
    // normal. That is what keeps a shootable effect temporary.
    this.shellTicks[slot] = tick;
    this.state.shellTicks[slot] = tick;
    this.recorder?.stamp(tick, StampKind.Shell, slot, tick);
  }

  private hitEnemy(id: number, tick: number) {
    if (this.threats.hit(id, tick) && this.stepping) { this.stepping.breaks += 1; }
    this.mirrorThreats();
  }

  private simulatePlayers(ctx: StepContext, tick: number) {
    for (const [sessionId, player] of this.state.players) {
      const bot = this.bots.get(sessionId);
      if (bot) {
        bot.controller.think(
          player as any, this.level, this.phase, tick + player.tickBase, this.botFrame);
        bot.channel.push(this.botFrame);
      }
      const channel = bot ? bot.channel : this.inputs.get(sessionId);
      if (!channel) { continue; }

      this.fillOthers(sessionId);
      this.stepping = player;
      this.world.history = this.historyFor(sessionId);

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
        this.recorder?.input(sessionId, tick, seq, cmd as any);
        stepPlayer(this.simCtx, player, cmd, this.world);
      }

      this.stepping = null;
      this.world.history = undefined;
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
      this.recorder?.rebase(sessionId, tick, player.tickBase);
      return;
    }
    if (Math.abs(drift) < REBASE_DEADBAND) { return; }
    const last = this.lastRebase.get(sessionId) ?? -Infinity;
    if (tick - last < REBASE_COOLDOWN) { return; }
    player.tickBase += Math.sign(drift);
    this.lastRebase.set(sessionId, tick);
    this.recorder?.rebase(sessionId, tick, player.tickBase);
  }

  private historyFor(sessionId: string): RecallRing {
    let ring = this.histories.get(sessionId);
    if (!ring) {
      ring = makeRecallRing();
      this.histories.set(sessionId, ring);
    }
    return ring;
  }

  /** Everyone except `self`, as the plain bodies the shove pass wants. */
  private fillOthers(self: string) {
    const out: OtherBody[] = [];
    // Time attack is a solo run in company: no contact at all, so the field is
    // simply not there as far as anybody's body is concerned.
    if (this.mode === "timeattack") { this.world.others = out; return; }
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
    this.recorder?.stamp(tick, StampKind.Crumble, slot, tick);
  }

  /**
   * Publish a breaker as broken, and pay out if it was a pod.
   *
   * The stamp is written once; a second shooter inside the share window still
   * gets paid but does not move the stamp, because the effect has already
   * happened and re-stamping it would restart a five-second disable window.
   */
  private touchBreaker(slot: number, tick: number, shooter: Player | null) {
    const breaker = this.level.breakers.find((b) => b.slot === slot);
    if (!breaker) { return; }
    const previous = this.breakerTicks[slot];
    if (previous >= 0 && tick > previous + POD_SHARE_TICKS) { return; }
    if (previous < 0) {
      this.breakerTicks[slot] = tick;
      this.state.breakerTicks[slot] = tick;
      this.recorder?.stamp(tick, StampKind.Breaker, slot, tick);
    }
    if (shooter) {
      shooter.breaks += 1;
      if (breaker.effect === "pod") {
        shooter.coins = Math.min(COIN_MAX, shooter.coins + POD_COINS);
      }
    }
  }

  private takePickup(slot: number, tick: number) {
    this.pickupTicks[slot] = tick;
    this.state.pickupTicks[slot] = tick;
    this.recorder?.stamp(tick, StampKind.Pickup, slot, tick);
  }

  /**
   * Burn: coins straight back into overspeed.
   *
   * The purchase is validated and stamped here; the *effect* is applied by the
   * buyer's own deterministic step, exactly the way a Heavy shockwave reaches
   * its victims. That is what lets a rolling-back client replay it.
   */
  private burn(tick: number) {
    const player = this.stepping;
    if (!player || player.coins <= 0 || player.burnTick >= 0) { return; }
    player.burnAmount = player.coins;
    player.burnTick = tick;
    player.coins = 0;
  }

  /** The unopened seal nearest a player, for the seal-key purchase. */
  private nearestSeal(player: Player, tick: number): number {
    let best = -1;
    let bestDistance = Infinity;
    for (const breaker of this.level.breakers) {
      if (breaker.effect !== "seal") { continue; }
      if (this.breakerTicks[breaker.slot] >= 0) { continue; }
      const d = Math.hypot(breaker.x - player.x, breaker.z - player.z);
      if (d < bestDistance) { bestDistance = d; best = breaker.slot; }
    }
    return best;
  }

  private touchPlate(plate: number, tick: number) {
    // A plate id comes off the level, so this cannot fire in a real round - but
    // a stamp for a plate the current course does not have would take the whole
    // room down, and a room is shared by six people.
    if (!this.level.plates[plate]) { return; }
    // Refresh the expiry on every touch, but only stamp `since` on a cold->hot
    // edge, or the swing-in ramp would restart under a player who stands still.
    if (this.plateTicks[plate] < 0) {
      this.plateSince[plate] = tick;
      this.state.plateSince[plate] = tick;
      this.recorder?.stamp(tick, StampKind.PlateSince, plate, tick);
    }
    // A contested plate is *held*: with a field to spare, whoever opens the
    // bridge cannot also cross it. Below three runners it reverts to the long
    // hold, because a duo that cannot cross is not a social problem, it is a
    // dead end.
    const contested = this.connectedCount() >= PLATE_CONTEST_MIN_PLAYERS;
    const hold = contested ? PLATE_CONTEST_TICKS : this.level.plates[plate].holdTicks;
    const until = tick + hold;
    this.plateTicks[plate] = until;
    this.state.plateTicks[plate] = until;
    this.recorder?.stamp(tick, StampKind.PlateUntil, plate, until);
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

  /**
   * Slipstream.
   *
   * Running within twelve degrees and a couple of body-lengths behind somebody
   * moves a Chain level from them to you every two seconds. It is Class C on
   * purpose - a soft, bounded, self-correcting effect computed from positions
   * the server already has - and only the nearest drafter behind a given runner
   * benefits, so a pack cannot all draft the same leader at once.
   */
  private applyDraft(tick: number) {
    if (this.state.phase !== "racing") { return; }

    // Nearest drafter per leader, so drafting is one-on-one.
    const claim = new Map<string, { id: string; distance: number }>();
    for (const [id, runner] of this.state.players) {
      if (!runner.connected || runner.finished || runner.respawn > 0) { continue; }
      const speed = Math.hypot(runner.vx, runner.vz);
      if (speed < 4) { continue; }

      for (const [leadId, lead] of this.state.players) {
        if (leadId === id || !lead.connected || lead.finished || lead.chain <= 0) { continue; }
        const dx = lead.x - runner.x, dz = lead.z - runner.z;
        const distance = Math.hypot(dx, dz);
        if (distance < DRAFT_MIN || distance > DRAFT_MAX) { continue; }
        if (Math.abs(lead.y - runner.y) > 2) { continue; }
        // Behind them, and pointed the same way they are going.
        const cosine = (dx * runner.vx + dz * runner.vz) / (distance * speed);
        if (cosine < Math.cos(DRAFT_CONE)) { continue; }

        const held = claim.get(leadId);
        if (!held || distance < held.distance) { claim.set(leadId, { id, distance }); }
      }
    }

    const drafting = new Set<string>();
    for (const [leadId, { id }] of claim) {
      drafting.add(id);
      const ticks = (this.draft.get(id) ?? 0) + 1;
      if (ticks < DRAFT_TICKS) { this.draft.set(id, ticks); continue; }
      this.draft.set(id, 0);

      const lead = this.state.players.get(leadId);
      const runner = this.state.players.get(id);
      if (!lead || !runner || lead.chain <= 0) { continue; }
      lead.chain -= 1;
      runner.chain = Math.min(CHAIN_MAX, runner.chain + 1);
    }
    for (const [id] of this.state.players) {
      if (!drafting.has(id)) { this.draft.set(id, 0); }
    }
  }

  /** Fire any influence whose telegraph has run out. */
  private applyInfluence(tick: number) {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (tick < this.pending[i].at) { continue; }
      this.touchBreaker(this.pending[i].slot, tick, null);
      this.pending.splice(i, 1);
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

  /**
   * Record a split the tick a checkpoint is banked.
   *
   * The simulation owns *whether* a checkpoint was banked; the clock is the
   * room's business and is never predicted. A split that snapped would be worse
   * than no split at all - it is a number a player reads once and acts on.
   */
  private recordSplits(tick: number) {
    if (this.state.phase !== "racing" || this.state.raceStartTick < 0) { return; }
    const elapsed = Math.max(0, Math.round((tick - this.state.raceStartTick) * (1000 / TICK_RATE)));

    for (const [, player] of this.state.players) {
      for (let i = 0; i <= player.checkpoint && i < player.splits.length; i++) {
        if (player.splits[i] !== 0) { continue; }
        player.splits[i] = elapsed;
        const best = this.state.bestSplits[i];
        if (best === 0 || elapsed < best) { this.state.bestSplits[i] = elapsed; }
      }
    }
  }

  /**
   * One tick of whichever mode is running.
   *
   * Every branch here is a rule about scoring or about who is still in. None of
   * them reaches into the shared step, which is why a mode can be swapped
   * between rounds without touching a line of the determinism story.
   */
  private advanceMode(tick: number) {
    if (this.state.phase !== "racing") { return; }

    if (this.mode === "survival") {
      // A kill plane closing behind the field. Class A in spirit: one number,
      // advancing at a fixed rate from a fixed tick.
      const since = tick - this.state.raceStartTick - SURVIVAL_GRACE_TICKS;
      this.state.killLine = since <= 0 ? -1 : (since / TICK_RATE) * SURVIVAL_CLOSE_RATE;
      for (const [, player] of this.state.players) {
        if (player.finished || player.dnf || !player.connected) { continue; }
        if (player.progress < this.state.killLine) { player.dnf = true; }
      }
    }

    if (this.mode === "hunt") {
      if (!this.state.hare || !this.state.players.has(this.state.hare)) {
        // The runner in front is the hare, which keeps the role moving.
        let best = "";
        let furthest = -1;
        for (const [id, player] of this.state.players) {
          if (!player.connected || player.dnf) { continue; }
          if (player.progress > furthest) { furthest = player.progress; best = id; }
        }
        this.state.hare = best;
      }
      const hare = this.state.players.get(this.state.hare);
      if (hare) {
        for (const [id, hunter] of this.state.players) {
          if (id === this.state.hare || !hunter.connected || hunter.dnf) { continue; }
          const d = Math.hypot(hunter.x - hare.x, hunter.z - hare.z);
          if (d > HUNT_CATCH_RADIUS || Math.abs(hunter.y - hare.y) > 2) { continue; }
          if (tick - (this.caught.get(id) ?? -Infinity) < HUNT_COOL_TICKS) { continue; }
          this.caught.set(id, tick);
          hunter.seriesPoints += 1;
          this.broadcast("caught", { by: hunter.name, hare: hare.name });
        }
      }
    }
  }

  private detectFinishes(tick: number) {
    if (this.state.phase !== "racing") { return; }
    const lastCheckpoint = this.level.checkpoints.length - 1;

    for (const [, player] of this.state.players) {
      if (player.finished || player.dnf) { continue; }
      // The finish only counts with every checkpoint banked, which is what
      // makes skipping a section impossible rather than merely unrewarding.
      if (player.checkpoint < lastCheckpoint) { continue; }
      // Collect: the line is only a line once you are carrying enough.
      if (this.mode === "collect" && player.coins < COLLECT_TARGET) { continue; }
      if (!inVolume(player.x, player.y, player.z, this.level.finish)) { continue; }

      player.finished = true;
      player.progress = 1;
      player.finishMs = Math.max(0, Math.round((tick - this.state.raceStartTick) * (1000 / TICK_RATE)));
      this.state.finishers += 1;
      player.rank = this.state.finishers;
      if (this.firstFinishTick < 0) { this.firstFinishTick = tick; }
      this.broadcast("finish", { sessionId: keyOf(this.state.players, player), rank: player.rank });

      // A human who wins a bots-only field has completed the race from their
      // perspective. Do not make them wait for simulated rivals to negotiate
      // the rest of the course; a real opponent, even one reconnecting, keeps
      // the usual race and finish-grace rules intact.
      if (player.rank === 1 && !player.bot && this.everyOtherPlayerIsABot(player)) {
        this.endRace(tick);
        return;
      }
    }
  }

  /** True only when this human is the sole non-bot participant in the field. */
  private everyOtherPlayerIsABot(player: Player): boolean {
    for (const [, opponent] of this.state.players) {
      if (opponent !== player && !opponent.bot) { return false; }
    }
    return true;
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
        this.manageBots(tick);
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

  /** The last completed round, replayable. Developer tooling; never sent. */
  get recording(): RaceRecording | null { return this.lastRecording; }

  private beginRace(tick: number) {
    this.recorder = new Recorder(
      this.state.seed, this.state.seriesRound, this.level.verbs as any,
      this.level.spawns.length > 0 || this.level.obstacles.some((o) => o.kind === "nest"));
    for (const [sessionId, player] of this.state.players) {
      this.recorder.join(
        sessionId, player.name, player.colour, player.bot, player.tickBase,
        { x: player.x, y: player.y, z: player.z });
    }
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
    this.awardSeries();
    if (this.recorder) {
      const outcome = [];
      for (const [sessionId, player] of this.state.players) {
        outcome.push({
          sessionId,
          x: player.x, y: player.y, z: player.z,
          progress: player.progress, checkpoint: player.checkpoint, chain: player.chain,
        });
      }
      this.lastRecording = this.recorder.finish(outcome);
      this.recorder = null;
    }
    this.broadcast("raceOver", {});
  }

  /**
   * Bank the round into the series.
   *
   * A DNF scores nothing, and so does anything past fourth: the points are a
   * comeback mechanic, not a participation one. The final round doubles, which
   * is the whole reason a session still has a shape when somebody is two rounds
   * down.
   */
  private awardSeries() {
    const final = this.state.seriesRound >= this.state.seriesLength - 1;
    // Sprint is a short course, so it is worth double - which is what stops a
    // deck that shortens the race also shrinking what it is worth.
    const multiplier = (final ? SERIES_FINAL_MULTIPLIER : 1)
      * seriesMultiplier(this.mutators);

    for (const [, player] of this.state.players) {
      const base = player.finished && !player.dnf
        ? (SERIES_POINTS[player.rank - 1] ?? 0)
        : 0;
      player.seriesPoints += base * multiplier;
    }

    let leader = "";
    let best = -1;
    let tied = false;
    for (const [sessionId, player] of this.state.players) {
      if (player.seriesPoints > best) {
        best = player.seriesPoints; leader = sessionId; tied = false;
      } else if (player.seriesPoints === best) {
        tied = true;
      }
    }
    // Out of rounds, or out of reach. A tie at the top leaves the series live
    // rather than crowning an arbitrary one of them.
    if ((final || best >= SERIES_TARGET) && leader && !tied) {
      this.state.seriesWinner = leader;
    } else if (final) {
      this.state.seriesWinner = "";
    }
  }

  /** Start the next round, or a whole new series if this one is decided. */
  private advanceSeries() {
    const final = this.state.seriesRound >= this.state.seriesLength - 1;
    if (final || this.state.seriesWinner) {
      this.state.seriesRound = 0;
      this.state.seriesWinner = "";
      for (const [, player] of this.state.players) { player.seriesPoints = 0; }
    } else {
      this.state.seriesRound += 1;
    }
  }

  /**
   * A player arriving mid-series enters on the current last-place score.
   *
   * Zero would make them mathematically eliminated the moment they sat down,
   * which is the one thing a comeback mechanic must not do to a newcomer.
   */
  private seedSeriesPoints(): number {
    let lowest = Infinity;
    for (const [, player] of this.state.players) {
      if (player.seriesPoints < lowest) { lowest = player.seriesPoints; }
    }
    return Number.isFinite(lowest) ? lowest : 0;
  }

  /** New seed, fresh course, everyone back on the line. */
  private resetRound(tick: number) {
    this.armLevel(randomSeed());
    this.state.round += 1;
    this.advanceSeries();
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
      player.ammo = 0;
      player.fireCool = -1;
      player.actionHeld = false;
      player.useHeld = false;
      player.pickupIn = 0;
      player.burnTick = -1;
      player.burnAmount = 0;
      player.shieldUntil = -1;
      player.anchorId = 0;
      player.ropeLen = 0;
      player.tension = 0;
      player.tetherCool = -1;
      player.tetherUntil = -1;
      player.recallCharges = 1;
      player.recallUntil = -1;
      player.recallHeld = 0;
      player.influence = 1;
      // A new round is a new past. Carrying the ring over would let a runner
      // recall into the previous course.
      clearRecallRing(this.historyFor(keyOf(this.state.players, player)));
      player.coins = 0;
      player.breaks = 0;
      player.rank = 0;
      player.finished = false;
      player.finishMs = 0;
      player.dnf = false;
      player.falls = 0;
      this.sizeSplits(player);
    }
  }

  /** Resize a player's split array to the course they are about to run. */
  private sizeSplits(player: Player) {
    const count = this.level.checkpoints.length;
    player.splits.clear();
    for (let i = 0; i < count; i++) { player.splits.push(0); }
  }

  /** Build the course for `seed` and publish everything clients need to match it. */
  /**
   * Build the course for `seed` and publish everything clients need to match it.
   *
   * `deck` exists because the deck is a decision the room makes rather than a
   * property of the seed: changing mode re-arms the same seed, and a caller
   * that wants a known course - a test, a ranked mode - has to be able to say
   * so. Omitted, it is whatever the seed is worth.
   */
  private armLevel(seed: number, deck: MutatorId[] = drawMutators(seed)) {
    this.mutators = deck;
    this.level = buildLevelWith(seed, {
      mutators: this.mutators,
      tokens: this.mode === "collect" ? COLLECT_TOKENS : 0,
    });
    this.mutators = this.level.mutators as MutatorId[];
    this.world.level = this.level;
    this.state.seed = seed;
    this.state.mutators = this.mutators.join(",");
    this.state.mode = this.mode;
    this.state.killLine = -1;
    this.state.hare = "";
    this.caught.clear();

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

    this.breakerTicks.length = 0;
    this.state.breakerTicks.clear();
    for (let i = 0; i < this.level.breakerCount; i++) {
      this.breakerTicks.push(-1);
      this.state.breakerTicks.push(-1);
    }

    this.pickupTicks.length = 0;
    this.state.pickupTicks.clear();
    for (let i = 0; i < this.level.pickupCount; i++) {
      this.pickupTicks.push(-1);
      this.state.pickupTicks.push(-1);
    }

    this.shellTicks.length = 0;
    this.state.shellTicks.clear();
    for (let i = 0; i < this.level.shellCount; i++) {
      this.shellTicks.push(-1);
      this.state.shellTicks.push(-1);
    }

    this.phase.raceStartTick = -1;
    this.state.raceStartTick = -1;

    this.state.seriesLength = SERIES_LENGTH;
    // Last round's bests become this round's reference before they are cleared.
    this.state.prevBestSplits.clear();
    for (let i = 0; i < this.state.bestSplits.length; i++) {
      this.state.prevBestSplits.push(this.state.bestSplits[i]);
    }
    this.state.bestSplits.clear();
    for (let i = 0; i < this.level.checkpoints.length; i++) { this.state.bestSplits.push(0); }

    this.threats.reset(this.level, this.state.tick);
    this.state.enemies.clear();
    this.world.enemies = this.threats.enemies;
    this.mirrorThreats();
  }

  /**
   * Keep the lobby the right size.
   *
   * Bots fill a thin field and step aside for humans at a round boundary, never
   * mid-race. They are capped below the best human in the room by profile
   * rather than by fiat: a bot that cheats makes losing to one meaningless.
   */
  private manageBots(tick: number) {
    const humans = this.humanCount();
    // Not immediately. A lone player gets the same wait a solo run does before
    // the room decides nobody else is coming - filling on arrival would take
    // the choice away from someone who is waiting for a friend.
    const unlocked = this.state.soloUnlockTick >= 0 && tick >= this.state.soloUnlockTick;
    const want = humans === 0 || (humans === 1 && !unlocked)
      ? 0
      : (BOT_FILL[Math.min(humans, BOT_FILL.length - 1)] ?? 0);
    const target = Math.max(0, want - humans);

    while (this.bots.size > target) {
      const [id] = [...this.bots.keys()];
      this.bots.delete(id);
      this.state.players.delete(id);
      this.histories.delete(id);
    }
    while (this.bots.size < target && this.state.players.size < MAX_PLAYERS) {
      this.addBot(tick);
    }
  }

  private addBot(tick: number) {
    const id = `bot-${this.botCount++}`;
    const colour = this.freeColour();
    const player = new Player();
    const names = ["Vex", "Juno", "Kite", "Orin", "Sable"];
    player.name = names[this.botCount % names.length];
    player.colour = colour;
    player.bot = true;
    const slot = lobbySlot(this.joinCount++ % MAX_PLAYERS);
    player.x = slot.x;
    player.y = this.level.spawn.y;
    player.z = slot.z;
    player.active = true;
    player.tickBase = tick;
    player.seriesPoints = this.seedSeriesPoints();
    this.state.players.set(id, player);
    this.sizeSplits(player);

    // Fair, not hard: a pace-setter rather than a boss.
    this.bots.set(id, {
      controller: new BotController(BOT_PROFILES.fair, (this.botCount * 7919 + tick) | 0),
      channel: new BotChannel(),
    });
  }

  private humanCount(): number {
    let n = 0;
    for (const [id, player] of this.state.players) {
      if (player.connected && !this.bots.has(id)) { n++; }
    }
    return n;
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
