/**
 * Shot resolution.
 *
 * The whole feature is Class A: a shot is a pure function of the level, the
 * synchronised breaker stamps, a fractional world tick, and the shooter's own
 * simulated position and aim. There is no player-position rewind anywhere in
 * it, because nothing is ever aimed at a player - which is also why the assist
 * cone can be as generous as it is. Assist against world geometry is a
 * usability feature; assist against people would be a fairness argument.
 *
 * Everything here is allocation-free: it runs inside the shared step, which the
 * client replays on every rollback.
 */

import { ASSIST_CONE, POD_SHARE_TICKS, SHOT_RANGE } from "./constants.js";
import { raycastWorld, type RayHit } from "./collision.js";
import { enemyPoseAt, enemyShape, type EnemyView } from "./enemies.js";
import type { BreakerEffect, Level } from "./level.js";
import { makePose, poseAt, type Pose, type WorldPhase } from "./obstacles.js";

export interface ShotResult {
  /** Breaker slot that was hit, or -1 for a clean miss. */
  slot: number;
  /** The breaker's id, for presentation only. */
  breakerId: number;
  effect: BreakerEffect | null;
  /** Turret shell slot shot out of the air, or -1. */
  shellSlot: number;
  /** Enemy id hit, or 0. */
  enemyId: number;
  /** Where the shot ended - the impact point, or the end of its range. */
  x: number; y: number; z: number;
  dist: number;
}

export function makeShotResult(): ShotResult {
  return {
    slot: -1, breakerId: 0, effect: null, shellSlot: -1, enemyId: 0,
    x: 0, y: 0, z: 0, dist: 0,
  };
}

/** Scratch for the occlusion query. Module-scoped: this is on the hot path. */
const wall: RayHit = {
  dist: -1, kind: "solid", obstacleId: 0,
  x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0,
};

/**
 * Unit aim vector for a camera yaw and pitch.
 *
 * The same convention the follow camera uses: forward is `(sin yaw, cos yaw)`
 * on the ground plane, and a positive pitch looks down.
 */
export function aimDirection(yaw: number, pitch: number, out: { x: number; y: number; z: number }) {
  const cosP = Math.cos(pitch);
  out.x = Math.sin(yaw) * cosP;
  out.y = -Math.sin(pitch);
  out.z = Math.cos(yaw) * cosP;
  return out;
}

const dir = { x: 0, y: 0, z: 0 };
const shotPose: Pose = makePose();

/**
 * Is a point inside the assist cone, unoccluded, and nearer than the best so
 * far? Returns its distance, or -1.
 *
 * Shared by all three target classes so a breaker, a shell and an enemy are
 * judged by exactly the same rule - and so the nearest of the three wins,
 * whichever kind it happens to be.
 */
function candidate(
  ox: number, oy: number, oz: number,
  tx: number, ty: number, tz: number,
  reach: number, blocked: number, best: number,
): number {
  const dx = tx - ox, dy = ty - oy, dz = tz - oz;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist > SHOT_RANGE || dist < 1e-6 || dist >= best) { return -1; }

  // The target's own silhouette widens the cone, so a dead-centre shot at a big
  // pod always lands even at point-blank range where 4 degrees is thin.
  const cone = ASSIST_CONE + Math.atan2(reach, dist);
  const cosine = (dx * dir.x + dy * dir.y + dz * dir.z) / dist;
  if (cosine <= 0 || cosine < Math.cos(cone)) { return -1; }

  // Flush against a wall is a hit; behind it is not. The half-extent is the
  // whole tolerance.
  return dist - reach > blocked ? -1 : dist;
}

/**
 * Resolve one shot from `(ox, oy, oz)` along the aim implied by yaw and pitch.
 *
 * The world ray is what stops the shot; the assist cone is then applied only to
 * breakers that are *closer* than whatever the ray hit. That ordering is what
 * makes assist forgiving without letting a shot pass through a wall to reach a
 * target behind it.
 */
export function resolveShot(
  level: Level, phase: WorldPhase, tick: number,
  ox: number, oy: number, oz: number,
  yaw: number, pitch: number,
  out: ShotResult,
  enemies: readonly EnemyView[] = [],
): ShotResult {
  aimDirection(yaw, pitch, dir);

  raycastWorld(level, phase, tick, ox, oy, oz, dir.x, dir.y, dir.z, SHOT_RANGE, wall);
  const blocked = wall.dist >= 0 ? wall.dist : SHOT_RANGE;

  out.slot = -1;
  out.breakerId = 0;
  out.effect = null;
  out.shellSlot = -1;
  out.enemyId = 0;
  out.dist = blocked;
  out.x = ox + dir.x * blocked;
  out.y = oy + dir.y * blocked;
  out.z = oz + dir.z * blocked;

  let best = SHOT_RANGE + 1;
  const take = (x: number, y: number, z: number, dist: number) => {
    best = dist;
    out.slot = -1;
    out.breakerId = 0;
    out.effect = null;
    out.shellSlot = -1;
    out.enemyId = 0;
    out.dist = dist;
    out.x = x; out.y = y; out.z = z;
  };

  for (const b of level.breakers) {
    // A coin pod stays targetable for five ticks after the first hit, so two
    // runners who shoot it together both get paid. Anti-frustration beats
    // strict arbitration when the whole stake is three coins - and "I hit it
    // first" is the only fairness dispute this feature can generate.
    const stamp = phase.breakerTicks[b.slot] ?? -1;
    const share = b.effect === "pod" ? POD_SHARE_TICKS : 0;
    if (stamp >= 0 && tick >= stamp + share) { continue; }

    const reach = Math.max(b.hx, b.hy, b.hz);
    const dist = candidate(ox, oy, oz, b.x, b.y, b.z, reach, blocked, best);
    if (dist < 0) { continue; }
    take(b.x, b.y, b.z, dist);
    out.slot = b.slot;
    out.breakerId = b.id;
    out.effect = b.effect;
  }

  // Turret shells. Defence and offence turn out to be the same verb at
  // different moments: a shell in flight is a pure function of tick, so
  // shooting one down is a timing window, in the same design language as
  // Impact and the tether release.
  for (const ob of level.obstacles) {
    if (ob.kind !== "turret" || ob.shell === undefined) { continue; }
    poseAt(ob, tick, phase, shotPose);
    if (!shotPose.active) { continue; }
    const reach = Math.max(ob.size.x, ob.size.y, ob.size.z) / 2;
    const dist = candidate(
      ox, oy, oz, shotPose.x, shotPose.y, shotPose.z, reach, blocked, best);
    if (dist < 0) { continue; }
    take(shotPose.x, shotPose.y, shotPose.z, dist);
    out.shellSlot = ob.shell;
  }

  // Enemies. No lag compensation anywhere in this: an enemy's position is
  // derivable from its committed arc, so the shooter and the server evaluate
  // the same function at the same tick and cannot disagree.
  for (const e of enemies) {
    if (!e.alive) { continue; }
    enemyPoseAt(e, tick, shotPose);
    const shape = enemyShape(e.kind);
    const cy = shotPose.y + shape.height * 0.55;
    const dist = candidate(
      ox, oy, oz, shotPose.x, cy, shotPose.z, shape.radius, blocked, best);
    if (dist < 0) { continue; }
    take(shotPose.x, cy, shotPose.z, dist);
    out.enemyId = e.id;
  }

  return out;
}
