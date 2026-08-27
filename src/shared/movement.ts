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
  AIR_ACCEL, AIR_DRAG, COYOTE_TICKS, FALL_GRAVITY_MULT, GRAVITY, GROUND_ACCEL,
  GROUND_FRICTION, JUMP_BUFFER_TICKS, JUMP_CUT_MULT, JUMP_SPEED, KILL_Y,
  MAX_FALL_SPEED, PLAYER_RADIUS, PUSH_MAX_SPEED, PUSH_STRENGTH, RESPAWN_TICKS,
  RUN_SPEED, STUN_CONTROL, STUN_TICKS,
} from "./constants.js";
import {
  type Body, type BoxLike, hazardHit, type HitNormal, inVolume, nearStatic,
  resolveHorizontal, resolveRamp, resolveVertical,
} from "./collision.js";
import type { Level, Obstacle } from "./level.js";
import { isActiveAt, makePose, poseAt, type Pose, type WorldPhase } from "./obstacles.js";
import { checkpointProgress, pathProgress } from "./progress.js";

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
}

/** What the wire carries from the client each tick. */
export interface SimInput {
  moveX: number;
  moveZ: number;
  yaw: number;
  jump: boolean;
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

export type FxKind = "jump" | "land" | "hit" | "respawn" | "checkpoint";

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
  /** Server-only: the player just went back to a checkpoint. */
  onRespawn?(voluntary: boolean): void;
  /** Client-only presentation hook. Never called during a rollback replay. */
  fx?(kind: FxKind, x: number, y: number, z: number): void;
}

// Scratch. The step runs thousands of times a second under rollback; none of
// this should allocate.
const poseA: Pose = makePose();
const poseB: Pose = makePose();
const hit: HitNormal = { nx: 0, nz: 0, hit: false };
const box: BoxLike = { x: 0, y: 0, z: 0, hx: 0, hy: 0, hz: 0, yaw: 0 };
const body: Body = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grounded: false, groundId: 0 };

/** Fill `box` from an obstacle's pose. Solids are yaw-only by construction. */
function boxFromPose(ob: Obstacle, pose: Pose): BoxLike {
  box.x = pose.x; box.y = pose.y; box.z = pose.z;
  box.hx = ob.size.x / 2; box.hy = ob.size.y / 2; box.hz = ob.size.z / 2;
  box.yaw = pose.yaw;
  return box;
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

  // Jump press detection: the wire carries the held state, so the edge is ours
  // to find - and finding it here means it replays identically.
  const pressed = cmd.jump && !state.jumpHeld;
  if (pressed) { state.jumpBuf = JUMP_BUFFER_TICKS; }
  state.jumpHeld = cmd.jump;
  if (state.jumpBuf > 0) { state.jumpBuf -= 1; }

  const control = state.stun > 0 ? STUN_CONTROL : 1;
  if (state.stun > 0) { state.stun -= 1; }

  const subDt = ctx.subDt;
  for (let s = 0; s < ctx.subSteps; s++) {
    const tA = t0 + s / ctx.subSteps;
    const tB = t0 + (s + 1) / ctx.subSteps;
    subStep(state, cmd, control, subDt, 1 / ctx.subSteps, tA, tB, world, live);
  }

  state.x = body.x; state.y = body.y; state.z = body.z;
  state.vx = body.vx; state.vy = body.vy; state.vz = body.vz;
  state.grounded = body.grounded; state.groundId = body.groundId;

  // ------------------------------------------------------------------ triggers
  const cps = level.checkpoints;
  const nextCp = state.checkpoint + 1;
  if (nextCp < cps.length && inVolume(body.x, body.y, body.z, cps[nextCp].volume)) {
    state.checkpoint = nextCp;
    if (live) { world.fx?.("checkpoint", body.x, body.y, body.z); }
  }

  if (world.onPlate) {
    for (const plate of level.plates) {
      if (inVolume(body.x, body.y, body.z, plate.volume)) {
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
  state.respawn = RESPAWN_TICKS;
  // Falling costs you the ground you had gained past your last checkpoint -
  // otherwise a player could bank a lead by diving off a shortcut.
  state.progress = checkpointProgress(level, state.checkpoint);
  if (live) { world.fx?.("respawn", spawn.x, spawn.y, spawn.z); }
  world.onRespawn?.(voluntary);
}

function subStep(
  state: SimState, cmd: SimInput, control: number, dt: number, subFrac: number,
  tA: number, tB: number, world: SimWorld, live: boolean,
): void {
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
    const accel = (body.grounded ? GROUND_ACCEL : AIR_ACCEL) * control;
    const targetX = wx * RUN_SPEED;
    const targetZ = wz * RUN_SPEED;
    body.vx += (targetX - body.vx) * Math.min(1, accel * dt / RUN_SPEED);
    body.vz += (targetZ - body.vz) * Math.min(1, accel * dt / RUN_SPEED);
  } else if (body.grounded) {
    const k = Math.max(0, 1 - GROUND_FRICTION * dt);
    body.vx *= k; body.vz *= k;
  } else {
    const k = Math.max(0, 1 - AIR_DRAG * dt);
    body.vx *= k; body.vz *= k;
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
    if (live) { world.fx?.("jump", body.x, body.y, body.z); }
  }

  // ---------------------------------------------------------------- 4. gravity
  let g = GRAVITY;
  if (body.vy < 0) { g *= FALL_GRAVITY_MULT; }
  else if (body.vy > 0 && !cmd.jump) { g *= JUMP_CUT_MULT; }
  body.vy -= g * dt;
  if (body.vy < -MAX_FALL_SPEED) { body.vy = -MAX_FALL_SPEED; }

  // -------------------------------------------------- 5. vertical move + resolve
  const wasGrounded = body.grounded;
  body.y += body.vy * dt;
  body.grounded = false;
  body.groundId = 0;

  for (const s of level.solids) {
    if (!nearStatic(s, body.x, body.z)) { continue; }
    if (resolveVertical(body, s) === 1) { body.grounded = true; }
  }
  for (const ramp of level.ramps) {
    if (resolveRamp(body, ramp)) { body.grounded = true; }
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

  if (body.grounded && !wasGrounded && live) {
    world.fx?.("land", body.x, body.y, body.z);
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
      if (live) { world.fx?.("hit", body.x, body.y + 0.9, body.z); }
      break;
    }
  }
}

/** Obstacles are few and the list is stable; a linear scan beats a Map here. */
function findObstacle(level: Level, id: number): Obstacle | undefined {
  const list = level.obstacles;
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) { return list[i]; }
  }
  return undefined;
}
