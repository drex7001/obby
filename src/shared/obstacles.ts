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

import {
  BREAKER_DISABLE_TICKS, BREAKER_DROP_TICKS, PICKUP_RESPAWN_TICKS,
  SHELL_FLIGHT_TICKS, SHELL_GRAVITY, TICK_RATE,
} from "./constants.js";
import { clamp, easedTriangle, lerp, triangle } from "./math.js";
import {
  CRUMBLE_DELAY_TICKS, CRUMBLE_GONE_TICKS,
  type Obstacle, type Pickup,
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
  /** Per breaker slot: the tick it was shot, or `-1`. Stage 6. */
  breakerTicks: ArrayLike<number>;
  /** Per pickup slot: the tick it was last taken, or `-1`. Stage 6. */
  pickupTicks: ArrayLike<number>;
  /** Per shootable-shell slot: the tick a shell was shot down, or `-1`. */
  shellTicks: ArrayLike<number>;
}

/**
 * Which firing cycle a turret is in at `tick`, and how far into it.
 *
 * Split out because three separate things need the same answer: where the shell
 * is, whether this cycle's shell was shot down, and whether the muzzle is about
 * to flash. All of them are pure functions of the tick.
 */
function turretCycle(ob: Obstacle, tick: number): { index: number; ticks: number } {
  const period = ob.period * TICK_RATE;
  const offset = tick + (ob.phase ?? 0) * period;
  const index = Math.floor(offset / period);
  return { index, ticks: offset - index * period };
}

/** Was the shell of the cycle covering `tick` shot out of the air? */
export function shellDown(ob: Obstacle, tick: number, world: WorldPhase): boolean {
  if (ob.shell === undefined) { return false; }
  const stamp = world.shellTicks[ob.shell] ?? -1;
  if (stamp < 0 || stamp > tick) { return false; }
  return turretCycle(ob, stamp).index === turretCycle(ob, tick).index;
}

/** Has the breaker in `slot` been shot, as of `tick`? */
export function breakerBroken(world: WorldPhase, slot: number | undefined, tick: number): boolean {
  if (slot === undefined) { return false; }
  const stamp = world.breakerTicks[slot] ?? -1;
  return stamp >= 0 && tick >= stamp;
}

/**
 * Is a pickup on the course right now?
 *
 * A taken pickup comes back twenty seconds later, so the runner in fifth place
 * still has a gun to race for.
 */
export function pickupAvailable(p: Pickup, tick: number, world: WorldPhase): boolean {
  const taken = world.pickupTicks[p.slot] ?? -1;
  return taken < 0 || tick >= taken + PICKUP_RESPAWN_TICKS;
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
  // The heading the generator baked in when it placed this obstacle on a bent
  // section. Every kind adds it: for a spinner it is a phase offset, but for a
  // door, a pusher or a bridge it is the difference between the box lying along
  // the track and lying across it.
  const base = ob.baseYaw ?? 0;
  out.x = ob.px; out.y = ob.py; out.z = ob.pz;
  out.yaw = base; out.roll = 0; out.active = true;

  switch (ob.kind) {
    case "spinner":
    case "rotator": {
      out.yaw = base + ob.speed * t + (ob.phase ?? 0) * TAU;
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
      // A searching sweep laid over the travel. It changes nothing about where
      // the box is - a Hunter is a slider with better art - but it is the whole
      // reason one reads as alive rather than as machinery.
      if (ob.scan) {
        out.yaw = base + ob.scan * Math.sin(TAU * (t / (ob.scanPeriod ?? 2.2)));
      }
      break;
    }

    case "pendulum": {
      const angle = ob.amplitude * Math.sin(TAU * (t / ob.period + (ob.phase ?? 0)));
      // The head swings in the pivot's local XY plane; `base` is where that
      // plane faces. The renderer composes roll inside yaw and `hazardHit`
      // undoes them in that same order, so the two agree.
      const reach = ob.armLength * Math.sin(angle);
      out.x = ob.px + reach * Math.cos(base);
      out.y = ob.py - ob.armLength * Math.cos(angle);
      out.z = ob.pz + reach * Math.sin(base);
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
      const yaw = base + lerp(ob.closedYaw, ob.openYaw, smoothstep(progress));
      out.yaw = yaw;
      // The arm pivots at (px, pz) and the slab hangs `offsetZ` along it.
      out.x = ob.px - Math.sin(yaw) * ob.offsetZ;
      out.z = ob.pz + Math.cos(yaw) * ob.offsetZ;
      out.y = ob.py;
      break;
    }

    case "turret": {
      // A shell is a parabola from a fixed muzzle on a fixed cycle - position
      // is f(fireTick, tick) and nothing else, so it costs no bytes at all.
      const { ticks } = turretCycle(ob, tick);
      const s = ticks / TICK_RATE;
      const speed = ob.muzzleSpeed ?? 22;
      const pitch = ob.muzzlePitch ?? 0.3;
      const flat = speed * Math.cos(pitch);
      out.x = ob.px + Math.sin(base) * flat * s;
      out.z = ob.pz + Math.cos(base) * flat * s;
      out.y = ob.py + speed * Math.sin(pitch) * s - 0.5 * SHELL_GRAVITY * s * s;
      out.yaw = base;
      out.active = ticks < SHELL_FLIGHT_TICKS && !shellDown(ob, tick, world);
      break;
    }

    case "sentry": {
      // A beam swept about its pivot. The box is the beam, so the pivot end is
      // half its length back along the sweep.
      const angle = (ob.amplitude ?? 0.8) * Math.sin(TAU * (t / ob.period + (ob.phase ?? 0)));
      const yaw = base + angle;
      const reach = (ob.armLength ?? ob.size.z / 2);
      out.x = ob.px + Math.sin(yaw) * reach;
      out.z = ob.pz + Math.cos(yaw) * reach;
      out.yaw = yaw;
      break;
    }

    case "swarm": {
      // A hazard field armed by a plate. Class B and no new machinery: it reads
      // exactly the stamp the swing bridge does.
      const until = world.plateTicks[ob.plate] ?? -1;
      out.active = until >= 0 && tick < until;
      break;
    }

    case "nest": {
      // Static. What it emits is the room's business; the nest itself is a
      // solid with a spawn schedule bolted to it.
      break;
    }

    case "collapse": {
      // A gantry that drops into a bridge once its support is shot. It is
      // *added* geometry: nothing about the course is removed, so a runner who
      // never picks the gun up sees exactly the course they always did.
      const stamp = world.breakerTicks[ob.breaker] ?? -1;
      if (stamp < 0 || tick < stamp) { out.active = false; break; }
      const drop = clamp((tick - stamp) / BREAKER_DROP_TICKS, 0, 1);
      out.y = ob.py + (ob.dropY ?? 0) * (1 - smoothstep(drop));
      break;
    }

    case "seal": {
      // A locked barrier. Shooting it opens the route for the rest of the
      // round - for everyone, which is the whole point of a public act.
      const stamp = world.breakerTicks[ob.breaker] ?? -1;
      const open = stamp < 0 || tick < stamp
        ? 0
        : clamp((tick - stamp) / DOOR_SLIDE_TICKS, 0, 1);
      out.y = ob.py - smoothstep(open) * (ob.size.y + 0.5);
      out.active = open < 1;
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
  // A hazard tagged with a breaker goes inert for five seconds when it is shot.
  // A window, never a deletion - it is what makes shooting generous rather than
  // a way to opt out of the obstacle course.
  if (ob.role === "hazard" && ob.breaker !== undefined) {
    const stamp = world.breakerTicks[ob.breaker] ?? -1;
    if (stamp >= 0 && tick >= stamp && tick < stamp + BREAKER_DISABLE_TICKS) { return false; }
  }
  switch (ob.kind) {
    case "turret":
      return turretCycle(ob, tick).ticks < SHELL_FLIGHT_TICKS
        && !shellDown(ob, tick, world);
    case "swarm": {
      const until = world.plateTicks[ob.plate] ?? -1;
      return until >= 0 && tick < until;
    }
    case "collapse":
      return breakerBroken(world, ob.breaker, tick);
    case "seal":
      return !breakerBroken(world, ob.breaker, tick)
        || tick < (world.breakerTicks[ob.breaker] ?? -1) + DOOR_SLIDE_TICKS;
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
