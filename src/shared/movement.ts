/**
 * The shared simulation step.
 *
 * This function is the contract between the server and every predicting client:
 * the server runs it once per input it receives, the client runs it the instant
 * it presses a key and again for every unacknowledged input on each rollback.
 * Same inputs, same world tick, same result - that is what lets a player ride a
 * moving platform with zero latency and still have the server be the authority.
 *
 * Everything it reads is either on `state`, on `command`, or on the `SimWorld`
 * handed in - and everything on `SimWorld` is either static level data or a
 * synchronised integer. No clocks, no randomness, no ambient state.
 */

import {
  ACCEL_FALLOFF, AIR_ACCEL, AIR_DRAG, AMMO_MAX, BACK_SCALE, BURN_SPEED_PER,
  CRATE_AMMO, FIRE_COOL_TICKS, PICKUP_RADIUS, SHOT_EYE, CARVE_COOL_TICKS,
  TETHER_CHAIN_COST, TETHER_COOL_TICKS, TETHER_HEIGHT_RATE, TETHER_MAX_TICKS,
  TETHER_MIN_LENGTH, TETHER_SPEED_GAIN,
  RECALL_ARM_TICKS, RECALL_FINISH_GUARD, RECALL_FREEZE_TICKS, RECALL_TICKS,
  SENTRY_STUN_TICKS,
  CARVE_ENTRY_SPEED, CARVE_EXIT_SPEED, CARVE_FRICTION, CARVE_HEIGHT_SCALE,
  CARVE_MAX_TICKS, CARVE_TURN_SCALE, CHAIN_AIR_ACCEL_BONUS,
  CHAIN_MAX, CHAIN_SPEED_PER, COYOTE_TICKS, FALL_GRAVITY_MULT, GROUND_ACCEL,
  HEAVY_HOLD_TICKS, HEAVY_PLANT_TICKS, HEAVY_RADIUS_BASE,
  HEAVY_RADIUS_MAX, HEAVY_RADIUS_SCALE, HOP_SPEED_BONUS, HOP_WINDOW_TICKS,
  IMPACT_BUFFER_TICKS, IMPACT_CONVERT, IMPACT_FUMBLE_KEEP, IMPACT_NEUTRAL_KEEP,
  IMPACT_PERFECT_KEEP, IMPACT_WINDOW, JUMP_BUFFER_TICKS, JUMP_CUT_MULT,
  JUMP_SPEED, KILL_Y, LAUNCH_CHAIN, LAUNCH_WINDOW, MAX_FALL_SPEED, MAX_SPEED,
  OVERSPEED_DECAY, PLAYER_HEIGHT, PLAYER_RADIUS, PUSH_MAX_SPEED,
  RESPAWN_TICKS, RUN_SPEED, SLOPE_ACCEL_SCALE, STRAFE_SCALE, STUN_CONTROL,
  STUN_TICKS,
} from "./constants.js";
import {
  bodyOverlapsBox, type Body, type BoxLike, hazardHit, type HitNormal, inVolume,
  nearStatic, resolveHorizontal, resolveRamp, resolveVertical,
} from "./collision.js";
import type { Level, Obstacle } from "./level.js";
import {
  isActiveAt, makePose, pickupAvailable, poseAt, type Pose, type WorldPhase,
} from "./obstacles.js";
import { makeShotResult, resolveShot, type ShotResult } from "./salvo.js";
import {
  findAnchor, releaseValue, ropeLength, selectAnchor, tetherConstraint,
} from "./tether.js";
import { recallSampleAt, recordRecall, type RecallRing } from "./recall.js";
import {
  enemyIsSolid, enemyPoseAt, enemyShape, type EnemyView,
} from "./enemies.js";
import { baseTuning } from "./generator.js";
import { checkpointProgress, pathProgress } from "./progress.js";
import { clamp } from "./math.js";

/** The fields of a player that the simulation owns, on either side of the wire. */
export interface SimState {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Facing, driven by the camera. Simulated so remote players face correctly. */
  yaw: number;
  grounded: boolean;
  /** Obstacle currently being ridden, or 0. */
  groundId: number;
  /** Ticks of ledge-forgiveness left. */
  coyote: number;
  /** Ticks a buffered jump press stays live. */
  jumpBuf: number;
  /** Was the jump key down last step? Turns a held key into a single press. */
  jumpHeld: boolean;
  /** Ticks of reduced control after a hazard hit. */
  stun: number;
  /** Ticks left of the respawn freeze. */
  respawn: number;
  /** Highest checkpoint banked, -1 before the first one. */
  checkpoint: number;
  /** Fraction of the course completed, 0..1. */
  progress: number;

  /** Landing conversions build this 0..8 soft-cap multiplier. */
  chain: number;
  /** Ticks left in the early Impact press buffer. */
  impactBuf: number;
  /** Last secondary-action held state, used for deterministic edges. */
  heavyHeld: boolean;
  /** Heavy remains committed after its eight-tick hold completes. */
  heavyArmed: boolean;
  /** World tick secondary action began being held, or -1. */
  heavySince: number;
  /** Lander displacement protection stamp, or -1. */
  plantUntil: number;
  /** Next world tick at which Chain loses one point, or -1. */
  chainDecayUntil: number;

  carving: boolean;
  /** World tick the active carve auto-expires, or -1. */
  carveUntil: number;
  /** World tick at which carve can next be entered, or -1. */
  carveCool: number;
  /** Ticks remaining after standing in which a carve hop can fire. */
  hopWindow: number;

  /** Server-authored stamped impulse. It is consumed by the victim's step. */
  knockTick: number;
  knockX: number;
  knockY: number;
  knockZ: number;

  // ---- the Salvo -----------------------------------------------------------
  /** Shots in the magazine. Simulated and predicted, like everything Class A. */
  ammo: number;
  /** World tick at which the next shot may be fired, or -1 when cold. */
  fireCool: number;
  /** Held state of the primary action; the step finds the firing edge. */
  actionHeld: boolean;
  /** Held state of the context action; the step finds the spending edge. */
  useHeld: boolean;
  /**
   * Slot+1 of the pickup currently overlapped, 0 for none.
   *
   * A pickup is granted on the *edge* of entering it, so a runner who stops on
   * the pad does not sweep it up again on every tick they stand there.
   */
  pickupIn: number;
  /** Server-stamped coin spend, applied by the buyer's own step. */
  burnTick: number;
  burnAmount: number;
  /** World tick the bought Chain shield expires, or -1 when unarmed. */
  shieldUntil: number;

  // ---- the Tether ----------------------------------------------------------
  /** Attached anchor id + 1, or 0 when detached. */
  anchorId: number;
  /** Rope length, fixed at the distance the attach was made from. */
  ropeLen: number;
  /**
   * Swing tension banked so far, in (u/s . s).
   *
   * A full number rather than the spec's quantised uint8: the accumulator is
   * integrated per sub-step, and rounding it into a byte on every one of those
   * either loses the whole gain or has to be scaled so coarsely that the
   * release stops being readable. Three bytes is not worth a field the two ends
   * can disagree about.
   */
  tension: number;
  /** World tick a new attach is allowed, or -1 when cold. */
  tetherCool: number;
  /** World tick the current swing is force-released, or -1 when detached. */
  tetherUntil: number;

  // ---- Recall --------------------------------------------------------------
  /** Restores in hand. One per checkpoint segment, plus any bought with coins. */
  recallCharges: number;
  /** World tick the recall freeze ends, or -1 when not frozen. */
  recallUntil: number;
  /** Ticks the context action has been held, for the four-tick arm. */
  recallHeld: number;
}

/** What the wire carries from the client each tick. */
export interface SimInput {
  moveX: number;
  moveZ: number;
  yaw: number;
  pitch: number;
  jump: boolean;
  action: boolean;
  alt: boolean;
  use: boolean;
  respawn: boolean;
}

/**
 * The step context, narrowed to what the step actually uses. Both Colyseus'
 * server `StepContext` and the SDK reconciler's client one satisfy this
 * structurally, so neither side needs an adapter.
 */
export interface StepCtx {
  readonly dt: number;
  readonly tick: number;
  readonly subSteps: number;
  readonly subDt: number;
  readonly isReplay?: boolean;
}

export interface OtherBody { x: number; y: number; z: number }

export type FxKind =
  | "jump" | "land" | "hit" | "respawn" | "checkpoint" | "perfect" | "fumble"
  | "heavy" | "hop" | "shot" | "break" | "pickup" | "burn" | "shield"
  | "tether" | "swing" | "lift" | "recall" | "arm";

export interface SimWorld {
  level: Level;
  phase: WorldPhase;
  /**
   * World tick of this player's input seq 0. The server assigns it and
   * synchronises it, so a rolling-back client indexes obstacle motion by
   * exactly the tick the server used for the same input.
   */
  tickBase: number;
  /** Other players, for shoving. Server: live state. Client: interpolated. */
  others: OtherBody[];
  /**
   * Live enemies, as their committed arcs.
   *
   * Not positions: an arc, which both ends evaluate with the same pure function
   * at whatever fractional tick the sub-step is on. That is what lets a
   * predicting client collide with one at a tick the server has not reached.
   */
  enemies?: readonly EnemyView[];
  /** Server-only: the player just stood on a crumble platform. */
  onCrumble?(slot: number, tick: number): void;
  /** Server-only: the player is standing on a pressure plate. */
  onPlate?(plate: number, tick: number): void;
  /** Server-only: a Heavy shockwave hit a Heavy-only plate. */
  onHeavyPlate?(plate: number, tick: number): void;
  /** Server-only: authoritative landing contact that breaks the lander's Chain. */
  hasLandingContact?(x: number, y: number, z: number): boolean;
  /** Server-only: the player just went back to a checkpoint. */
  onRespawn?(voluntary: boolean): void;
  /** Server-only: resolve a Heavy landing against other authoritative players. */
  onHeavy?(x: number, y: number, z: number, radius: number, tick: number): void;
  /** Server-only: a shot connected with a breaker. */
  onShot?(slot: number, tick: number): void;
  /** Server-only: the player swept up a floating pickup. */
  onPickup?(slot: number, tick: number): void;
  /** Server-only: a shot took a turret shell out of the air. */
  onShell?(slot: number, tick: number): void;
  /** Server-only: a shot connected with an enemy. */
  onEnemyHit?(id: number, tick: number): void;
  /** Server-only: the player asked to spend their coins. Validated there. */
  onSpend?(tick: number): void;
  /**
   * The stepping player's own history ring, for Recall.
   *
   * Both ends keep one and neither sends it. Indexed by world tick, so a
   * rollback replay rewrites the same slots with the same values rather than
   * remembering a different past on every re-simulation.
   */
  history?: RecallRing;
  /** Client-only presentation hook. Never called during a rollback replay. */
  fx?(kind: FxKind, x: number, y: number, z: number): void;
}

// Scratch. The step runs thousands of times a second under rollback; none of
// this should allocate.
const poseA: Pose = makePose();
const poseB: Pose = makePose();
const hit: HitNormal = { nx: 0, nz: 0, hit: false };
const box: BoxLike = { x: 0, y: 0, z: 0, hx: 0, hy: 0, hz: 0, yaw: 0 };
const shot: ShotResult = makeShotResult();
const body: Body = {
  x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
  grounded: false, groundId: 0, height: PLAYER_HEIGHT,
};

/** The collision box of a solid enemy at a pose. Axis-aligned by construction. */
function enemyBox(e: EnemyView, pose: Pose): BoxLike {
  const shape = enemyShape(e.kind);
  box.x = pose.x; box.y = pose.y + shape.height / 2; box.z = pose.z;
  box.hx = shape.radius; box.hy = shape.height / 2; box.hz = shape.radius;
  box.yaw = 0;
  return box;
}

/** Fill `box` from an obstacle's pose. Solids are yaw-only by construction. */
function boxFromPose(ob: Obstacle, pose: Pose): BoxLike {
  box.x = pose.x; box.y = pose.y; box.z = pose.z;
  box.hx = ob.size.x / 2; box.hy = ob.size.y / 2; box.hz = ob.size.z / 2;
  box.yaw = pose.yaw;
  return box;
}

/** The Chain is deliberately only a velocity-derived soft cap, never new velocity. */
export function softCap(state: Pick<SimState, "chain">): number {
  return RUN_SPEED * (1 + CHAIN_SPEED_PER * clamp(state.chain, 0, CHAIN_MAX));
}

/**
 * Chain timing and gain come off the level, not out of `constants.ts`.
 *
 * A mutator that halved the decay by changing the constant would change it on
 * the server and not on the client, because the client compiled its own copy
 * in. Reading it from the level - which both ends rebuild from one seed - is
 * what makes a mutator safe.
 */
let tuning = baseTuning();

function refreshChain(state: SimState, tick: number) {
  state.chainDecayUntil = tick + tuning.chainDecayTicks;
}

/** One conversion's worth of Chain, which a mutator may double. */
function addChain(state: SimState, tick: number) {
  state.chain = Math.min(CHAIN_MAX, state.chain + tuning.chainGain);
  refreshChain(state, tick);
}

function breakChain(state: SimState) {
  state.chain = 0;
  state.chainDecayUntil = -1;
}

function beginCarve(state: SimState, tick: number) {
  state.carving = true;
  state.carveUntil = tick + CARVE_MAX_TICKS;
  state.hopWindow = 0;
}

function endCarve(state: SimState, tick: number) {
  state.carving = false;
  state.carveUntil = -1;
  state.carveCool = tick + CARVE_COOL_TICKS;
  state.hopWindow = HOP_WINDOW_TICKS;
}

/** True if a full-height capsule can occupy the current feet position. */
function canStand(level: Level, phase: WorldPhase, tick: number): boolean {
  const height = body.height;
  body.height = PLAYER_HEIGHT;
  for (const solid of level.solids) {
    if (nearStatic(solid, body.x, body.z) && bodyOverlapsBox(body, solid)) {
      body.height = height;
      return false;
    }
  }
  for (const ob of level.obstacles) {
    if (ob.role !== "solid" || !isActiveAt(ob, tick, phase)) { continue; }
    poseAt(ob, tick, phase, poseB);
    if (!poseB.active) { continue; }
    if (Math.abs(poseB.z - body.z) > ob.size.z / 2 + ob.size.x / 2 + 2) { continue; }
    if (bodyOverlapsBox(body, boxFromPose(ob, poseB))) {
      body.height = height;
      return false;
    }
  }
  body.height = height;
  return true;
}

/**
 * One simulated tick, plus the one thing that must happen on every path
 * through it: a sample in the Recall ring.
 *
 * The step has half a dozen early returns - respawn freezes, the recall freeze
 * itself, falling out of the world - and a history with holes in it is a
 * history a restore silently refuses to use. Recording here rather than at the
 * end of the step is what makes the ring continuous.
 */
export function stepPlayer(ctx: StepCtx, state: SimState, cmd: SimInput, world: SimWorld): void {
  tuning = world.level.tuning;
  stepCore(ctx, state, cmd, world);
  if (world.history) {
    recordRecall(
      world.history, Math.floor(world.tickBase + ctx.tick),
      state.x, state.y, state.z, state.vx, state.vy, state.vz,
      state.grounded, state.groundId,
    );
  }
}

function stepCore(ctx: StepCtx, state: SimState, cmd: SimInput, world: SimWorld): void {
  const live = !ctx.isReplay;
  const level = world.level;
  const t0 = world.tickBase + ctx.tick;

  // Facing follows the camera immediately - it is an input, not a simulation
  // result, but it lives in state so remote players are drawn facing correctly.
  state.yaw = cmd.yaw;

  // ------------------------------------------------------------ respawn freeze
  if (state.respawn > 0) {
    state.respawn -= 1;
    state.vx = 0; state.vy = 0; state.vz = 0;
    state.grounded = true;
    state.groundId = 0;
    state.jumpHeld = cmd.jump;
    state.heavyHeld = cmd.alt;
    state.actionHeld = cmd.action;
    state.useHeld = cmd.use;
    state.pickupIn = 0;
    state.anchorId = 0;
    state.recallHeld = 0;
    if (!cmd.alt) { state.heavySince = -1; }
    return;
  }

  // ------------------------------------------------------------ recall freeze
  // Position is held but velocity is not zeroed: what was restored is a moment,
  // and the moment includes how fast the runner was going. Control returns at
  // the end of the freeze with exactly that velocity - and if the ground they
  // came back to has moved on since, they fall, which is the mechanic.
  if (state.recallUntil >= 0 && t0 < state.recallUntil) {
    state.jumpHeld = cmd.jump;
    state.heavyHeld = cmd.alt;
    state.actionHeld = cmd.action;
    state.useHeld = cmd.use;
    state.recallHeld = 0;
    return;
  }
  if (state.recallUntil >= 0) { state.recallUntil = -1; }

  // A deliberate "I am stuck" reset costs the same freeze as falling does.
  if (cmd.respawn) {
    beginRespawn(state, level, world, live, true);
    return;
  }

  body.x = state.x; body.y = state.y; body.z = state.z;
  body.vx = state.vx; body.vy = state.vy; body.vz = state.vz;
  body.grounded = state.grounded; body.groundId = state.groundId;
  body.height = state.carving ? PLAYER_HEIGHT * CARVE_HEIGHT_SCALE : PLAYER_HEIGHT;
  const hopAtStart = state.hopWindow;

  // A stamped impulse belongs to the victim's own deterministic step. If it
  // arrived late, apply it at the first available world tick rather than
  // correcting position - the result reads as reaction lag, never a teleport.
  if (state.knockTick >= 0 && t0 >= state.knockTick && t0 > state.plantUntil) {
    body.vx += state.knockX;
    body.vy += state.knockY;
    body.vz += state.knockZ;
    body.grounded = false;
    body.groundId = 0;
    state.stun = Math.max(state.stun, STUN_TICKS);
    breakChain(state);
    state.knockTick = -1;
    state.knockX = 0; state.knockY = 0; state.knockZ = 0;
    if (live) { world.fx?.("hit", body.x, body.y + body.height * 0.5, body.z); }
  }

  // Jump press detection: the wire carries the held state, so the edge is ours
  // to find - and finding it here means it replays identically.
  const pressed = cmd.jump && !state.jumpHeld;
  if (pressed) { state.jumpBuf = JUMP_BUFFER_TICKS; }
  state.jumpHeld = cmd.jump;
  if (state.jumpBuf > 0) { state.jumpBuf -= 1; }

  // The three Stage-0 action bits are held state. `alt` supplies both Impact
  // and Carve, so its edge and hold stamp must be derived in the shared step.
  const altPressed = cmd.alt && !state.heavyHeld;
  let impactAge = Infinity;
  if (altPressed) {
    state.impactBuf = IMPACT_BUFFER_TICKS + 1;
    impactAge = 0;
  } else if (state.impactBuf > 0) {
    // Inspect before decrementing: a one-tick remainder is still a deliberately
    // late input and must resolve as a Fumble, not as an unpunished Neutral.
    impactAge = IMPACT_BUFFER_TICKS - state.impactBuf + 1;
  }
  if (!cmd.alt && !state.heavyArmed) { state.heavySince = -1; }
  state.heavyHeld = cmd.alt;
  if (state.impactBuf > 0) { state.impactBuf -= 1; }

  // ------------------------------------------------------------- the Salvo
  // Held on the wire, edge-detected here, exactly like the jump: that is what
  // makes a shot replay identically and stops firing being spammable past the
  // cooldown under rollback.
  const firePressed = cmd.action && !state.actionHeld;
  state.actionHeld = cmd.action;
  state.useHeld = cmd.use;

  // One wire bit, two verbs - which is what "primary action: tether / fire" has
  // meant since stage 0. An anchor in the cone claims the press, because
  // anchors are explicit level content placed on a swing line and a breaker
  // never sits on one; a press with no anchor in front of it is a shot.
  const tetherReady = state.anchorId === 0
    && (state.tetherCool < 0 || t0 >= state.tetherCool)
    && level.verbs.includes("tether");
  let attached = false;
  if (firePressed && tetherReady) {
    const anchor = selectAnchor(
      level, world.phase, t0, body.x, body.y + SHOT_EYE, body.z, cmd.yaw, cmd.pitch,
    );
    if (anchor) {
      state.anchorId = anchor.id + 1;
      state.ropeLen = Math.max(TETHER_MIN_LENGTH, ropeLength(anchor, body.x, body.y, body.z));
      state.tension = 0;
      state.tetherUntil = t0 + TETHER_MAX_TICKS;
      // Attaching costs a Chain point. The verb has to be able to punish, or a
      // swing is strictly better than running and the course collapses.
      state.chain = Math.max(0, state.chain - TETHER_CHAIN_COST);
      attached = true;
      if (live) { world.fx?.("tether", anchor.x, anchor.y, anchor.z); }
    }
  }

  // Let go on the release edge, or when the two-second cap runs out. Nobody
  // hangs: the tether is a beat inside a section, not a way to stop racing.
  if (state.anchorId !== 0 && !attached && (!cmd.action || t0 >= state.tetherUntil)) {
    resolveRelease(state, world, t0, live);
  }

  if (firePressed && !attached && state.ammo > 0 && (state.fireCool < 0 || t0 >= state.fireCool)) {
    state.ammo -= 1;
    state.fireCool = t0 + FIRE_COOL_TICKS;
    resolveShot(
      level, world.phase, t0,
      body.x, body.y + SHOT_EYE, body.z, cmd.yaw, cmd.pitch, shot,
      world.enemies,
    );
    if (shot.slot >= 0) {
      // A crate is the one effect the shooter keeps to themselves; everything
      // else a breaker does happens to the course, for everybody.
      if (shot.effect === "crate") { state.ammo = Math.min(AMMO_MAX, state.ammo + CRATE_AMMO); }
      world.onShot?.(shot.slot, Math.floor(t0));
      if (live) { world.fx?.("break", shot.x, shot.y, shot.z); }
    } else if (shot.shellSlot >= 0) {
      world.onShell?.(shot.shellSlot, Math.floor(t0));
      if (live) { world.fx?.("break", shot.x, shot.y, shot.z); }
    } else if (shot.enemyId !== 0) {
      world.onEnemyHit?.(shot.enemyId, Math.floor(t0));
      if (live) { world.fx?.("break", shot.x, shot.y, shot.z); }
    }
    if (live) { world.fx?.("shot", shot.x, shot.y, shot.z); }
  }

  // The context action carries two verbs, split by how long it is held: a tap
  // burns the purse, a four-tick hold fires Recall. Holding is the spec's own
  // guard against firing the recovery verb by accident, and using it as the
  // discriminator is what leaves the stage-0 input packet untouched.
  //
  // Spending is a server-validated stamp either way: coins are Class D and the
  // client is never allowed to decide it could afford something.
  if (cmd.use) {
    state.recallHeld += 1;
    if (state.recallHeld === RECALL_ARM_TICKS) {
      if (fireRecall(state, world, t0, live)) { return; }
      // Refused - no charge, no history, too near the line. Say so rather than
      // quietly doing nothing.
      if (live) { world.fx?.("arm", body.x, body.y, body.z); }
    }
  } else {
    if (state.recallHeld > 0 && state.recallHeld < RECALL_ARM_TICKS) {
      world.onSpend?.(Math.floor(t0));
    }
    state.recallHeld = 0;
  }

  // Countdown timing is server-ticked, so every latency sees the same launch
  // window. It is a reward only; missing it never changes ordinary movement.
  if (pressed && world.phase.raceStartTick >= 0
    && Math.abs(t0 - world.phase.raceStartTick) <= LAUNCH_WINDOW) {
    state.chain = Math.max(state.chain, LAUNCH_CHAIN);
    refreshChain(state, t0);
  }

  // A Chain waits three seconds after its last conversion, then loses one
  // point per second. A delayed replay may be past several stamps, but one
  // decrement per simulated input retains deterministic visible beats.
  if (state.chain > 0 && state.chainDecayUntil >= 0 && t0 >= state.chainDecayUntil) {
    state.chain -= tuning.chainGain;
    if (state.chain < 0) { state.chain = 0; }
    state.chainDecayUntil = t0 + tuning.chainDecayTicks / 3;
  }

  // Carve exits are blocked by a real stand-up test. This is intentionally
  // before integration: a low capsule never expands into a ceiling mid-tick.
  if (state.carving && (!cmd.alt || t0 >= state.carveUntil
    || Math.hypot(body.vx, body.vz) < softCap(state) * CARVE_EXIT_SPEED)) {
    if (canStand(level, world.phase, t0)) {
      endCarve(state, t0);
      body.height = PLAYER_HEIGHT;
    }
  }
  const carveReady = state.carveCool < 0 || t0 >= state.carveCool;
  if (!state.carving && body.grounded && cmd.alt && carveReady
    && Math.hypot(body.vx, body.vz) >= softCap(state) * CARVE_ENTRY_SPEED) {
    beginCarve(state, t0);
    body.height = PLAYER_HEIGHT * CARVE_HEIGHT_SCALE;
  } else if (!state.carving && !body.grounded && altPressed && carveReady) {
    // Dive: enter the same carve state in air so landing continues it.
    beginCarve(state, t0);
    body.height = PLAYER_HEIGHT * CARVE_HEIGHT_SCALE;
    body.vx += Math.sin(state.yaw) * RUN_SPEED * 0.25;
    body.vz += Math.cos(state.yaw) * RUN_SPEED * 0.25;
  }

  const control = state.stun > 0 ? STUN_CONTROL : 1;
  if (state.stun > 0) { state.stun -= 1; }

  const subDt = ctx.subDt;
  let impactSpeed = -1;
  let impactTick = t0;
  let landedThisTick = false;
  for (let s = 0; s < ctx.subSteps; s++) {
    const tA = t0 + s / ctx.subSteps;
    const tB = t0 + (s + 1) / ctx.subSteps;
    const landedWith = subStep(
      state, cmd, control, subDt, 1 / ctx.subSteps, tA, tB, world, live, landedThisTick,
    );
    if (landedWith >= 0) {
      impactSpeed = landedWith;
      impactTick = tB;
      landedThisTick = true;
    }
  }

  // Resolve once the fixed tick's collision work is complete. That makes the
  // documented 100/85/65% retention exact rather than applying friction again
  // in the remaining sub-steps after an early touchdown.
  if (impactSpeed >= 0) {
    resolveImpact(state, cmd, impactSpeed, impactTick, impactAge, world, live);
  }

  // Burn converts banked coins straight back into speed. It lands after the
  // tick's collision work precisely so the frame that fires it is never the
  // frame that decays it - overspeed is a resource, and buying it has to
  // deliver the whole amount before the drain gets a look at it.
  if (state.burnTick >= 0 && t0 >= state.burnTick) {
    const gain = BURN_SPEED_PER * state.burnAmount;
    const speed = Math.hypot(body.vx, body.vz);
    if (speed > 1e-6) {
      const k = (speed + gain) / speed;
      body.vx *= k; body.vz *= k;
    } else {
      body.vx += Math.sin(state.yaw) * gain;
      body.vz += Math.cos(state.yaw) * gain;
    }
    state.burnTick = -1;
    state.burnAmount = 0;
    if (live) { world.fx?.("burn", body.x, body.y, body.z); }
  }

  state.x = body.x; state.y = body.y; state.z = body.z;
  state.vx = body.vx; state.vy = body.vy; state.vz = body.vz;
  state.grounded = body.grounded; state.groundId = body.groundId;

  // A window opened by this very landing/stand-up starts at a full eight
  // future inputs; only a pre-existing window spends the current tick.
  if (hopAtStart > 0 && state.hopWindow === hopAtStart) { state.hopWindow -= 1; }

  // ------------------------------------------------------------------ triggers
  const cps = level.checkpoints;
  const nextCp = state.checkpoint + 1;
  if (nextCp < cps.length && inVolume(body.x, body.y, body.z, cps[nextCp].volume, body.height)) {
    state.checkpoint = nextCp;
    // One restore per checkpoint segment. Banking a checkpoint hands the
    // segment charge back; anything bought with coins sits on top of it.
    state.recallCharges = Math.max(state.recallCharges, 1);
    if (state.chain >= 4) {
      state.chain = Math.min(CHAIN_MAX, state.chain + 2 * tuning.chainGain);
      refreshChain(state, t0);
    }
    if (live) { world.fx?.("checkpoint", body.x, body.y, body.z); }
  }

  // Floating pickups are swept up by running through them - the gun is a spot
  // on the course two runners can converge on, not a button.
  let inPickup = 0;
  for (const p of level.pickups) {
    if (!pickupAvailable(p, t0, world.phase)) { continue; }
    const dx = body.x - p.x;
    const dy = body.y + body.height * 0.5 - p.y;
    const dz = body.z - p.z;
    if (dx * dx + dy * dy + dz * dz > PICKUP_RADIUS * PICKUP_RADIUS) { continue; }
    inPickup = p.slot + 1;
    if (state.pickupIn !== inPickup) {
      state.ammo = Math.min(AMMO_MAX, state.ammo + p.ammo);
      world.onPickup?.(p.slot, Math.floor(t0));
      if (live) { world.fx?.("pickup", p.x, p.y, p.z); }
    }
    break;
  }
  state.pickupIn = inPickup;

  if (world.onPlate) {
    for (const plate of level.plates) {
      if (plate.activation === "hold" && inVolume(body.x, body.y, body.z, plate.volume, body.height)) {
        world.onPlate(plate.id, Math.floor(t0));
      }
    }
  }

  // ------------------------------------------------------------------- falling
  if (body.y < KILL_Y) {
    beginRespawn(state, level, world, live, false);
    return;
  }

  const p = pathProgress(level, body.x, body.z);
  if (p > state.progress) { state.progress = p; }
}

/**
 * Spend a swing.
 *
 * Three outcomes and no partial credit, which is the whole point: a swing you
 * mistimed leaves you slower than simply running would have, because you also
 * paid a Chain point to start it.
 */
function resolveRelease(state: SimState, world: SimWorld, tick: number, live: boolean) {
  const anchor = findAnchor(world.level, state.anchorId - 1);
  if (anchor) {
    const value = releaseValue(body, anchor, state.ropeLen);
    if (value.outcome === "speed") {
      // At the bottom of the arc the swing is all horizontal, and this is the
      // one release that pays Chain.
      body.vx += value.tx * TETHER_SPEED_GAIN;
      body.vz += value.tz * TETHER_SPEED_GAIN;
      body.grounded = false;
      body.groundId = 0;
      addChain(state, Math.floor(tick));
      if (live) { world.fx?.("swing", body.x, body.y, body.z); }
    } else if (value.outcome === "height") {
      // Climbing out of the arc: the banked tension becomes altitude, and
      // reaches geometry nothing else in the kit does.
      body.vy += state.tension * TETHER_HEIGHT_RATE;
      body.grounded = false;
      body.groundId = 0;
      if (live) { world.fx?.("lift", body.x, body.y, body.z); }
    }
  }
  detachTether(state, tick);
}

function detachTether(state: SimState, tick: number) {
  state.anchorId = 0;
  state.ropeLen = 0;
  state.tension = 0;
  state.tetherUntil = -1;
  state.tetherCool = tick + TETHER_COOL_TICKS;
}

/**
 * Restore position, velocity and footing from forty-five ticks ago.
 *
 * Returns false - and costs nothing - when the restore is refused, so the arm
 * fails loudly rather than silently eating a charge.
 */
function fireRecall(state: SimState, world: SimWorld, tick: number, live: boolean): boolean {
  if (state.recallCharges <= 0 || state.recallUntil >= 0) { return false; }
  const ring = world.history;
  if (!ring) { return false; }

  const sample = recallSampleAt(ring, Math.floor(tick) - RECALL_TICKS);
  if (!sample) { return false; }

  // Not on the doorstep. A restore this close to the line is a second attempt
  // at the finish rather than a recovery.
  const finish = world.level.finish;
  if (Math.hypot(state.x - finish.x, state.z - finish.z) < RECALL_FINISH_GUARD) {
    return false;
  }

  state.x = sample.x; state.y = sample.y; state.z = sample.z;
  state.vx = sample.vx; state.vy = sample.vy; state.vz = sample.vz;
  state.grounded = sample.grounded;
  state.groundId = sample.groundId;

  // Everything a recall does *not* restore, spelled out. The world has moved on
  // and so has everything the runner was in the middle of - the swing, the
  // carve, the landing, and above all the Chain, which is the price.
  state.recallCharges -= 1;
  state.recallUntil = Math.floor(tick) + RECALL_FREEZE_TICKS;
  state.recallHeld = 0;
  state.stun = 0;
  state.jumpBuf = 0;
  state.impactBuf = 0;
  state.heavyArmed = false;
  state.heavySince = -1;
  state.plantUntil = -1;
  state.carving = false;
  state.carveUntil = -1;
  state.hopWindow = 0;
  state.anchorId = 0;
  state.ropeLen = 0;
  state.tension = 0;
  state.tetherUntil = -1;
  state.knockTick = -1;
  state.knockX = 0; state.knockY = 0; state.knockZ = 0;
  breakChain(state);
  if (live) { world.fx?.("recall", state.x, state.y, state.z); }
  return true;
}

function beginRespawn(
  state: SimState, level: Level, world: SimWorld, live: boolean, voluntary: boolean,
): void {
  const cp = state.checkpoint >= 0 ? level.checkpoints[state.checkpoint] : null;
  const spawn = cp ? cp.spawn : level.spawn;
  state.x = spawn.x; state.y = spawn.y; state.z = spawn.z;
  state.vx = 0; state.vy = 0; state.vz = 0;
  state.grounded = true;
  state.groundId = 0;
  state.stun = 0;
  state.jumpBuf = 0;
  state.impactBuf = 0;
  state.heavyHeld = false;
  state.heavyArmed = false;
  state.heavySince = -1;
  state.plantUntil = -1;
  state.carving = false;
  state.carveUntil = -1;
  state.carveCool = -1;
  state.hopWindow = 0;
  state.knockTick = -1;
  state.knockX = 0; state.knockY = 0; state.knockZ = 0;
  // Ammo, coins and a bought shield survive a fall. They are banked energy, and
  // taking them away would make the recovering player's tool the one thing a
  // recovering player cannot have.
  state.pickupIn = 0;
  state.actionHeld = false;
  state.useHeld = false;
  // A rope does not survive a fall. The cooldown does not either - respawning
  // already costs the freeze and everything past the checkpoint.
  state.anchorId = 0;
  state.ropeLen = 0;
  state.tension = 0;
  state.tetherUntil = -1;
  state.tetherCool = -1;
  state.recallHeld = 0;
  state.recallUntil = -1;
  breakChain(state);
  state.respawn = RESPAWN_TICKS;
  // Falling costs you the ground you had gained past your last checkpoint -
  // otherwise a player could bank a lead by diving off a shortcut.
  state.progress = checkpointProgress(level, state.checkpoint);
  if (live) { world.fx?.("respawn", spawn.x, spawn.y, spawn.z); }
  world.onRespawn?.(voluntary);
}

function subStep(
  state: SimState, cmd: SimInput, control: number, dt: number, subFrac: number,
  tA: number, tB: number, world: SimWorld, live: boolean, landedThisTick: boolean,
): number {
  const level = world.level;
  const phase = world.phase;

  // --------------------------------------------------- 1. ride what we stand on
  if (body.groundId !== 0) {
    const ob = findObstacle(level, body.groundId);
    if (ob && isActiveAt(ob, tB, phase)) {
      poseAt(ob, tA, phase, poseA);
      poseAt(ob, tB, phase, poseB);
      body.x += poseB.x - poseA.x;
      body.y += poseB.y - poseA.y;
      body.z += poseB.z - poseA.z;
      const dYaw = poseB.yaw - poseA.yaw;
      if (dYaw !== 0) {
        // Carried around a spinning platform: rotate our offset from its axis.
        const rx = body.x - poseB.x, rz = body.z - poseB.z;
        const c = Math.cos(dYaw), sn = Math.sin(dYaw);
        body.x = poseB.x + rx * c - rz * sn;
        body.z = poseB.z + rx * sn + rz * c;
      }
    } else {
      body.groundId = 0;
    }
  }

  // ------------------------------------------------------------ 2. horizontal accel
  let dirX = cmd.moveX;
  let dirZ = cmd.moveZ;
  if (dirX !== 0 || dirZ !== 0) {
    const len = Math.hypot(dirX, dirZ);
    dirX /= len; dirZ /= len;
    // Input is camera-relative: +Z is "away from the camera".
    const c = Math.cos(cmd.yaw), sn = Math.sin(cmd.yaw);
    const wx = dirX * c + dirZ * sn;
    const wz = -dirX * sn + dirZ * c;
    // Forward is fastest, strafe is deliberate, and backpedalling is a real
    // commitment. The dot is against facing, not velocity, so it is stable
    // while a player is sliding through a turn.
    const facingX = Math.sin(state.yaw), facingZ = Math.cos(state.yaw);
    const facingDot = wx * facingX + wz * facingZ;
    const directionalScale = facingDot >= 0
      ? STRAFE_SCALE + (1 - STRAFE_SCALE) * facingDot
      : STRAFE_SCALE + (STRAFE_SCALE - BACK_SCALE) * facingDot;
    const cap = softCap(state);
    const speed = Math.hypot(body.vx, body.vz);
    const airAccel = AIR_ACCEL + CHAIN_AIR_ACCEL_BONUS * clamp(state.chain, 0, CHAIN_MAX) / CHAIN_MAX;
    let accel = (body.grounded ? GROUND_ACCEL : airAccel) * control;
    if (body.grounded) {
      accel *= 1 - ACCEL_FALLOFF * clamp(speed / cap, 0, 1);
      if (state.carving) { accel *= CARVE_TURN_SCALE; }
    } else if (state.carving) {
      // A dive has intent, but never the full precision of a normal jump.
      accel *= 0.5;
    }
    const targetX = wx * cap * directionalScale;
    const targetZ = wz * cap * directionalScale;
    const dx = targetX - body.vx, dz = targetZ - body.vz;
    const delta = Math.hypot(dx, dz);
    const maxDelta = accel * dt;
    if (delta <= maxDelta || delta < 1e-9) {
      body.vx = targetX; body.vz = targetZ;
    } else {
      body.vx += dx / delta * maxDelta;
      body.vz += dz / delta * maxDelta;
    }
  } else if (body.grounded) {
    if (!landedThisTick) {
      // Overspeed is intentionally a separate resource. Ground friction owns
      // ordinary coasting below the soft cap; excess speed decays only through
      // the fixed 4.5 u/s² drain below, never an accidental second drain.
      if (Math.hypot(body.vx, body.vz) <= softCap(state)) {
        const k = Math.max(0, 1 - tuning.groundFriction * (state.carving ? CARVE_FRICTION : 1) * dt);
        body.vx *= k; body.vz *= k;
      }
    }
  } else {
    const k = Math.max(0, 1 - AIR_DRAG * dt);
    body.vx *= k; body.vz *= k;
  }

  // A soft cap never throws speed away on the frame that produced it. It only
  // drains excess at a predictable rate, leaving downhill and launch moments
  // readable. MAX_SPEED is a separate collision safety cap.
  let horizontalSpeed = Math.hypot(body.vx, body.vz);
  const cap = softCap(state);
  if (horizontalSpeed > cap) {
    const decayed = Math.max(cap, horizontalSpeed - OVERSPEED_DECAY * dt);
    body.vx *= decayed / horizontalSpeed;
    body.vz *= decayed / horizontalSpeed;
    horizontalSpeed = decayed;
  }
  if (horizontalSpeed > MAX_SPEED) {
    body.vx *= MAX_SPEED / horizontalSpeed;
    body.vz *= MAX_SPEED / horizontalSpeed;
  }

  // ------------------------------------------------------------------- 3. jump
  // Coyote time is counted in ticks but decays per sub-step, so the window is
  // the same length no matter how finely the tick is subdivided.
  if (body.grounded) { state.coyote = COYOTE_TICKS; }
  else if (state.coyote > 0) { state.coyote = Math.max(0, state.coyote - subFrac); }

  if (state.jumpBuf > 0 && state.coyote > 0 && state.stun <= 0) {
    body.vy = JUMP_SPEED;
    body.grounded = false;
    body.groundId = 0;
    state.coyote = 0;
    state.jumpBuf = 0;
    if (state.hopWindow > 0) {
      body.vx *= 1 + HOP_SPEED_BONUS;
      body.vz *= 1 + HOP_SPEED_BONUS;
      state.hopWindow = 0;
      addChain(state, Math.floor(tA));
      if (live) { world.fx?.("hop", body.x, body.y, body.z); }
    }
    if (live) { world.fx?.("jump", body.x, body.y, body.z); }
  }

  // ---------------------------------------------------------------- 4. gravity
  let g = tuning.gravity;
  if (body.vy < 0) { g *= FALL_GRAVITY_MULT; }
  else if (body.vy > 0 && !cmd.jump) { g *= JUMP_CUT_MULT; }
  body.vy -= g * dt;
  if (body.vy < -MAX_FALL_SPEED) { body.vy = -MAX_FALL_SPEED; }

  // Heavy is a descent commitment, not a second use of the Carve hold. The
  // stamp starts on the first descending sub-step and remains committed after
  // eight complete ticks even if the player releases just before landing.
  if (cmd.alt && !state.carving && body.vy < 0) {
    if (state.heavySince < 0) { state.heavySince = Math.floor(tA); }
    if (tB - state.heavySince >= HEAVY_HOLD_TICKS) { state.heavyArmed = true; }
  } else if (!state.heavyArmed) {
    state.heavySince = -1;
  }

  // ------------------------------------------------------ 4b. the tether rope
  // After gravity and before the resolve, so the collision pass always gets
  // the last word and the constraint can never seat a body inside geometry.
  if (state.anchorId !== 0) {
    const anchor = findAnchor(level, state.anchorId - 1);
    if (anchor) {
      state.tension = tetherConstraint(body, anchor, state.ropeLen, state.tension, dt);
    } else {
      state.anchorId = 0;
    }
  }

  // -------------------------------------------------- 5. vertical move + resolve
  const wasGrounded = body.grounded;
  const landingSpeed = Math.min(MAX_FALL_SPEED, Math.max(0, -body.vy));
  body.y += body.vy * dt;
  body.grounded = false;
  body.groundId = 0;

  for (const s of level.solids) {
    if (!nearStatic(s, body.x, body.z)) { continue; }
    if (resolveVertical(body, s) === 1) { body.grounded = true; }
  }
  let groundedRamp = -1;
  for (let i = 0; i < level.ramps.length; i++) {
    if (resolveRamp(body, level.ramps[i])) {
      body.grounded = true;
      groundedRamp = i;
    }
  }
  for (const ob of level.obstacles) {
    if (ob.role !== "solid") { continue; }
    if (!isActiveAt(ob, tB, phase)) { continue; }
    poseAt(ob, tB, phase, poseB);
    if (!poseB.active) { continue; }
    if (Math.abs(poseB.z - body.z) > ob.size.z / 2 + ob.size.x / 2 + 2) { continue; }
    if (resolveVertical(body, boxFromPose(ob, poseB)) === 1) {
      body.grounded = true;
      body.groundId = ob.id;
      if (ob.kind === "crumble" && world.onCrumble) {
        world.onCrumble(ob.slot, Math.floor(tB));
      }
    }
  }

  // A solid enemy is a surface, and the only one in the game whose position
  // came off the wire. It is safe to stand on precisely because that position
  // is *derived* from a committed arc rather than dead-reckoned - a wrong guess
  // about a soft impulse costs centimetres and heals, and a wrong guess about a
  // surface costs metres and snaps.
  if (world.enemies) {
    for (const e of world.enemies) {
      if (!e.alive || !enemyIsSolid(e.kind)) { continue; }
      enemyPoseAt(e, tB, poseB);
      if (Math.abs(poseB.z - body.z) > 6) { continue; }
      if (resolveVertical(body, enemyBox(e, poseB)) === 1) { body.grounded = true; }
    }
  }

  const landed = body.grounded && !wasGrounded;

  // The surface rises along the ramp's own +Z, so gravity accelerates down its
  // local -Z. `yaw` is where that points in the world.
  if (groundedRamp >= 0) {
    const ramp = level.ramps[groundedRamp];
    const rise = ramp.y1 - ramp.y0;
    const length = ramp.hz * 2;
    const pull = tuning.gravity * SLOPE_ACCEL_SCALE * (rise / Math.hypot(length, rise)) * dt;
    if (ramp.yaw === 0) {
      body.vz -= pull;
    } else {
      body.vx += pull * Math.sin(ramp.yaw);
      body.vz -= pull * Math.cos(ramp.yaw);
    }
  }

  // ------------------------------------------------ 6. horizontal move + resolve
  body.x += body.vx * dt;
  body.z += body.vz * dt;
  const canStep = body.grounded;

  for (const s of level.solids) {
    if (!nearStatic(s, body.x, body.z)) { continue; }
    resolveHorizontal(body, s, canStep);
  }
  for (const ob of level.obstacles) {
    if (ob.role !== "solid") { continue; }
    if (!isActiveAt(ob, tB, phase)) { continue; }
    poseAt(ob, tB, phase, poseB);
    if (!poseB.active) { continue; }
    if (Math.abs(poseB.z - body.z) > ob.size.z / 2 + ob.size.x / 2 + 2) { continue; }
    resolveHorizontal(body, boxFromPose(ob, poseB), canStep);
  }

  if (world.enemies) {
    for (const e of world.enemies) {
      if (!e.alive || !enemyIsSolid(e.kind)) { continue; }
      enemyPoseAt(e, tB, poseB);
      if (Math.abs(poseB.z - body.z) > 6) { continue; }
      resolveHorizontal(body, enemyBox(e, poseB), canStep);
    }
  }

  // ---------------------------------------------------- 7. shove other players
  for (const other of world.others) {
    if (tB <= state.plantUntil) { break; }
    const dx = body.x - other.x;
    const dz = body.z - other.z;
    if (Math.abs(body.y - other.y) > 1.6) { continue; }
    const d2 = dx * dx + dz * dz;
    const minD = PLAYER_RADIUS * 2;
    if (d2 >= minD * minD || d2 < 1e-8) { continue; }
    const d = Math.sqrt(d2);
    const overlap = (minD - d) / minD;
    const nx = dx / d, nz = dz / d;
    const impulse = Math.min(tuning.pushStrength * overlap * dt, PUSH_MAX_SPEED);
    body.vx += nx * impulse;
    body.vz += nz * impulse;
  }

  // ------------------------------------------------------------- 8. hazard hits
  if (state.stun <= 0) {
    for (const ob of level.obstacles) {
      if (ob.role !== "hazard") { continue; }
      // A shot weak point holds this hazard inert for five seconds - for
      // everyone in the section, including whoever is right behind you.
      if (!isActiveAt(ob, tB, phase)) { continue; }
      poseAt(ob, tB, phase, poseB);
      if (Math.abs(poseB.z - body.z) > ob.size.z / 2 + ob.size.x / 2 + 2) { continue; }
      hazardHit(body, poseB, ob.size.x, ob.size.y, ob.size.z, hit);
      if (!hit.hit) { continue; }
      // A sentry slows rather than launches: no knockback at all, which is
      // what makes it feel like being caught in a beam rather than being hit
      // by a hammer. Same stun, same Chain break, no velocity.
      if (!ob.stunOnly) {
        const knock = ob.knock ?? 12;
        body.vx = hit.nx * knock;
        body.vz = hit.nz * knock;
        body.vy = Math.max(body.vy, 6.4);
        body.grounded = false;
        body.groundId = 0;
      }
      state.stun = ob.stunOnly ? SENTRY_STUN_TICKS : STUN_TICKS;
      breakChain(state);
      if (live) { world.fx?.("hit", body.x, body.y + 0.9, body.z); }
      break;
    }

    // Hazard enemies resolve in the same sub-step slot as the player shove,
    // whose ordering is already proven deterministic. Never a surface, never a
    // blocker: the predicted body passes straight through if it has to, which
    // is exactly why a dead reckoning error here is harmless.
    if (state.stun <= 0 && world.enemies) {
      for (const e of world.enemies) {
        if (!e.alive || enemyIsSolid(e.kind)) { continue; }
        enemyPoseAt(e, tB, poseB);
        const shape = enemyShape(e.kind);
        const dx = body.x - poseB.x;
        const dz = body.z - poseB.z;
        const reach = shape.radius + PLAYER_RADIUS;
        if (dx * dx + dz * dz >= reach * reach) { continue; }
        if (body.y > poseB.y + shape.height || body.y + body.height < poseB.y) { continue; }
        const d = Math.hypot(dx, dz) || 1;
        body.vx = (dx / d) * shape.knock;
        body.vz = (dz / d) * shape.knock;
        body.vy = Math.max(body.vy, 5.6);
        body.grounded = false;
        body.groundId = 0;
        state.stun = STUN_TICKS;
        breakChain(state);
        if (live) { world.fx?.("hit", body.x, body.y + 0.9, body.z); }
        break;
      }
    }
  }
  return landed ? landingSpeed : -1;
}

/** Resolve the entire Impact decision at the one landing transition. */
function resolveImpact(
  state: SimState, cmd: SimInput, impactSpeed: number, tick: number, impactAge: number,
  world: SimWorld, live: boolean,
) {
  const wholeTick = Math.floor(tick);
  const heldTicks = state.heavySince < 0 ? 0 : tick - state.heavySince;
  const heavy = state.heavyArmed || (cmd.alt && heldTicks >= HEAVY_HOLD_TICKS);

  if (heavy) {
    body.vx = 0;
    body.vz = 0;
    breakChain(state);
    state.plantUntil = wholeTick + HEAVY_PLANT_TICKS;
    state.impactBuf = 0;
    state.heavyArmed = false;
    // A held button cannot immediately arm another Heavy; it needs a new edge.
    state.heavySince = -1;
    const radius = clamp(
      HEAVY_RADIUS_BASE + impactSpeed * HEAVY_RADIUS_SCALE,
      HEAVY_RADIUS_BASE,
      HEAVY_RADIUS_MAX,
    );
    triggerHeavyTargets(world, radius, wholeTick);
    world.onHeavy?.(body.x, body.y, body.z, radius, wholeTick);
    if (live) { world.fx?.("heavy", body.x, body.y, body.z); }
    return;
  }

  // The age is captured before the buffer decrements, so its final live tick
  // still resolves as an active mistake rather than silently becoming Neutral.
  const perfect = impactAge <= IMPACT_WINDOW;
  const fumble = impactAge <= IMPACT_BUFFER_TICKS && !perfect;

  if (perfect) {
    const forward = IMPACT_CONVERT * impactSpeed;
    body.vx = body.vx * IMPACT_PERFECT_KEEP + Math.sin(state.yaw) * forward;
    body.vz = body.vz * IMPACT_PERFECT_KEEP + Math.cos(state.yaw) * forward;
    addChain(state, wholeTick);
    if (live) { world.fx?.("perfect", body.x, body.y, body.z); }
  } else if (fumble) {
    if (state.shieldUntil >= 0 && wholeTick < state.shieldUntil) {
      // A bought Chain shield spends itself here, degrading the mistake to a
      // Neutral landing. It protects the thing the game is actually about.
      state.shieldUntil = -1;
      body.vx *= IMPACT_NEUTRAL_KEEP;
      body.vz *= IMPACT_NEUTRAL_KEEP;
      if (live) { world.fx?.("shield", body.x, body.y, body.z); }
    } else {
      body.vx *= IMPACT_FUMBLE_KEEP;
      body.vz *= IMPACT_FUMBLE_KEEP;
      breakChain(state);
      if (live) { world.fx?.("fumble", body.x, body.y, body.z); }
    }
  } else {
    // Neutral is deliberately viable: doing nothing retains the Stage-1 run.
    body.vx *= IMPACT_NEUTRAL_KEEP;
    body.vz *= IMPACT_NEUTRAL_KEEP;
    if (live) { world.fx?.("land", body.x, body.y, body.z); }
  }
  state.impactBuf = 0;

  // Contact is a server-authoritative outcome. Clients deliberately predict
  // the local landing only; the authoritative correction breaks Chain if the
  // server found another runner in the landing window.
  if (world.hasLandingContact?.(body.x, body.y, body.z)) { breakChain(state); }
}

/** Fire Heavy-only plates and crumble floors through server-published stamps. */
function triggerHeavyTargets(world: SimWorld, radius: number, tick: number) {
  const level = world.level;
  for (const plate of level.plates) {
    if (plate.activation !== "heavy") { continue; }
    if (distanceToRect(body.x, body.z, plate.volume.x, plate.volume.z, plate.volume.hx, plate.volume.hz) <= radius
      && body.y <= plate.volume.y + plate.volume.hy + 1.2) {
      world.onHeavyPlate?.(plate.id, tick);
    }
  }
  for (const ob of level.obstacles) {
    if (ob.kind !== "crumble" || !isActiveAt(ob, tick, world.phase)) { continue; }
    poseAt(ob, tick, world.phase, poseA);
    if (!poseA.active) { continue; }
    if (distanceToRect(body.x, body.z, poseA.x, poseA.z, ob.size.x / 2, ob.size.z / 2) <= radius) {
      world.onCrumble?.(ob.slot, tick);
    }
  }
}

function distanceToRect(x: number, z: number, cx: number, cz: number, hx: number, hz: number): number {
  return Math.hypot(Math.max(Math.abs(x - cx) - hx, 0), Math.max(Math.abs(z - cz) - hz, 0));
}

/** Obstacles are few and the list is stable; a linear scan beats a Map here. */
function findObstacle(level: Level, id: number): Obstacle | undefined {
  const list = level.obstacles;
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) { return list[i]; }
  }
  return undefined;
}
