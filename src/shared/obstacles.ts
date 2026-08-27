/**
 * Obstacle kinematics.
 *
 * Every moving part of the course is a pure function of a *world tick* plus a
 * handful of synchronised integers (`crumbleTicks`, `plateTicks`,
 * `raceStartTick`). That is the whole determinism contract: give the server and
 * a rolling-back client the same tick and the same integers and they compute the
 * same geometry, so the client can predict its own collisions against moving
 * platforms without ever being told where those platforms are.
 *
 * Ticks are fractional here - one input tick is integrated in `SUB_STEPS`
 * sub-steps, and the obstacles advance smoothly across them.
 */

import { TICK_RATE } from "./constants.js";
import { clamp, easedTriangle, lerp, triangle } from "./math.js";
import {
  CRUMBLE_DELAY_TICKS, CRUMBLE_GONE_TICKS,
  type Obstacle,
} from "./level.js";

const TAU = Math.PI * 2;

/** The mutable bits of the world that obstacle geometry depends on. */
export interface WorldPhase {
  /** Tick the start gate drops. `-1` while the race has not been armed. */
  raceStartTick: number;
  /** Per crumble slot: the tick it was first stood on, or `-1`. */
  crumbleTicks: ArrayLike<number>;
  /** Per plate: the tick its hold expires, or `-1` when cold. */
  plateTicks: ArrayLike<number>;
  /** Per plate: the tick it most recently switched on, or `-1`. */
  plateSince: ArrayLike<number>;
}

export interface Pose {
  x: number; y: number; z: number;
  /** Rotation about +Y. Solids only ever use this one. */
  yaw: number;
  /** Rotation about +Z, for pendulum heads. Hazards only. */
  roll: number;
  /** False when the obstacle is not currently part of the world. */
  active: boolean;
}

export function makePose(): Pose {
  return { x: 0, y: 0, z: 0, yaw: 0, roll: 0, active: true };
}

/** Ticks a door or the start gate takes to travel in or out of the floor. */
const DOOR_SLIDE_TICKS = 7;
/** Ticks the swing bridge takes to rotate between closed and open. */
const HINGE_SWING_TICKS = 27;

const smoothstep = (t: number) => t * t * (3 - 2 * t);

/**
 * Write the pose of `ob` at (fractional) world tick `tick` into `out`.
 *
 * Deliberately allocation-free and branch-per-kind: this runs a few thousand
 * times a second on both ends of the wire.
 */
export function poseAt(ob: Obstacle, tick: number, world: WorldPhase, out: Pose): Pose {
  const t = tick / TICK_RATE;
  out.x = ob.px; out.y = ob.py; out.z = ob.pz;
  out.yaw = 0; out.roll = 0; out.active = true;

  switch (ob.kind) {
    case "spinner":
    case "rotator": {
      out.yaw = ob.speed * t + (ob.phase ?? 0) * TAU;
      break;
    }

    case "slider": {
      const cycle = t / ob.period + (ob.phase ?? 0);
      // Solids ease into each end so riders are not yanked; hazards run at a
      // constant speed so their rhythm stays readable.
      const k = ob.role === "solid" ? easedTriangle(cycle) : triangle(cycle);
      out.x = lerp(ob.a.x, ob.b.x, k);
      out.y = lerp(ob.a.y, ob.b.y, k);
      out.z = lerp(ob.a.z, ob.b.z, k);
      break;
    }

    case "pendulum": {
      const angle = ob.amplitude * Math.sin(TAU * (t / ob.period + (ob.phase ?? 0)));
      out.x = ob.px + ob.armLength * Math.sin(angle);
      out.y = ob.py - ob.armLength * Math.cos(angle);
      out.z = ob.pz;
      out.roll = angle;
      break;
    }

    case "door": {
      const cycle = frac(t / ob.period + (ob.phase ?? 0));
      const openFor = ob.openFraction;
      const slide = DOOR_SLIDE_TICKS / (ob.period * TICK_RATE);
      let open = 0;
      if (cycle < openFor) {
        open = clamp(Math.min(cycle, openFor - cycle) / slide, 0, 1);
      }
      out.y = ob.py - smoothstep(open) * (ob.size.y + 0.35);
      break;
    }

    case "startgate": {
      const start = world.raceStartTick;
      const open = start < 0 ? 0 : clamp((tick - start) / DOOR_SLIDE_TICKS, 0, 1);
      out.y = ob.py - smoothstep(open) * (ob.size.y + 0.5);
      out.active = open < 1;
      break;
    }

    case "hinge": {
      // Two stamps, not one: `since` is when the plate went hot and drives the
      // swing-in ramp, `until` is when it expires and drives the swing-out. A
      // single stamp would restart the ramp on every tick a player stands on
      // the plate, and the bridge would never finish opening.
      const until = world.plateTicks[ob.plate] ?? -1;
      const since = world.plateSince[ob.plate] ?? -1;
      let progress = 0;
      if (until >= 0 && since >= 0) {
        progress = tick < until
          ? clamp((tick - since) / HINGE_SWING_TICKS, 0, 1)
          : clamp(1 - (tick - until) / HINGE_SWING_TICKS, 0, 1);
      }
      const yaw = lerp(ob.closedYaw, ob.openYaw, smoothstep(progress));
      out.yaw = yaw;
      // The arm pivots at (px, pz) and the slab hangs `offsetZ` along it.
      out.x = ob.px - Math.sin(yaw) * ob.offsetZ;
      out.z = ob.pz + Math.cos(yaw) * ob.offsetZ;
      out.y = ob.py;
      break;
    }

    case "crumble": {
      const trig = world.crumbleTicks[ob.slot] ?? -1;
      if (trig < 0) { break; }
      const age = tick - trig;
      if (age < CRUMBLE_DELAY_TICKS) {
        // Still solid, but shivering - the tell that it is about to go.
        const shake = (age / CRUMBLE_DELAY_TICKS) ** 2 * 0.09;
        out.x += Math.sin(age * 2.9) * shake;
        out.z += Math.sin(age * 3.7 + 1.1) * shake;
      } else if (age < CRUMBLE_DELAY_TICKS + CRUMBLE_GONE_TICKS) {
        const fallen = age - CRUMBLE_DELAY_TICKS;
        out.active = false;
        out.y -= 0.5 * 30 * (fallen / TICK_RATE) ** 2;
      }
      break;
    }
  }
  return out;
}

const frac = (v: number) => v - Math.floor(v);

/** Cheap "is this obstacle collidable right now" test, without a full pose. */
export function isActiveAt(ob: Obstacle, tick: number, world: WorldPhase): boolean {
  switch (ob.kind) {
    case "startgate":
      return world.raceStartTick < 0 || tick < world.raceStartTick + DOOR_SLIDE_TICKS;
    case "crumble": {
      const trig = world.crumbleTicks[ob.slot] ?? -1;
      if (trig < 0) { return true; }
      const age = tick - trig;
      return age < CRUMBLE_DELAY_TICKS || age >= CRUMBLE_DELAY_TICKS + CRUMBLE_GONE_TICKS;
    }
    default:
      return true;
  }
}

/**
 * How far a door has dropped, 0..1 - the renderer wants this for its own
 * highlight, and the HUD uses it to warn about a closing door ahead.
 */
export function doorOpenness(ob: Obstacle, tick: number): number {
  if (ob.kind !== "door") { return 1; }
  const t = tick / TICK_RATE;
  const cycle = frac(t / ob.period + (ob.phase ?? 0));
  if (cycle >= ob.openFraction) { return 0; }
  const slide = DOOR_SLIDE_TICKS / (ob.period * TICK_RATE);
  return smoothstep(clamp(Math.min(cycle, ob.openFraction - cycle) / slide, 0, 1));
}
