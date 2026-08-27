/**
 * Kinematic capsule-vs-world collision.
 *
 * No physics engine: a character controller with an axis-separated resolve
 * (vertical first, then horizontal) is both easier to keep deterministic and
 * much easier to make *feel* right than a rigid-body solver. The vertical pass
 * owns landing and head-bonks; the horizontal pass owns walls and step-ups.
 * Keeping them apart is what stops players from ramping up the side of a wall.
 *
 * Every routine here is allocation-free and reads nothing outside its
 * arguments - it runs inside the shared step, which the client replays on every
 * rollback.
 */

import { PLAYER_HEIGHT, PLAYER_RADIUS } from "./constants.js";
import type { Ramp, SolidBox, Volume } from "./level.js";
import type { Pose } from "./obstacles.js";

/** Ledges no taller than this are climbed rather than blocked. */
export const STEP_HEIGHT = 0.46;
/** Slack at a contact plane, to keep exact-rest cases off the knife edge. */
const CONTACT_EPS = 1e-3;
/** Scratch, module-scoped: these functions are on the hot path. */
const tmp = { x: 0, y: 0, z: 0 };

export interface Body {
  x: number; y: number; z: number;   // feet position
  vx: number; vy: number; vz: number;
  grounded: boolean;
  /** Obstacle id the body is standing on, or 0 for static ground / nothing. */
  groundId: number;
}

/** A box in the form the resolver wants: centre, half-extents, yaw. */
export interface BoxLike {
  x: number; y: number; z: number;
  hx: number; hy: number; hz: number;
  yaw: number;
}

/** Rotate a world offset into a yaw-rotated box's local frame. */
function toLocal(dx: number, dz: number, yaw: number) {
  if (yaw === 0) { tmp.x = dx; tmp.z = dz; return tmp; }
  const c = Math.cos(yaw), s = Math.sin(yaw);
  tmp.x = dx * c + dz * s;
  tmp.z = -dx * s + dz * c;
  return tmp;
}

/** Rotate a local offset back out into world space. */
function toWorld(lx: number, lz: number, yaw: number) {
  if (yaw === 0) { tmp.x = lx; tmp.z = lz; return tmp; }
  const c = Math.cos(yaw), s = Math.sin(yaw);
  tmp.x = lx * c - lz * s;
  tmp.z = lx * s + lz * c;
  return tmp;
}

// ---------------------------------------------------------------------------
// Vertical pass
// ---------------------------------------------------------------------------

/**
 * Resolve the body against one box along Y only.
 *
 * Returns `1` if the body was pushed up (it landed), `-1` if pushed down (it hit
 * its head), `0` if there was no vertical contact.
 */
export function resolveVertical(body: Body, box: BoxLike): number {
  const l = toLocal(body.x - box.x, body.z - box.z, box.yaw);
  const lx = l.x, lz = l.z;

  // How far the capsule's axis is from the box's footprint, horizontally.
  const dx = Math.max(Math.abs(lx) - box.hx, 0);
  const dz = Math.max(Math.abs(lz) - box.hz, 0);
  const horiz2 = dx * dx + dz * dz;
  if (horiz2 >= PLAYER_RADIUS * PLAYER_RADIUS) { return 0; }

  // Radius of the capsule's cross-section at that horizontal offset - this is
  // what rounds off the cap, so you slide off a ledge corner instead of
  // catching on it.
  const slack = Math.sqrt(PLAYER_RADIUS * PLAYER_RADIUS - horiz2);

  // The capsule's axis runs between the two cap centres; `slack` extends it
  // back out to the true silhouette at this horizontal offset.
  const lowY = body.y + PLAYER_RADIUS - slack;
  const highY = body.y + PLAYER_HEIGHT - PLAYER_RADIUS + slack;

  const boxTop = box.y + box.hy;
  const boxBottom = box.y - box.hy;
  if (lowY >= boxTop || highY <= boxBottom) { return 0; }

  const pushUp = boxTop - lowY;
  const pushDown = highY - boxBottom;

  if (pushUp <= pushDown) {
    body.y += pushUp;
    if (body.vy < 0) { body.vy = 0; }
    return 1;
  }
  body.y -= pushDown;
  if (body.vy > 0) { body.vy = 0; }
  return -1;
}

/** Surface height of a ramp under (x, z), or `NaN` when outside its footprint. */
export function rampSurfaceY(ramp: Ramp, x: number, z: number): number {
  if (Math.abs(x - ramp.x) > ramp.hx + PLAYER_RADIUS) { return NaN; }
  if (Math.abs(z - ramp.z) > ramp.hz) { return NaN; }
  const t = (z - (ramp.z - ramp.hz)) / (ramp.hz * 2);
  return ramp.y0 + (ramp.y1 - ramp.y0) * t;
}

/**
 * Ramps are ground-only: they lift the body onto their surface and never block
 * it sideways (the level puts real walls along the edges instead).
 */
export function resolveRamp(body: Body, ramp: Ramp): boolean {
  const surface = rampSurfaceY(ramp, body.x, body.z);
  if (Number.isNaN(surface)) { return false; }
  // A generous catch below the surface so running up the slope never clips
  // through it, but not so deep that the void underneath becomes solid.
  if (body.y > surface || body.y < surface - 2.5) { return false; }
  body.y = surface;
  if (body.vy < 0) { body.vy = 0; }
  return true;
}

// ---------------------------------------------------------------------------
// Horizontal pass
// ---------------------------------------------------------------------------

/**
 * Resolve the body against one box in the XZ plane.
 *
 * `canStep` allows short ledges to be climbed rather than blocked; the caller
 * passes the resulting step-up height back through `body.y`.
 * Returns true if the body was moved.
 */
export function resolveHorizontal(body: Body, box: BoxLike, canStep: boolean): boolean {
  const boxTop = box.y + box.hy;
  const boxBottom = box.y - box.hy;

  // Body occupies [y, y + height]. Use the full span, not the capsule caps:
  // vertical clearance is the vertical pass's business.
  //
  // CONTACT_EPS is load-bearing. The vertical pass rests a player at exactly
  // `boxTop`, but that arithmetic goes through a sqrt and can land an ulp low -
  // and an ulp low means the floor underfoot reads as a wall the body is buried
  // inside, which ejects it sideways by half a platform. A millimetre of slack
  // costs nothing and makes the resting case unambiguous.
  if (body.y >= boxTop - CONTACT_EPS) { return false; }
  if (body.y + PLAYER_HEIGHT <= boxBottom + CONTACT_EPS) { return false; }

  const l = toLocal(body.x - box.x, body.z - box.z, box.yaw);
  const lx = l.x, lz = l.z;

  const cx = lx < -box.hx ? -box.hx : lx > box.hx ? box.hx : lx;
  const cz = lz < -box.hz ? -box.hz : lz > box.hz ? box.hz : lz;
  let nx = lx - cx;
  let nz = lz - cz;
  let dist = Math.hypot(nx, nz);

  if (dist >= PLAYER_RADIUS) { return false; }

  // A ledge low enough to walk up: step onto it instead of being stopped.
  if (canStep) {
    const rise = boxTop - body.y;
    if (rise > 0.001 && rise <= STEP_HEIGHT) {
      body.y = boxTop;
      body.grounded = true;
      if (body.vy < 0) { body.vy = 0; }
      return true;
    }
  }

  let push: number;
  if (dist > 1e-6) {
    nx /= dist; nz /= dist;
    push = PLAYER_RADIUS - dist;
  } else {
    // Axis dead centre inside the box - leave along the nearest face.
    const outX = box.hx - Math.abs(lx);
    const outZ = box.hz - Math.abs(lz);
    if (outX < outZ) {
      nx = lx >= 0 ? 1 : -1; nz = 0;
      push = outX + PLAYER_RADIUS;
    } else {
      nx = 0; nz = lz >= 0 ? 1 : -1;
      push = outZ + PLAYER_RADIUS;
    }
  }

  const w = toWorld(nx * push, nz * push, box.yaw);
  body.x += w.x;
  body.z += w.z;

  // Cancel only the velocity heading into the surface, so players slide along
  // walls rather than sticking to them.
  const n = toWorld(nx, nz, box.yaw);
  const into = body.vx * n.x + body.vz * n.z;
  if (into < 0) {
    body.vx -= into * n.x;
    body.vz -= into * n.z;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Hazards (arbitrary orientation, overlap + normal only - never resolved)
// ---------------------------------------------------------------------------

export interface HitNormal { nx: number; nz: number; hit: boolean }

/**
 * Test the body's capsule against a box that may be both yawed and rolled, and
 * report the outward face normal at the contact.
 *
 * Sampling three points along the capsule axis is plenty for a knockback test
 * and keeps the maths to sphere-vs-AABB, which stays cheap under rollback.
 */
export function hazardHit(
  body: Body, pose: Pose, sx: number, sy: number, sz: number, out: HitNormal,
): HitNormal {
  out.hit = false; out.nx = 0; out.nz = 0;

  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const cosY = Math.cos(-pose.yaw), sinY = Math.sin(-pose.yaw);
  const cosR = Math.cos(-pose.roll), sinR = Math.sin(-pose.roll);

  let bestDepth = -1;
  let bestLx = 0, bestLy = 0, bestLz = 0;

  for (let i = 0; i < 3; i++) {
    const wy = body.y + PLAYER_RADIUS + (PLAYER_HEIGHT - PLAYER_RADIUS * 2) * (i / 2);
    const dx = body.x - pose.x;
    const dy = wy - pose.y;
    const dz = body.z - pose.z;

    // World -> local: undo yaw about Y, then roll about Z.
    const ax = dx * cosY + dz * sinY;
    const az = -dx * sinY + dz * cosY;
    const lx = ax * cosR - dy * sinR;
    const ly = ax * sinR + dy * cosR;
    const lz = az;

    const qx = lx < -hx ? -hx : lx > hx ? hx : lx;
    const qy = ly < -hy ? -hy : ly > hy ? hy : ly;
    const qz = lz < -hz ? -hz : lz > hz ? hz : lz;
    const ex = lx - qx, ey = ly - qy, ez = lz - qz;
    const d = Math.hypot(ex, ey, ez);
    if (d >= PLAYER_RADIUS) { continue; }

    const depth = PLAYER_RADIUS - d;
    if (depth > bestDepth) {
      bestDepth = depth;
      if (d > 1e-6) {
        bestLx = ex / d; bestLy = ey / d; bestLz = ez / d;
      } else {
        // Buried inside: leave through the nearest face.
        const ox = hx - Math.abs(lx), oy = hy - Math.abs(ly), oz = hz - Math.abs(lz);
        if (ox <= oy && ox <= oz) { bestLx = Math.sign(lx) || 1; bestLy = 0; bestLz = 0; }
        else if (oy <= oz) { bestLx = 0; bestLy = Math.sign(ly) || 1; bestLz = 0; }
        else { bestLx = 0; bestLy = 0; bestLz = Math.sign(lz) || 1; }
      }
    }
  }

  if (bestDepth < 0) { return out; }

  // Local -> world: redo roll, then yaw.
  const rx = bestLx * cosR + bestLy * sinR;
  const rz = bestLz;
  const wx = rx * cosY - rz * sinY;
  const wz = rx * sinY + rz * cosY;

  const len = Math.hypot(wx, wz);
  if (len < 1e-4) {
    // A purely vertical normal gives no shove direction; fall back to radial.
    const fx = body.x - pose.x, fz = body.z - pose.z;
    const flen = Math.hypot(fx, fz) || 1;
    out.nx = fx / flen; out.nz = fz / flen;
  } else {
    out.nx = wx / len; out.nz = wz / len;
  }
  out.hit = true;
  return out;
}

// ---------------------------------------------------------------------------
// Trigger volumes
// ---------------------------------------------------------------------------

/** Does the player's body overlap this axis-aligned volume? */
export function inVolume(x: number, y: number, z: number, v: Volume): boolean {
  return Math.abs(x - v.x) <= v.hx + PLAYER_RADIUS
    && Math.abs(z - v.z) <= v.hz + PLAYER_RADIUS
    && y + PLAYER_HEIGHT >= v.y - v.hy
    && y <= v.y + v.hy;
}

/** Cheap rejection so the long course does not cost a full scan per sub-step. */
export function nearStatic(s: SolidBox, x: number, z: number): boolean {
  return Math.abs(s.x - x) <= s.hx + 2 && Math.abs(s.z - z) <= s.hz + 2;
}

// ---------------------------------------------------------------------------
// Ray casting (used by the camera boom, which tests the same geometry the
// simulation collides against rather than a second, renderer-side copy)
// ---------------------------------------------------------------------------

/**
 * Distance along a ray to a yaw-rotated box, or -1 when it misses within
 * `maxDist`. Standard slab test, done in the box's local frame.
 */
export function rayBoxDistance(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  box: BoxLike, maxDist: number,
): number {
  let lox = ox - box.x;
  let loz = oz - box.z;
  let ldx = dx;
  let ldz = dz;
  if (box.yaw !== 0) {
    const c = Math.cos(box.yaw), s = Math.sin(box.yaw);
    const rx = lox * c + loz * s;
    const rz = -lox * s + loz * c;
    lox = rx; loz = rz;
    const vx = dx * c + dz * s;
    const vz = -dx * s + dz * c;
    ldx = vx; ldz = vz;
  }
  const loy = oy - box.y;

  let near = 0;
  let far = maxDist;

  // One slab per axis; the ray hits only where all three intervals overlap.
  const slab = (o: number, d: number, h: number): boolean => {
    if (Math.abs(d) < 1e-9) { return Math.abs(o) <= h; }
    const inv = 1 / d;
    let t0 = (-h - o) * inv;
    let t1 = (h - o) * inv;
    if (t0 > t1) { const swap = t0; t0 = t1; t1 = swap; }
    if (t0 > near) { near = t0; }
    if (t1 < far) { far = t1; }
    return near <= far;
  };

  if (!slab(lox, ldx, box.hx)) { return -1; }
  if (!slab(loy, dy, box.hy)) { return -1; }
  if (!slab(loz, ldz, box.hz)) { return -1; }
  return near > 0 && near <= maxDist ? near : -1;
}
