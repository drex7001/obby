/**
 * Race progress scoring.
 *
 * Position in the race is deliberately NOT "distance to the finish line": on a
 * course that doubles back and forks, straight-line distance ranks a player who
 * fell into the void below the finish ahead of one who is legitimately halfway.
 * Progress is arc length along the course's centre-line instead, floored by the
 * checkpoint the player has actually banked - so falling never costs you places,
 * and cutting a corner never gains you any.
 */

import type { Level, Vec3 } from "./level.js";

/**
 * Fraction of the course completed at (x, z), as arc length along the
 * centre-line polyline. Always within 0..1.
 */
export function pathProgress(level: Level, x: number, z: number): number {
  const path = level.path;
  let best = Infinity;
  let bestDist = 0;

  for (let i = 1; i < path.length; i++) {
    const ax = path[i - 1].x, az = path[i - 1].z;
    const bx = path[i].x, bz = path[i].z;
    const ex = bx - ax, ez = bz - az;
    const len2 = ex * ex + ez * ez;
    let t = len2 > 0 ? ((x - ax) * ex + (z - az) * ez) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + ex * t, pz = az + ez * t;
    const d = (x - px) * (x - px) + (z - pz) * (z - pz);
    if (d < best) {
      best = d;
      bestDist = level.pathCum[i - 1] + Math.sqrt(len2) * t;
    }
  }
  const p = bestDist / level.pathLength;
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

/**
 * The point `distance` units along the centre-line.
 *
 * The centre-line doubles as a navmesh: it is already the thing race position
 * is scored on, it already turns with the course, and a runner following it is
 * by construction taking the route the generator laid out.
 */
export function pointOnPath(level: Level, distance: number, out: Vec3): Vec3 {
  const path = level.path;
  const cum = level.pathCum;
  const want = distance < 0 ? 0 : distance > level.pathLength ? level.pathLength : distance;

  let i = 1;
  while (i < cum.length - 1 && cum[i] < want) { i++; }
  const span = cum[i] - cum[i - 1];
  const t = span > 1e-9 ? (want - cum[i - 1]) / span : 0;
  out.x = path[i - 1].x + (path[i].x - path[i - 1].x) * t;
  out.y = path[i - 1].y + (path[i].y - path[i - 1].y) * t;
  out.z = path[i - 1].z + (path[i].z - path[i - 1].z) * t;
  return out;
}

/** Progress value banked by reaching checkpoint `index` (-1 for none). */
export function checkpointProgress(level: Level, index: number): number {
  if (index < 0 || index >= level.checkpoints.length) { return 0; }
  const cp = level.checkpoints[index];
  return pathProgress(level, cp.spawn.x, cp.spawn.z);
}
