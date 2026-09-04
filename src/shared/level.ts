/**
 * The course, as data.
 *
 * `buildLevel(seed)` is a pure function: the server puts one integer in the room
 * state and every client rebuilds a bit-identical course from it - geometry,
 * obstacle phases and the per-round variant alike. Nothing about the level is
 * ever sent over the wire beyond that seed.
 *
 * This module is deliberately *only* the shapes and the shared timings. The
 * machinery that assembles a course lives in [generator.ts](./generator.ts) and
 * the content it assembles lives under [sections/](./sections/), so a section
 * can compile against these types without closing an import cycle.
 */

export { buildLevel, buildLevelWith, DEFAULT_VERBS } from "./generator.js";
export type { LevelOptions } from "./generator.js";

export interface Vec3 { x: number; y: number; z: number }

/**
 * Tuning a mutator is allowed to vary, carried **on the level**.
 *
 * This is the one technical trap stage 11 has, and it is why the migration is
 * its first task rather than its last: a mutator that changes a value the
 * client reads out of `constants.ts` desynchronises immediately, because the
 * client's copy is compiled in. Anything a mutator touches has to live
 * somewhere both ends read from the same place, and the level - rebuilt from a
 * seed on both ends, never transmitted - is exactly that place.
 *
 * Everything here defaults to the constant it shadows, so a course with no
 * mutators behaves identically to one built before this existed.
 */
export interface Tuning {
  gravity: number;
  groundFriction: number;
  /** Ticks of quiet before the Chain starts shedding. */
  chainDecayTicks: number;
  /** Chain levels one conversion is worth. */
  chainGain: number;
  pushStrength: number;
}

/** A yaw-rotated solid box. Half-extents, because that is what collision wants. */
export interface SolidBox {
  x: number; y: number; z: number;
  hx: number; hy: number; hz: number;
  yaw: number;
  style: string;
}

/**
 * A one-way sloped floor: a walkable surface rising linearly along its own +Z.
 *
 * `yaw` orients that local +Z in the world. It exists because the generator
 * places sections at a heading rather than at a Z coordinate; a ramp with
 * `yaw: 0` behaves exactly as it did before the field was added.
 */
export interface Ramp {
  x: number; z: number;
  hx: number; hz: number;
  y0: number; y1: number;
  yaw: number;
  style: string;
}

export type ObstacleKind =
  | "spinner"    // hazard arm sweeping about a vertical axis
  | "slider"     // box ping-ponging between two points (solid or hazard)
  | "pendulum"   // hazard head swinging through a vertical plane
  | "rotator"    // solid platform spinning about its own vertical axis
  | "crumble"    // solid that collapses shortly after being stood on
  | "door"       // solid that drops into the floor on a timed cycle
  | "hinge"      // solid that swings about an offset pivot, driven by a plate
  | "collapse"   // gantry that drops into a bridge when its breaker is shot
  | "seal"       // barrier that opens for the round when its seal is shot
  | "turret"     // hazard shell on a ballistic arc, fired on a fixed cycle
  | "sentry"     // hazard beam swept about a pivot; stuns, never launches
  | "swarm"      // hazard field armed by a plate - a trap, not a patrol
  | "nest"       // static solid that emits enemies on a fixed cycle
  | "startgate"; // solid until the race begins

export interface Obstacle {
  id: number;
  kind: ObstacleKind;
  role: "solid" | "hazard";
  style: string;
  /** Full size (not half-extents) - the renderer builds a BoxGeometry from it. */
  size: Vec3;
  /** Pivot / base position. For sliders this is the midpoint of the travel. */
  px: number; py: number; pz: number;

  a?: Vec3; b?: Vec3;      // slider endpoints (absolute box centres)
  period?: number;         // seconds per full cycle
  phase?: number;          // 0..1 offset into the cycle
  speed?: number;          // rad/s (spinner, rotator)
  armLength?: number;      // pendulum: pivot -> head distance
  amplitude?: number;      // pendulum: peak angle in radians
  offsetZ?: number;        // hinge: pivot -> box centre along the arm
  closedYaw?: number;
  openYaw?: number;
  openFraction?: number;   // door: fraction of the cycle spent open
  knock?: number;          // hazard: launch speed imparted on contact
  plate?: number;          // index into Level.plates driving this obstacle
  /** Static yaw baked in by the generator, added to whatever the pose computes. */
  baseYaw?: number;
  /** Index into the room's crumble-state array. Set for `crumble` only. */
  slot?: number;
  /**
   * Index into the room's breaker-state array (stage 6).
   *
   * A hazard carrying this goes inert for five seconds when that breaker is
   * shot; a `collapse` or `seal` solid carrying it is what the breaker builds
   * or opens. Never a requirement - see stage 6, Risk 1.
   */
  breaker?: number;
  /** `collapse`: how far the slab drops as it swings into place. */
  dropY?: number;

  // ---- watchers (stage 9) --------------------------------------------------
  /**
   * Index into the room's shell-state array, for a turret whose shells can be
   * shot down. Separate from `breaker` because a turret is not destroyed by the
   * shot - only the shell in flight is, and the next cycle fires as normal.
   */
  shell?: number;
  /** `turret`: muzzle speed and launch pitch, in u/s and radians. */
  muzzleSpeed?: number;
  muzzlePitch?: number;
  /** A searching yaw sweep laid over a slider's travel. Purely readability. */
  scan?: number;
  scanPeriod?: number;
  /** Stun without knockback. A sentry slows a runner rather than launching one. */
  stunOnly?: boolean;
}

/**
 * A trigger volume, rotated about +Y like everything else the generator places.
 *
 * The turning cursor is why this carries a yaw at all: a checkpoint bank on a
 * bending section is a rotated rectangle, and an axis-aligned box around it
 * either misses runners on the outside of the turn or fires early for runners
 * who have not reached it.
 */
export interface Volume {
  x: number; y: number; z: number;
  hx: number; hy: number; hz: number;
  yaw: number;
}

export interface Checkpoint {
  index: number;
  volume: Volume;
  /** Where a player respawns (feet position) once this checkpoint is theirs. */
  spawn: Vec3;
  yaw: number;
  label: string;
}

export interface Plate {
  id: number;
  volume: Volume;
  /** Standing runners hold normal plates; Heavy shockwaves fire Heavy plates. */
  activation: "hold" | "heavy";
  /** Ticks the plate stays hot after the last touch. */
  holdTicks: number;
  label: string;
}

/**
 * A tether attachment point (stage 7). Placed as level content now so the
 * sections built around the verb are authored once, not twice.
 */
export interface Anchor {
  id: number;
  x: number; y: number; z: number;
}

/**
 * A shootable target.
 *
 * Deliberately a separate prop class from the hazards themselves. Nothing here
 * deletes an obstacle: `disable` is a five-second window, `collapse` and `seal`
 * add a route, and `pod` and `crate` are loot. That is what keeps dodging the
 * central skill rather than an option - see stage 6, Risk 1.
 */
export interface Breaker {
  id: number;
  /** Index into the room's breaker-state array. */
  slot: number;
  x: number; y: number; z: number;
  hx: number; hy: number; hz: number;
  yaw: number;
  /** What breaking it does. Always a convenience, never a requirement. */
  effect: BreakerEffect;
  style: string;
}

export type BreakerEffect =
  | "disable"   // the hazards tagged with this slot go inert for five seconds
  | "collapse"  // a gantry drops into a bridge
  | "seal"      // a barrier opens, permanently for the round
  | "pod"       // three coins, shared with anyone who hits it within five ticks
  | "crate";    // two shots

/**
 * A floating pickup (stage 6). One gun, contested: two runners converging on
 * it is a race-within-the-race on a spot the section author chose.
 */
export interface Pickup {
  id: number;
  /** Index into the room's pickup-state array. */
  slot: number;
  x: number; y: number; z: number;
  kind: "gun" | "crate";
  /** Shots granted, capped at `AMMO_MAX`. */
  ammo: number;
}

/**
 * An enemy a section places directly (stage 9).
 *
 * Nests emit Shamblers on a schedule; a Lurcher waiting in a doorway or a
 * Bulwark parked across a lane is a *placement*, not a spawn rate, and belongs
 * with the geometry it was authored against.
 */
export interface EnemySpawn {
  id: number;
  /** Index into `ENEMY_SHAPES`: 0 Shambler, 1 Lurcher, 2 Bulwark. */
  kind: number;
  x: number; y: number; z: number;
}

/** Where a section ended up on the assembled course. Diagnostics and tests. */
export interface SectionPlacement {
  id: string;
  title: string;
  role: string;
  difficulty: number;
  teaches: string | null;
  /** Arc length along the course centre-line at this section's entry gate. */
  at: number;
  length: number;
  /** Cursor frame at the entry gate. */
  x: number; y: number; z: number; yaw: number;
  /** Heading change through the section, in radians. */
  turn: number;
  /** Width of the ground the section actually builds at each gate. */
  entryTrack: number;
  exitTrack: number;
}

export interface Level {
  seed: number;
  solids: SolidBox[];
  ramps: Ramp[];
  obstacles: Obstacle[];
  checkpoints: Checkpoint[];
  plates: Plate[];
  /** Render-only dressing: landmarks, posts, rails. Never collided against. */
  decor: SolidBox[];
  anchors: Anchor[];
  breakers: Breaker[];
  pickups: Pickup[];
  /** Enemies placed by section authors. Nests add more as the race runs. */
  spawns: EnemySpawn[];
  finish: Volume;
  /** Walkable surface height under the finish line, for the renderer's gate strip. */
  finishGroundY: number;
  spawn: Vec3;
  spawnYaw: number;
  /** Centre-line polyline used to score race progress. */
  path: Vec3[];
  pathLength: number;
  /** Cumulative path distance at each path vertex. */
  pathCum: number[];
  /** Number of `crumble` obstacles - the size of the room's crumble-state array. */
  crumbleCount: number;
  /** Number of breaker slots - the size of the room's breaker-state array. */
  breakerCount: number;
  /** Number of pickup slots - the size of the room's pickup-state array. */
  pickupCount: number;
  /** Number of shootable-shell slots - the size of the room's shell array. */
  shellCount: number;
  /** The sections this course was assembled from, in order. */
  sections: SectionPlacement[];
  /** Centre-line length from the start gate to the finish, excluding the lobby. */
  courseLength: number;
  /** Movement verbs the generator was allowed to require. Part of the seed. */
  verbs: string[];
  /** Tuning both ends must agree on. Mutators vary these; nothing else may. */
  tuning: Tuning;
  /** Mutator ids in play this round, in a stable order. */
  mutators: string[];
  /** Human-readable summary of what this round's variant changed. */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Timing shared with the room: how a crumble platform behaves once triggered.
// These moved to constants.ts so the section builders can read them; they are
// re-exported here because this is where callers have always found them.
// ---------------------------------------------------------------------------

export {
  CRUMBLE_DELAY_TICKS, CRUMBLE_GONE_TICKS, PLATE_HOLD_SECONDS, PLATE_HOLD_TICKS,
  START_GATE_STYLE,
} from "./constants.js";

/** Ordered spawn slots inside the lobby, so nobody spawns inside anyone else. */
export function lobbySlot(index: number): { x: number; z: number } {
  const cols = 3;
  const col = index % cols;
  const row = Math.floor(index / cols);
  return { x: (col - 1) * 4.5, z: -17 + row * 4.5 };
}
