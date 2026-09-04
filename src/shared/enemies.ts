/**
 * Enemies, and the committed paths they move on.
 *
 * The design problem an enemy poses is not "was my shot a hit" - that one is
 * easy - it is **collision under prediction**. A client predicts its own body
 * past what the server has acknowledged and replays it on every rollback, so it
 * needs an enemy's position at ticks the server has not simulated yet. Lag
 * compensation reconstructs the past; prediction needs the future.
 *
 * So an enemy does not publish a position. It publishes an **arc**: a start
 * point, a heading, a speed, a turn rate, and the tick window the arc is valid
 * for. Both ends compute the pose from it with the same allocation-free pure
 * function, at a fractional tick, exactly the way `poseAt()` works for the rest
 * of the course. A position that can be recomputed never has to be remembered.
 *
 * The rule that makes it safe: **a commit is always published to take effect in
 * the future**, by more than a worst-case round trip. Nobody ever evaluates a
 * path they have not received. It is the same principle as the swing bridge's
 * 0.9 s travel - a late stamp cannot teleport geometry into a player.
 *
 * That lead caps how fast an enemy can react at about half a second, which on
 * screen reads as something heavy that telegraphs and follows through. When a
 * technical limit and a design requirement point the same way, the design is
 * usually right.
 */

import { TICK_RATE } from "./constants.js";
import type { Pose } from "./obstacles.js";

export type EnemyKind = 0 | 1 | 2;
export const SHAMBLER: EnemyKind = 0;
export const LURCHER: EnemyKind = 1;
export const BULWARK: EnemyKind = 2;

export type EnemyAction = 0 | 1 | 2 | 3 | 4;
export const IDLE: EnemyAction = 0;
export const WALK: EnemyAction = 1;
export const WINDUP: EnemyAction = 2;
export const LUNGE: EnemyAction = 3;
export const RECOVER: EnemyAction = 4;

export interface EnemyShape {
  radius: number;
  height: number;
  /** A solid enemy is a surface: it can be stood on and walked into. */
  solid: boolean;
  /** Shots to put it down. */
  hp: number;
  knock: number;
  style: string;
}

/**
 * The two tiers, as data.
 *
 * A hazard enemy is **never** a surface. That is not a simplification, it is
 * the safety property: a wrong guess about a soft impulse costs centimetres and
 * heals, whereas a wrong guess about a surface costs metres and snaps. Only the
 * Bulwark is solid, and only because its whole point is to be in the way.
 */
export const ENEMY_SHAPES: Record<EnemyKind, EnemyShape> = {
  0: { radius: 0.62, height: 1.9, solid: false, hp: 1, knock: 9, style: "shambler" },
  1: { radius: 0.58, height: 1.8, solid: false, hp: 1, knock: 13, style: "lurcher" },
  2: { radius: 1.15, height: 2.4, solid: true, hp: 3, knock: 6, style: "bulwark" },
};

/** Everything the shared step and the renderer need from one enemy. */
export interface EnemyView {
  id: number;
  kind: number;
  alive: boolean;
  action: number;
  /** Tick window the committed arc is valid for. */
  fromTick: number;
  toTick: number;
  /** Start of the arc. */
  x0: number; y0: number; z0: number;
  /** Initial heading as a unit vector, in the simulation's (sin, cos) frame. */
  dx: number; dz: number;
  speed: number;
  /** Turn rate along the arc, rad/s. Zero is a straight line. */
  turn: number;
}

/**
 * Pose of an enemy at a (fractional) world tick.
 *
 * Before `fromTick` it holds the start of the arc; after `toTick` it holds the
 * end, until the next commit lands. Both clamps matter: the first is what makes
 * a commit safe to publish early, and the second is what makes a *late* commit
 * degrade into a hold rather than a teleport.
 */
export function enemyPoseAt(e: EnemyView, tick: number, out: Pose): Pose {
  const span = Math.max(0, e.toTick - e.fromTick);
  const held = tick < e.fromTick ? 0 : Math.min(tick - e.fromTick, span);
  const s = held / TICK_RATE;

  // Heading is carried as a vector so a commit never has to normalise an angle
  // across the wire, where -pi and +pi are the same heading and different bytes.
  const h0 = Math.atan2(e.dx, e.dz);

  if (Math.abs(e.turn) < 1e-6) {
    out.x = e.x0 + e.dx * e.speed * s;
    out.z = e.z0 + e.dz * e.speed * s;
    out.yaw = h0;
  } else {
    // Constant speed on a constant turn rate is a circular arc, in closed form.
    // No control points, no integration, and identical on both ends.
    const r = e.speed / e.turn;
    const h = h0 + e.turn * s;
    out.x = e.x0 + r * (Math.cos(h0) - Math.cos(h));
    out.z = e.z0 + r * (Math.sin(h) - Math.sin(h0));
    out.yaw = h;
  }
  out.y = e.y0;
  out.roll = 0;
  out.active = e.alive;
  return out;
}

/** True when this enemy is a surface rather than a soft force. */
export const enemyIsSolid = (kind: number) => ENEMY_SHAPES[kind as EnemyKind]?.solid === true;

export const enemyShape = (kind: number): EnemyShape =>
  ENEMY_SHAPES[kind as EnemyKind] ?? ENEMY_SHAPES[0];
