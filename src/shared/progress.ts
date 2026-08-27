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

import type { Level } from "./level.js";

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

/** Progress value banked by reaching checkpoint `index` (-1 for none). */
export function checkpointProgress(level: Level, index: number): number {
  if (index < 0 || index >= level.checkpoints.length) { return 0; }
  const cp = level.checkpoints[index];
  return pathProgress(level, cp.spawn.x, cp.spawn.z);
}
