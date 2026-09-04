/**
 * Bots.
 *
 * The structural claim is the whole point: `simulatePlayers()` steps every
 * player out of an input channel, so **a bot is an object that fills one**.
 * There is no special case anywhere in `src/shared`, no separate movement or
 * collision code, and no way for a bot to cheat by construction - it presses
 * the same nine fields a human does and they go through the same `sanitize`.
 *
 * Everything it knows, a human could know too. The centre-line is a navmesh
 * because race position is already scored on it; hazard awareness is
 * `raycastWorld()` and `poseAt()`, which are pure functions a skilled player
 * learns the shape of; and when it is stuck it presses R, exactly as a human
 * does. Difficulty is expressed only as reaction time, timing error, which
 * verbs it uses, and how often it lapses - never as speed, reach, or knowledge.
 * The moment a bot cheats, losing to one stops meaning anything.
 */

import {
  CARVE_ENTRY_SPEED, FALL_GRAVITY_MULT, GRAVITY, IMPACT_WINDOW, PITCH_MAX,
  PITCH_MIN, PLAYER_RADIUS, RUN_SPEED, SHOT_EYE, TETHER_HAND, TETHER_RANGE,
  TICK_RATE,
} from "../shared/constants.js";
import { raycastWorld, STEP_HEIGHT, type RayHit } from "../shared/collision.js";
import type { Level, Vec3 } from "../shared/level.js";
import { sanitizeRaceInput } from "../shared/input.js";
import { clamp, mulberry32 } from "../shared/math.js";
import type { SimInput, SimState } from "../shared/movement.js";
import { isActiveAt, makePose, poseAt, type Pose, type WorldPhase } from "../shared/obstacles.js";
import { pathProgress, pointOnPath } from "../shared/progress.js";
import { releaseValue, selectAnchor } from "../shared/tether.js";

export interface BotProfile {
  name: string;
  /** Ticks between re-plans. A human's reaction time, and nothing more. */
  reaction: number;
  /** Ticks of error either way on an Impact press. */
  impactError: number;
  /** Does it bother converting landings into Chain? */
  usesChain: boolean;
  /** Which optional verbs it will reach for. */
  carve: boolean;
  tether: boolean;
  /** Chance per plan of a lapse - a few ticks of doing nothing in particular. */
  lapse: number;
}

export const BOT_PROFILES: Record<"easy" | "fair" | "hard", BotProfile> = {
  easy: { name: "easy", reaction: 12, impactError: 8, usesChain: false, carve: false, tether: false, lapse: 0.05 },
  fair: { name: "fair", reaction: 6, impactError: 4, usesChain: true, carve: true, tether: true, lapse: 0.02 },
  hard: { name: "hard", reaction: 3, impactError: 1, usesChain: true, carve: true, tether: true, lapse: 0.004 },
};

/** How far along the centre-line to aim. Roughly a second of running. */
const AIM_AHEAD = 11;
/** How far in front to test the ground for a gap or a ledge. */
const PROBE_AHEAD = 3.4;
/** How far a jump carries at speed, near enough. Past this, look for a rope. */
const JUMP_REACH = 9.5;
/**
 * Ticks a jump is in the air.
 *
 * It matters twice. The key has to stay *down* for about this long or the
 * variable-height cut turns every jump into a hop - which is what a bot that
 * taps jump for one tick gets, and why it falls in every gap. And a landing
 * spot has to be tested at `tick + AIRTIME`, not now, or a bot waiting for the
 * Drift's platform to arrive jumps at the moment it is furthest away.
 */
const AIRTIME = 22;
/** Ticks of lookahead when asking where a hazard will be. */
const HAZARD_LEAD = 9;
/** A surface this much above the feet is still landable. A jump clears 2.9. */
const REACH_UP = 2.6;
/** Nothing moving and nothing to wait for: try the other way round it. */
const BLOCKED_TICKS = 20;
/** No progress for this long and it presses R, exactly as a human would. */
const STUCK_TICKS = 150;
const STUCK_EPSILON = 0.0009;

type GapPlan = "run" | "jump" | "wait" | "tether";

const ray: RayHit = {
  dist: -1, kind: "solid", obstacleId: 0,
  x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0,
};
const pose: Pose = makePose();
const aim: Vec3 = { x: 0, y: 0, z: 0 };

export class BotController {
  readonly profile: BotProfile;
  private rand: () => number;

  private nextPlan = -Infinity;
  private aimYaw = 0;
  private aimPitch = 0.3;
  private strafe: -1 | 0 | 1 = 0;
  private hold = false;      // "wait here, something is sweeping"
  private wantCarve = false;
  private gap: GapPlan = "run";
  private lapseUntil = -Infinity;

  private bestProgress = 0;
  private stuckSince = 0;
  /** Ticks the jump key stays down, so the jump is a jump and not a hop. */
  private jumpFor = 0;
  /** How long it has been trying to move forward and failing. */
  private blocked = 0;
  private squeeze: -1 | 1 = 1;
  /** Height a swing was launched from, which is the height it has to regain. */
  private launchY = 0;
  /** The course heading, held while the aim is busy pointing at an anchor. */
  private swingYaw = 0;

  constructor(profile: BotProfile, seed: number) {
    this.profile = profile;
    this.rand = mulberry32(seed || 1);
  }

  /** Fill one input frame. Pure over the arguments plus its own seeded stream. */
  think(
    state: SimState, level: Level, phase: WorldPhase, tick: number, out: SimInput,
  ): SimInput {
    out.moveX = 0; out.moveZ = 0;
    out.jump = false; out.action = false; out.alt = false;
    out.use = false; out.respawn = false;
    if (tick >= this.nextPlan) {
      this.nextPlan = tick + this.profile.reaction;
      this.plan(state, level, phase, tick);
    }
    out.yaw = this.aimYaw;
    out.pitch = this.aimPitch;

    // ------------------------------------------------------------ stuck check
    if (state.progress > this.bestProgress + STUCK_EPSILON) {
      this.bestProgress = state.progress;
      this.stuckSince = tick;
    } else if (tick - this.stuckSince > STUCK_TICKS) {
      this.stuckSince = tick;
      out.respawn = true;
      return out;
    }

    if (tick < this.lapseUntil) { return out; }

    // Waiting is a thing you do on ground. In the air, keep the input forward:
    // stopping mid-jump throws away the air control that was going to land it.
    const waiting = (this.hold || this.gap === "wait") && state.grounded;
    out.moveX = this.strafe;
    out.moveZ = waiting ? 0 : 1;

    // ---------------------------------------------------------------- the rope
    if (this.gap === "tether" || state.anchorId !== 0) {
      out.action = this.holdTether(state, level, phase, tick);
      if (state.anchorId !== 0) {
        // Swinging: look down the course, not at the rope. Air control is
        // camera-relative, so the aim decides which way the swing is helped.
        out.yaw = this.swingYaw;
        out.pitch = 0.3;
        out.moveZ = 1;
        return out;
      }
    }

    // ------------------------------------------------------------------- jump
    //
    // Held down for the whole ascent. The jump key is variable-height, so a bot
    // that taps it for one tick clears about a metre and falls in every gap it
    // was trying to cross.
    const airborne = !state.grounded && state.coyote <= 0;
    if (this.jumpFor <= 0 && !airborne
      && (this.gap === "jump" || this.blocked > BLOCKED_TICKS)) {
      this.jumpFor = 10;
    }
    out.jump = this.jumpFor > 0;
    if (this.jumpFor > 0) { this.jumpFor -= 1; }

    // ------------------------------------------------ Impact, then Carve
    if (!state.grounded && state.vy < 0) {
      out.alt = this.shouldImpact(state, level, phase, tick);
    } else if (this.profile.carve && this.wantCarve
      && Math.hypot(state.vx, state.vz) > RUN_SPEED * CARVE_ENTRY_SPEED + 0.4) {
      out.alt = true;
    }

    return out;
  }

  // ------------------------------------------------------------------ planning

  private plan(state: SimState, level: Level, phase: WorldPhase, tick: number) {
    if (this.rand() < this.profile.lapse) {
      this.lapseUntil = tick + 4 + Math.floor(this.rand() * 8);
    }

    // Aim down the centre-line. It is the route the generator laid out, and it
    // is the same polyline the race is scored on.
    const along = pathProgress(level, state.x, state.z) * level.pathLength;
    pointOnPath(level, along + AIM_AHEAD, aim);
    const dx = aim.x - state.x, dz = aim.z - state.z;
    if (dx * dx + dz * dz > 1e-6) { this.aimYaw = Math.atan2(dx, dz); }
    this.aimPitch = 0.3;
    // Kept separately from the aim, because the aim is about to be pointed at
    // an anchor and the swing still has to know which way the course goes.
    if (state.anchorId === 0) { this.swingYaw = this.aimYaw; }

    this.strafe = 0;
    this.hold = false;
    this.wantCarve = false;

    const forwardX = Math.sin(this.aimYaw), forwardZ = Math.cos(this.aimYaw);
    const futureX = state.x + state.vx * (HAZARD_LEAD / TICK_RATE);
    const futureZ = state.z + state.vz * (HAZARD_LEAD / TICK_RATE);

    this.gap = this.readGround(state, level, phase, tick, forwardX, forwardZ);

    // A rope crossing needs the aim *on* the anchor - but only until the rope
    // is attached. Keep staring at it while swinging and air control, which is
    // camera-relative, spends the whole arc pushing back toward the anchor you
    // are trying to swing away from.
    if (this.gap === "tether" && state.anchorId === 0) {
      const anchor = this.reachableAnchor(state, level);
      if (anchor) {
        const flat = Math.hypot(anchor.x - state.x, anchor.z - state.z);
        this.aimYaw = Math.atan2(anchor.x - state.x, anchor.z - state.z);
        this.aimPitch = clamp(
          -Math.atan2(anchor.y - (state.y + SHOT_EYE), flat), PITCH_MIN, PITCH_MAX);
      } else {
        this.gap = "wait";
      }
    }

    // Trying to run and going nowhere: something solid is in the way that is
    // not a gap and not a hazard - a piston, a door, a wall on a corner. Pick a
    // side and squeeze past, and try going over it while doing so.
    const speed = Math.hypot(state.vx, state.vz);
    if (state.grounded && this.gap === "run" && speed < 1.6) {
      this.blocked += this.profile.reaction;
      if (this.blocked > BLOCKED_TICKS * 4) { this.squeeze = this.squeeze === 1 ? -1 : 1; this.blocked = BLOCKED_TICKS; }
      this.strafe = this.squeeze;
    } else {
      this.blocked = 0;
    }

    for (const ob of level.obstacles) {
      if (ob.role !== "hazard" || !isActiveAt(ob, tick + HAZARD_LEAD, phase)) { continue; }
      poseAt(ob, tick + HAZARD_LEAD, phase, pose);
      const reach = Math.max(ob.size.x, ob.size.z) / 2 + PLAYER_RADIUS;
      const hx = pose.x - futureX, hz = pose.z - futureZ;
      if (hx * hx + hz * hz > reach * reach) { continue; }
      if (Math.abs(pose.y - state.y) > 2.6) { continue; }

      // A bar at carve height is ducked under; anything else is waited out,
      // which is what a human does when a sweeper is coming the other way.
      if (this.profile.carve && pose.y < 1.4 && ob.size.y < 1.6) {
        this.wantCarve = true;
      } else if (this.gap !== "jump") {
        // Waiting only makes sense on ground. Over a gap, keep going.
        this.hold = true;
        // Edge away from it while waiting, so the next sweep has room.
        this.strafe = (hx * forwardZ - hz * forwardX) > 0 ? -1 : 1;
      }
    }
  }

  /**
   * What the ground in front is doing: run on, jump it, wait, or rope across.
   *
   * The landing test is taken at `tick + AIRTIME` rather than now, which is the
   * difference between crossing the Drift and diving into it: the platform a
   * runner lands on is the one that will be there when they arrive.
   */
  private readGround(
    state: SimState, level: Level, phase: WorldPhase, tick: number,
    fx: number, fz: number,
  ): GapPlan {
    if (this.landable(state, level, phase, tick, fx, fz, PROBE_AHEAD)) {
      // A ledge taller than the controller climbs for free still wants a jump.
      const step = this.surfaceAt(level, phase, tick, state.x + fx * PROBE_AHEAD,
        state.y, state.z + fz * PROBE_AHEAD);
      return !Number.isNaN(step) && step - state.y > STEP_HEIGHT ? "jump" : "run";
    }

    for (let d = 4; d <= JUMP_REACH; d += 1.1) {
      if (this.landable(state, level, phase, tick + AIRTIME, fx, fz, d)) { return "jump"; }
    }

    // Nothing inside a jump. Either there is a far side worth roping to, or
    // there is a platform on its way and the answer is to stand still.
    if (this.profile.tether && level.anchors.length > 0 && state.tetherCool < tick) {
      for (let d = JUMP_REACH; d <= 36; d += 2) {
        if (this.landable(state, level, phase, tick, fx, fz, d)) { return "tether"; }
      }
    }
    return "wait";
  }

  private landable(
    state: SimState, level: Level, phase: WorldPhase, tick: number,
    fx: number, fz: number, distance: number,
  ): boolean {
    const surface = this.surfaceAt(
      level, phase, tick, state.x + fx * distance, state.y, state.z + fz * distance);
    return !Number.isNaN(surface) && surface <= state.y + REACH_UP;
  }

  // -------------------------------------------------------------------- verbs

  /**
   * Height of the surface at `(x, z)`, or NaN for open air.
   *
   * Cast from above the feet rather than at them, so a platform slightly higher
   * than the runner still counts as somewhere to land - the Spiral is nothing
   * but platforms slightly higher than the runner.
   */
  private surfaceAt(
    level: Level, phase: WorldPhase, tick: number, x: number, y: number, z: number,
  ): number {
    raycastWorld(level, phase, tick, x, y + 3.4, z, 0, -1, 0, 9, ray);
    return ray.dist >= 0 ? y + 3.4 - ray.dist : NaN;
  }

  /**
   * Press Impact inside the landing window.
   *
   * The time to the ground is solved rather than watched for, the same way the
   * tether's release window is: a fall under constant gravity has a closed
   * form, and a bot that waited to *see* the ground would always be late.
   */
  private shouldImpact(
    state: SimState, level: Level, phase: WorldPhase, tick: number,
  ): boolean {
    if (!this.profile.usesChain) { return false; }
    raycastWorld(level, phase, tick, state.x, state.y + 0.1, state.z, 0, -1, 0, 24, ray);
    if (ray.dist < 0) { return false; }

    const g = GRAVITY * FALL_GRAVITY_MULT;
    const v = -state.vy;
    const drop = ray.dist;
    const seconds = (-v + Math.sqrt(v * v + 2 * g * drop)) / g;
    const ticks = seconds * TICK_RATE;

    const error = this.profile.impactError * (this.rand() * 2 - 1);
    return ticks + error <= IMPACT_WINDOW && ticks + error >= 0;
  }

  /**
   * Hold the rope, and let go at the bottom of the arc.
   *
   * The release window is a pure function of the swing, so a bot reads it the
   * same way a good player learns to: by the angle, not by the clock.
   */
  /**
   * The *furthest* anchor that is in range, in front, and above the feet.
   *
   * Furthest, not nearest, and it is the difference between crossing a chasm
   * and swinging politely in the middle of it. Rope length is fixed at the
   * distance the attach was made from, so a near anchor buys a short rope and a
   * small arc that tops out over the void. Reaching past it for the far rope is
   * what anybody swinging across a gap does, and it is what the geometry says
   * to do.
   */
  private reachableAnchor(state: SimState, level: Level) {
    let best: Level["anchors"][number] | null = null;
    let bestDistance = 0;
    const fx = Math.sin(this.aimYaw), fz = Math.cos(this.aimYaw);
    for (const a of level.anchors) {
      const dx = a.x - state.x, dz = a.z - state.z;
      if (dx * fx + dz * fz <= 0) { continue; }
      if (a.y - state.y < 2) { continue; }
      const d = Math.hypot(dx, a.y - state.y, dz);
      // A metre inside the range, so the attach does not fail on a step of
      // movement between planning it and pressing it.
      if (d > bestDistance && d < TETHER_RANGE - 1) { bestDistance = d; best = a; }
    }
    return best;
  }

  private holdTether(
    state: SimState, level: Level, phase: WorldPhase, tick: number,
  ): boolean {
    if (state.anchorId === 0) {
      // Where the swing started. A crossing has to come back up to it.
      this.launchY = state.y;
      return selectAnchor(
        level, phase, tick,
        state.x, state.y + SHOT_EYE, state.z, this.aimYaw, this.aimPitch) !== null;
    }

    const anchor = level.anchors.find((a) => a.id === state.anchorId - 1);
    if (!anchor) { return false; }

    // A slack rope is not a swing. Straight down from the anchor the release
    // maths reads "at the bottom of the arc" - which it technically is, and
    // which is worth nothing, because there is no arc yet. Wait for the rope
    // to take the weight and for the swing to have banked something.
    const reach = Math.hypot(
      state.x - anchor.x, state.y + TETHER_HAND - anchor.y, state.z - anchor.z);
    // Still plummeting is not the bottom of an arc, whatever the angle says.
    if (reach < state.ropeLen - 0.2 || state.tension < 1 || state.vy < -4) {
      return true;
    }

    // The bottom of the arc is where a swing pays the most *speed*, and it is
    // four metres below the deck it is trying to reach. To cross something, ride
    // the far half of the arc back up to the height you left from and let go
    // there - the tension becomes the height, which is the other half of what
    // the verb is for.
    if (state.y < this.launchY - 0.4) { return true; }

    const body = {
      x: state.x, y: state.y, z: state.z,
      vx: state.vx, vy: state.vy, vz: state.vz,
      grounded: false, groundId: 0, height: 1.72,
    };
    // Keep holding until letting go is worth something.
    return releaseValue(body, anchor, state.ropeLen).outcome !== "speed";
  }
}

/**
 * An input channel a bot fills.
 *
 * Structurally identical to what `this.inputs.get(sessionId)` hands back for a
 * human: iterate it to consume, and read `consumedCount` for the sequence. That
 * shared shape is the entire integration - the simulation loop cannot tell the
 * difference, which is exactly the property worth having.
 */
export class BotChannel {
  consumedCount = 0;
  private pending: SimInput[] = [];

  /**
   * Buffer one frame, through the same sanitiser the wire uses.
   *
   * Not defensive programming: it is the guarantee. A bot cannot hand the
   * simulation a value a human could not have sent, because it goes through the
   * identical coercion on the way in.
   */
  push(frame: SimInput) {
    const copy = { ...frame };
    sanitizeRaceInput(copy);
    this.pending.push(copy);
  }

  *[Symbol.iterator](): Iterator<SimInput> {
    while (this.pending.length > 0) {
      this.consumedCount += 1;
      yield this.pending.shift()!;
    }
  }
}

export function blankInput(): SimInput {
  return {
    moveX: 0, moveZ: 0, yaw: 0, pitch: 0.3,
    jump: false, action: false, alt: false, use: false, respawn: false,
  };
}
