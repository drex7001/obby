/**
 * The tether: targeting, the swing constraint, and the release.
 *
 * Class A throughout. Anchors are level data rebuilt from the seed, targeting
 * is the shared world raycast, and both the constraint and the tension
 * accumulator resolve inside `stepPlayer()`. Nothing crosses the wire but the
 * `action` bit and the handful of fields on `SimState` - a tether is closer to
 * a jump than to a projectile.
 *
 * The elasticity is deliberately *not* in the constraint. The rope holds you
 * rigidly at its length; what stretches is the tension accumulator, and that is
 * spent on release. Separating them is what keeps this deterministic: a spring
 * needs tuning that varies with `dt` and drifts under sub-stepping, whereas a
 * hard positional correction is stable at any sub-step count.
 *
 * v1 is static anchors only, which removes an entire risk class. An anchor that
 * moved would have to be stored as `(obstacleId, local offset)` and recomputed
 * from `poseAt()` every sub-step; store it as a world point and the two ends
 * disagree about where the rope ends the moment the obstacle moves - and it
 * would read as a physics bug rather than a netcode one.
 */

import {
  TETHER_CONE, TETHER_HAND, TETHER_RANGE, TETHER_RELEASE_WINDOW,
  TETHER_TENSION_FLOOR, TETHER_TENSION_MAX, TICK_RATE,
} from "./constants.js";
import { raycastWorld, type Body, type RayHit } from "./collision.js";
import type { Anchor, Level } from "./level.js";
import type { WorldPhase } from "./obstacles.js";
import { clamp } from "./math.js";
import { aimDirection } from "./salvo.js";

/** Scratch. Targeting runs once per press and once per client frame. */
const sight: RayHit = {
  dist: -1, kind: "solid", obstacleId: 0,
  x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0,
};
const dir = { x: 0, y: 0, z: 0 };

/**
 * The anchor a runner at `(ox, oy, oz)` looking along `(yaw, pitch)` would take.
 *
 * Nearest to the aim ray inside the cone, ties broken by anchor id, occluded
 * anchors excluded. Every input is either level data or a simulated field, so
 * the same ray at the same tick picks the same anchor on the first prediction,
 * on every rollback replay, and on the server.
 */
export function selectAnchor(
  level: Level, phase: WorldPhase, tick: number,
  ox: number, oy: number, oz: number, yaw: number, pitch: number,
): Anchor | null {
  aimDirection(yaw, pitch, dir);

  let best: Anchor | null = null;
  let bestOffset = Infinity;
  for (const anchor of level.anchors) {
    const dx = anchor.x - ox, dy = anchor.y - oy, dz = anchor.z - oz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > TETHER_RANGE || dist < 1e-6) { continue; }

    const cosine = (dx * dir.x + dy * dir.y + dz * dir.z) / dist;
    if (cosine <= 0) { continue; }
    const angle = Math.acos(clamp(cosine, -1, 1));
    if (angle > TETHER_CONE) { continue; }

    // Perpendicular distance from the aim ray - "nearest to the ray", not
    // "nearest to the runner", so a distant anchor you are looking straight at
    // beats a near one at the edge of the cone.
    const offset = dist * Math.sin(angle);
    if (offset > bestOffset || (offset === bestOffset && best !== null && anchor.id >= best.id)) {
      continue;
    }

    raycastWorld(level, phase, tick, ox, oy, oz, dx / dist, dy / dist, dz / dist, dist, sight);
    if (sight.dist >= 0 && sight.dist < dist - 0.5) { continue; }

    best = anchor;
    bestOffset = offset;
  }
  return best;
}

export function findAnchor(level: Level, id: number): Anchor | undefined {
  const list = level.anchors;
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) { return list[i]; }
  }
  return undefined;
}

/** Rope length from a runner's hand to an anchor. */
export function ropeLength(anchor: Anchor, x: number, y: number, z: number): number {
  return Math.hypot(x - anchor.x, y + TETHER_HAND - anchor.y, z - anchor.z);
}

/**
 * Hold the body at or inside the rope length, and bank tension for the release.
 *
 * Only *outward* radial velocity is removed, which is what makes it feel like a
 * rope rather than a leash: you can still fall toward the anchor, and you keep
 * every unit of the tangential speed the swing is actually made of.
 *
 * Called after gravity and before the collision resolve, so the resolve always
 * gets the last word and the constraint can never seat a player inside geometry.
 */
export function tetherConstraint(
  body: Body, anchor: Anchor, ropeLen: number, tension: number, dt: number,
): number {
  let dx = body.x - anchor.x;
  let dy = body.y + TETHER_HAND - anchor.y;
  let dz = body.z - anchor.z;
  let len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 1e-6) { return tension; }

  // A slack rope is not a swing. Tension is what the *arc* banks, so a runner
  // falling freely inside the rope's length banks nothing - which also stops a
  // long drop reading as a perfectly timed release the instant it goes taut.
  const taut = len > ropeLen;
  if (taut) {
    const nx = dx / len, ny = dy / len, nz = dz / len;
    const pull = len - ropeLen;
    body.x -= nx * pull;
    body.y -= ny * pull;
    body.z -= nz * pull;
    const radial = body.vx * nx + body.vy * ny + body.vz * nz;
    if (radial > 0) {
      body.vx -= nx * radial;
      body.vy -= ny * radial;
      body.vz -= nz * radial;
    }
    dx = nx * ropeLen; dy = ny * ropeLen; dz = nz * ropeLen;
    len = ropeLen;
  }

  // Tension is the tangential speed above a floor, integrated over time. A
  // tether cannot create speed you did not bring: it converts and amplifies.
  const nx = dx / len, ny = dy / len, nz = dz / len;
  const radial = body.vx * nx + body.vy * ny + body.vz * nz;
  const tangential = Math.hypot(
    body.vx - nx * radial, body.vy - ny * radial, body.vz - nz * radial,
  );
  const gained = taut ? Math.max(0, tangential - TETHER_TENSION_FLOOR) * dt : 0;
  return Math.min(TETHER_TENSION_MAX, tension + gained);
}

export type TetherRelease = "speed" | "height" | "nothing";

export interface ReleaseInfo {
  outcome: TetherRelease;
  /** Estimated ticks between now and the bottom of the arc. */
  ticksToBottom: number;
  /** Horizontal swing tangent, normalised. Zero-length when there is no swing. */
  tx: number; tz: number;
}

const release: ReleaseInfo = { outcome: "nothing", ticksToBottom: 0, tx: 0, tz: 0 };

/**
 * What letting go right now is worth.
 *
 * The arc bottom is found without integrating anything forward: near the bottom
 * a swing is a pendulum, so the angle from straight down divided by the angular
 * speed *is* the time remaining, in closed form. That makes "within five ticks
 * of the bottom" a pure function of the current state - identical on both ends,
 * at any latency, on every replay - rather than a guess about the future.
 */
export function releaseValue(body: Body, anchor: Anchor, ropeLen: number): ReleaseInfo {
  const dx = body.x - anchor.x;
  const dy = body.y + TETHER_HAND - anchor.y;
  const dz = body.z - anchor.z;
  const len = Math.hypot(dx, dy, dz) || 1;
  const nx = dx / len, ny = dy / len, nz = dz / len;

  const radial = body.vx * nx + body.vy * ny + body.vz * nz;
  const tx = body.vx - nx * radial;
  const ty = body.vy - ny * radial;
  const tz = body.vz - nz * radial;
  const tangential = Math.hypot(tx, ty, tz);

  // Angle between the rope and straight down, and how fast that angle closes.
  const theta = Math.acos(clamp(-ny, -1, 1));
  const omega = ropeLen > 1e-6 ? tangential / ropeLen : 0;
  const ticksToBottom = omega > 1e-6 ? (theta / omega) * TICK_RATE : Infinity;

  const flat = Math.hypot(tx, tz);
  release.tx = flat > 1e-6 ? tx / flat : 0;
  release.tz = flat > 1e-6 ? tz / flat : 0;
  release.ticksToBottom = ticksToBottom;
  // The speed payout needs real tangential speed behind it, not merely a
  // favourable angle. Without that clause, hanging motionless directly below an
  // anchor and letting go reads as a perfect release and pays a Chain point for
  // nothing - which is exactly the "creates speed you did not bring" failure
  // the tension floor exists to prevent.
  release.outcome = tangential >= TETHER_TENSION_FLOOR && ticksToBottom <= TETHER_RELEASE_WINDOW
    ? "speed"
    : body.vy > 0 ? "height" : "nothing";
  return release;
}
