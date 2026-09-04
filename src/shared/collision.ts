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
import type { Level, Ramp, SolidBox, Volume } from "./level.js";
import { isActiveAt, makePose, poseAt, type Pose, type WorldPhase } from "./obstacles.js";

/** Ledges no taller than this are climbed rather than blocked. */
export const STEP_HEIGHT = 0.46;
/** Slack at a contact plane, to keep exact-rest cases off the knife edge. */
const CONTACT_EPS = 1e-3;
/** Scratch, module-scoped: these functions are on the hot path. */
const tmp = { x: 0, y: 0, z: 0 };
const rayBox: BoxLike = { x: 0, y: 0, z: 0, hx: 0, hy: 0, hz: 0, yaw: 0 };
const rayPose = makePose();

export interface Body {
  x: number; y: number; z: number;   // feet position
  vx: number; vy: number; vz: number;
  /** Derived from carving; never networked separately. */
  height: number;
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
  const highY = body.y + body.height - PLAYER_RADIUS + slack;

  const boxTop = box.y + box.hy;
  const boxBottom = box.y - box.hy;
  if (lowY >= boxTop || highY <= boxBottom) { return 0; }

  // A tall wall overlaps a runner's vertical span while the runner is beside
  // it. It is a horizontal collision, not permission to eject the runner
  // through the floor. Resolve Y only when the body approaches the top or
  // underside within a capsule radius; the horizontal pass handles all other
  // overlaps. The velocity selects the only physically valid side.
  if (body.vy <= 0 && body.y >= boxTop - PLAYER_RADIUS) {
    body.y += boxTop - lowY;
    if (body.vy < 0) { body.vy = 0; }
    return 1;
  }
  if (body.vy > 0 && body.y + body.height <= boxBottom + PLAYER_RADIUS) {
    body.y -= highY - boxBottom;
    body.vy = 0;
    return -1;
  }
  return 0;
}

/**
 * Pure overlap test used before expanding a carving capsule back to full height.
 * It shares the exact rounded-cap footprint of `resolveVertical`, but does not
 * move the body or alter velocity, so a failed stand-up is harmless.
 */
export function bodyOverlapsBox(body: Body, box: BoxLike): boolean {
  const l = toLocal(body.x - box.x, body.z - box.z, box.yaw);
  const dx = Math.max(Math.abs(l.x) - box.hx, 0);
  const dz = Math.max(Math.abs(l.z) - box.hz, 0);
  const horiz2 = dx * dx + dz * dz;
  if (horiz2 >= PLAYER_RADIUS * PLAYER_RADIUS) { return false; }

  const slack = Math.sqrt(PLAYER_RADIUS * PLAYER_RADIUS - horiz2);
  const lowY = body.y + PLAYER_RADIUS - slack;
  const highY = body.y + body.height - PLAYER_RADIUS + slack;
  const boxTop = box.y + box.hy;
  const boxBottom = box.y - box.hy;
  return lowY < boxTop - CONTACT_EPS && highY > boxBottom + CONTACT_EPS;
}

/**
 * Surface height of a ramp under (x, z), or `NaN` when outside its footprint.
 *
 * The ramp rises along its OWN +Z, which `yaw` orients in the world. A ramp
 * with `yaw: 0` takes the same branch it always did.
 */
export function rampSurfaceY(ramp: Ramp, x: number, z: number): number {
  const l = toLocal(x - ramp.x, z - ramp.z, ramp.yaw);
  if (Math.abs(l.x) > ramp.hx + PLAYER_RADIUS) { return NaN; }
  if (Math.abs(l.z) > ramp.hz) { return NaN; }
  const t = (l.z + ramp.hz) / (ramp.hz * 2);
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
  if (body.y + body.height <= boxBottom + CONTACT_EPS) { return false; }

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
  // NOTE the sign. These feed the same formulae `toLocal`/`toWorld` use, so they
  // must take the same angle those do. Passing -yaw here instead mirrors the
  // hitbox about the obstacle's Z axis: a push bar's mesh sweeps one way while
  // its collider sweeps the other, meeting only twice per revolution, and
  // players get hit by a bar they can see they are clear of.
  const cosY = Math.cos(pose.yaw), sinY = Math.sin(pose.yaw);
  const cosR = Math.cos(-pose.roll), sinR = Math.sin(-pose.roll);

  let bestDepth = -1;
  let bestLx = 0, bestLy = 0, bestLz = 0;

  for (let i = 0; i < 3; i++) {
    const wy = body.y + PLAYER_RADIUS + (body.height - PLAYER_RADIUS * 2) * (i / 2);
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

/** Does the player's body overlap this volume? */
export function inVolume(x: number, y: number, z: number, v: Volume, height = PLAYER_HEIGHT): boolean {
  const l = toLocal(x - v.x, z - v.z, v.yaw);
  return Math.abs(l.x) <= v.hx + PLAYER_RADIUS
    && Math.abs(l.z) <= v.hz + PLAYER_RADIUS
    && y + height >= v.y - v.hy
    && y <= v.y + v.hy;
}

/**
 * Cheap rejection so the long course does not cost a full scan per sub-step.
 *
 * A yawed box gets the conservative `hx + hz` bound rather than a trig-exact
 * one. It admits a few more candidates to the exact resolver, which is free;
 * the alternative - a sin/cos pair per box per sub-step - is not. Getting this
 * wrong the other way would cull the slab a runner is standing on.
 */
export function nearStatic(s: SolidBox, x: number, z: number): boolean {
  const reach = s.yaw === 0 ? 0 : s.hx + s.hz;
  return Math.abs(s.x - x) <= (s.yaw === 0 ? s.hx : reach) + 2
    && Math.abs(s.z - z) <= (s.yaw === 0 ? s.hz : reach) + 2;
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

  // One slab per axis; written inline so this hot query does not allocate a
  // closure for every ray-box test.
  if (Math.abs(ldx) < 1e-9) {
    if (Math.abs(lox) > box.hx) { return -1; }
  } else {
    const inv = 1 / ldx;
    let t0 = (-box.hx - lox) * inv;
    let t1 = (box.hx - lox) * inv;
    if (t0 > t1) { const swap = t0; t0 = t1; t1 = swap; }
    if (t0 > near) { near = t0; }
    if (t1 < far) { far = t1; }
    if (near > far) { return -1; }
  }
  if (Math.abs(dy) < 1e-9) {
    if (Math.abs(loy) > box.hy) { return -1; }
  } else {
    const inv = 1 / dy;
    let t0 = (-box.hy - loy) * inv;
    let t1 = (box.hy - loy) * inv;
    if (t0 > t1) { const swap = t0; t0 = t1; t1 = swap; }
    if (t0 > near) { near = t0; }
    if (t1 < far) { far = t1; }
    if (near > far) { return -1; }
  }
  if (Math.abs(ldz) < 1e-9) {
    if (Math.abs(loz) > box.hz) { return -1; }
  } else {
    const inv = 1 / ldz;
    let t0 = (-box.hz - loz) * inv;
    let t1 = (box.hz - loz) * inv;
    if (t0 > t1) { const swap = t0; t0 = t1; t1 = swap; }
    if (t0 > near) { near = t0; }
    if (t1 < far) { far = t1; }
    if (near > far) { return -1; }
  }
  return near > 0 && near <= maxDist ? near : -1;
}

/** Result storage for the shared, allocation-free world ray query. */
export interface RayHit {
  /** Distance along the ray, or -1 when no collidable geometry was hit. */
  dist: number;
  kind: "solid" | "obstacle" | "ramp" | "anchor" | "breaker";
  /** Static geometry has id 0. */
  obstacleId: number;
  x: number; y: number; z: number;
  nx: number; ny: number; nz: number;
}

/** Fill a normal for a ray-box hit using the same yaw convention as collision. */
function writeBoxHit(
  out: RayHit, dist: number, kind: RayHit["kind"], obstacleId: number,
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  box: BoxLike,
) {
  out.dist = dist;
  out.kind = kind;
  out.obstacleId = obstacleId;
  out.x = ox + dx * dist;
  out.y = oy + dy * dist;
  out.z = oz + dz * dist;

  const local = toLocal(out.x - box.x, out.z - box.z, box.yaw);
  const faceX = Math.abs(Math.abs(local.x) - box.hx);
  const faceY = Math.abs(Math.abs(out.y - box.y) - box.hy);
  const faceZ = Math.abs(Math.abs(local.z) - box.hz);
  let lx = 0, ly = 0, lz = 0;
  if (faceX <= faceY && faceX <= faceZ) { lx = local.x < 0 ? -1 : 1; }
  else if (faceY <= faceZ) { ly = out.y < box.y ? -1 : 1; }
  else { lz = local.z < 0 ? -1 : 1; }
  const world = toWorld(lx, lz, box.yaw);
  out.nx = world.x;
  out.ny = ly;
  out.nz = world.z;
}

/** Safe broad phase for a finite ray: a box outside either expanded axis cannot hit. */
function nearRayBox(box: BoxLike, ox: number, oy: number, oz: number, maxDist: number): boolean {
  const horizontal = Math.hypot(box.hx, box.hz);
  return Math.abs(box.x - ox) <= maxDist + horizontal
    && Math.abs(box.y - oy) <= maxDist + box.hy
    && Math.abs(box.z - oz) <= maxDist + horizontal;
}

/**
 * Deterministic query against the simulation's collidable world. Callers own
 * `out`; no result object, temporary vector, or Babylon scene query is created
 * in the hot path. Dynamic solids are evaluated at the supplied fractional
 * world tick, exactly as `stepPlayer()` does during a sub-step.
 */
export function raycastWorld(
  level: Level, phase: WorldPhase, tick: number,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxDist: number, out: RayHit,
): RayHit {
  out.dist = -1;
  out.kind = "solid";
  out.obstacleId = 0;
  out.x = ox; out.y = oy; out.z = oz;
  out.nx = 0; out.ny = 0; out.nz = 0;
  let best = maxDist;

  for (const solid of level.solids) {
    rayBox.x = solid.x; rayBox.y = solid.y; rayBox.z = solid.z;
    rayBox.hx = solid.hx; rayBox.hy = solid.hy; rayBox.hz = solid.hz; rayBox.yaw = solid.yaw;
    if (!nearRayBox(rayBox, ox, oy, oz, best)) { continue; }
    const dist = rayBoxDistance(ox, oy, oz, dx, dy, dz, rayBox, best);
    if (dist < 0) { continue; }
    best = dist;
    writeBoxHit(out, dist, "solid", 0, ox, oy, oz, dx, dy, dz, rayBox);
  }

  // Ramps collide as their walkable plane, not as the renderer's decorative
  // thick slab. That keeps rays and movement on one geometry definition.
  for (const ramp of level.ramps) {
    const rise = ramp.y1 - ramp.y0;
    const length = ramp.hz * 2;
    const slope = rise / length;
    // Solve in the ramp's own frame, where the surface is still a plane rising
    // along +Z, then rotate the normal back out.
    const o = toLocal(ox - ramp.x, oz - ramp.z, ramp.yaw);
    const lox = o.x, loz = o.z;
    const v = toLocal(dx, dz, ramp.yaw);
    const ldx = v.x, ldz = v.z;
    const denom = dy - slope * ldz;
    if (Math.abs(denom) < 1e-9) { continue; }
    const dist = (ramp.y0 + slope * (loz + ramp.hz) - oy) / denom;
    if (dist <= 0 || dist > best) { continue; }
    const lx = lox + ldx * dist;
    const lz = loz + ldz * dist;
    if (Math.abs(lx) > ramp.hx || Math.abs(lz) > ramp.hz) { continue; }
    best = dist;
    out.dist = dist;
    out.kind = "ramp";
    out.obstacleId = 0;
    out.x = ox + dx * dist; out.y = oy + dy * dist; out.z = oz + dz * dist;
    const normalLength = Math.hypot(1, slope);
    const n = toWorld(0, -slope / normalLength, ramp.yaw);
    out.nx = n.x; out.ny = 1 / normalLength; out.nz = n.z;
  }

  for (const ob of level.obstacles) {
    if (ob.role !== "solid" || !isActiveAt(ob, tick, phase)) { continue; }
    poseAt(ob, tick, phase, rayPose);
    if (!rayPose.active) { continue; }
    rayBox.x = rayPose.x; rayBox.y = rayPose.y; rayBox.z = rayPose.z;
    rayBox.hx = ob.size.x / 2; rayBox.hy = ob.size.y / 2; rayBox.hz = ob.size.z / 2;
    rayBox.yaw = rayPose.yaw;
    if (!nearRayBox(rayBox, ox, oy, oz, best)) { continue; }
    const dist = rayBoxDistance(ox, oy, oz, dx, dy, dz, rayBox, best);
    if (dist < 0) { continue; }
    best = dist;
    writeBoxHit(out, dist, "obstacle", ob.id, ox, oy, oz, dx, dy, dz, rayBox);
  }

  return out;
}
