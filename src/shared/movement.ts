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
  ACCEL_FALLOFF, AIR_ACCEL, AIR_DRAG, BACK_SCALE, CARVE_COOL_TICKS,
  CARVE_ENTRY_SPEED, CARVE_EXIT_SPEED, CARVE_FRICTION, CARVE_HEIGHT_SCALE,
  CARVE_MAX_TICKS, CARVE_TURN_SCALE, CHAIN_AIR_ACCEL_BONUS, CHAIN_DECAY_TICKS,
  CHAIN_MAX, CHAIN_SPEED_PER, COYOTE_TICKS, FALL_GRAVITY_MULT, GRAVITY, GROUND_ACCEL,
  GROUND_FRICTION, HEAVY_HOLD_TICKS, HEAVY_PLANT_TICKS, HEAVY_RADIUS_BASE,
  HEAVY_RADIUS_MAX, HEAVY_RADIUS_SCALE, HOP_SPEED_BONUS, HOP_WINDOW_TICKS,
  IMPACT_BUFFER_TICKS, IMPACT_CONVERT, IMPACT_FUMBLE_KEEP, IMPACT_NEUTRAL_KEEP,
  IMPACT_PERFECT_KEEP, IMPACT_WINDOW, JUMP_BUFFER_TICKS, JUMP_CUT_MULT,
  JUMP_SPEED, KILL_Y, LAUNCH_CHAIN, LAUNCH_WINDOW, MAX_FALL_SPEED, MAX_SPEED,
  OVERSPEED_DECAY, PLAYER_HEIGHT, PLAYER_RADIUS, PUSH_MAX_SPEED, PUSH_STRENGTH,
  RESPAWN_TICKS, RUN_SPEED, SLOPE_ACCEL_SCALE, STRAFE_SCALE, STUN_CONTROL,
  STUN_TICKS,
} from "./constants.js";
import {
  bodyOverlapsBox, type Body, type BoxLike, hazardHit, type HitNormal, inVolume,
  nearStatic, resolveHorizontal, resolveRamp, resolveVertical,
} from "./collision.js";
import type { Level, Obstacle } from "./level.js";
import { isActiveAt, makePose, poseAt, type Pose, type WorldPhase } from "./obstacles.js";
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

export type FxKind = "jump" | "land" | "hit" | "respawn" | "checkpoint" | "perfect" | "fumble" | "heavy" | "hop";

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
  /** Client-only presentation hook. Never called during a rollback replay. */
  fx?(kind: FxKind, x: number, y: number, z: number): void;
}

// Scratch. The step runs thousands of times a second under rollback; none of
// this should allocate.
const poseA: Pose = makePose();
const poseB: Pose = makePose();
const hit: HitNormal = { nx: 0, nz: 0, hit: false };
const box: BoxLike = { x: 0, y: 0, z: 0, hx: 0, hy: 0, hz: 0, yaw: 0 };
const body: Body = {
  x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
  grounded: false, groundId: 0, height: PLAYER_HEIGHT,
};

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

function refreshChain(state: SimState, tick: number) {
  state.chainDecayUntil = tick + CHAIN_DECAY_TICKS;
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

export function stepPlayer(ctx: StepCtx, state: SimState, cmd: SimInput, world: SimWorld): void {
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
    if (!cmd.alt) { state.heavySince = -1; }
    return;
  }

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
    state.chain -= 1;
    state.chainDecayUntil = t0 + CHAIN_DECAY_TICKS / 3;
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
    if (state.chain >= 4) {
      state.chain = Math.min(CHAIN_MAX, state.chain + 2);
      refreshChain(state, t0);
    }
    if (live) { world.fx?.("checkpoint", body.x, body.y, body.z); }
  }

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
        const k = Math.max(0, 1 - GROUND_FRICTION * (state.carving ? CARVE_FRICTION : 1) * dt);
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
      state.chain = Math.min(CHAIN_MAX, state.chain + 1);
      refreshChain(state, Math.floor(tA));
      if (live) { world.fx?.("hop", body.x, body.y, body.z); }
    }
    if (live) { world.fx?.("jump", body.x, body.y, body.z); }
  }

  // ---------------------------------------------------------------- 4. gravity
  let g = GRAVITY;
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

  const landed = body.grounded && !wasGrounded;

  // The surface rises in +Z, so gravity accelerates toward -Z on the ramp.
  if (groundedRamp >= 0) {
    const ramp = level.ramps[groundedRamp];
    const rise = ramp.y1 - ramp.y0;
    const length = ramp.hz * 2;
    body.vz -= GRAVITY * SLOPE_ACCEL_SCALE * (rise / Math.hypot(length, rise)) * dt;
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
    const impulse = Math.min(PUSH_STRENGTH * overlap * dt, PUSH_MAX_SPEED);
    body.vx += nx * impulse;
    body.vz += nz * impulse;
  }

  // ------------------------------------------------------------- 8. hazard hits
  if (state.stun <= 0) {
    for (const ob of level.obstacles) {
      if (ob.role !== "hazard") { continue; }
      poseAt(ob, tB, phase, poseB);
      if (Math.abs(poseB.z - body.z) > ob.size.z / 2 + ob.size.x / 2 + 2) { continue; }
      hazardHit(body, poseB, ob.size.x, ob.size.y, ob.size.z, hit);
      if (!hit.hit) { continue; }
      const knock = ob.knock ?? 12;
      body.vx = hit.nx * knock;
      body.vz = hit.nz * knock;
      body.vy = Math.max(body.vy, 6.4);
      body.grounded = false;
      body.groundId = 0;
      state.stun = STUN_TICKS;
      breakChain(state);
      if (live) { world.fx?.("hit", body.x, body.y + 0.9, body.z); }
      break;
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
    state.chain = Math.min(CHAIN_MAX, state.chain + 1);
    refreshChain(state, wholeTick);
    if (live) { world.fx?.("perfect", body.x, body.y, body.z); }
  } else if (fumble) {
    body.vx *= IMPACT_FUMBLE_KEEP;
    body.vz *= IMPACT_FUMBLE_KEEP;
    breakChain(state);
    if (live) { world.fx?.("fumble", body.x, body.y, body.z); }
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
