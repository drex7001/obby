/**
 * The contract every section is authored against.
 *
 * A section emits geometry in **section-local space**: +Z forward, the origin at
 * the entry gate, the floor at y 0. It never knows where on the course it ended
 * up. [generator.ts](../generator.ts) transforms what it emits by the cursor,
 * which carries a heading as well as a position - that is the whole reason the
 * course can turn.
 *
 * Two rules matter more than the rest, because breaking either desynchronises a
 * client from the server rather than merely looking wrong:
 *
 * 1. **Draw every random value at the top of `build()`, in a fixed order.** A
 *    section whose `rand()` count depends on an earlier `rand()` shifts every
 *    section after it.
 * 2. **Ids and crumble slots come from the context allocators**, never from a
 *    local counter. The room sizes its `crumbleTicks` array from
 *    `level.crumbleCount`, and a gap in the mapping breaks every crumble.
 */

import type {
  Anchor, Breaker, EnemySpawn, Obstacle, Pickup, Plate, Ramp, SolidBox, Vec3,
} from "../level.js";

/** A movement verb a section may require of a runner. */
export type Verb = "vault" | "carve" | "tether" | "salvo";

/**
 * Where a section can sit in a course.
 *
 * A set rather than a single value: the pool deliberately gives Straightaway
 * both `opener` and `rest`, and Turnstile earns `rest` on the strength of
 * costing time rather than lives.
 */
export type SectionRole = "opener" | "middle" | "rest" | "climb";

/** Gate widths. Only three exist, so any exit can meet any entry. */
export const GATE_WIDTH = { narrow: 6, standard: 14, wide: 22 } as const;
export type GateWidth = keyof typeof GATE_WIDTH;

/** Turn magnitudes. Only four exist, for the same reason. */
export const TURN = {
  straight: 0,
  bend: Math.PI / 6,      // 30 degrees
  corner: Math.PI / 2,    // 90 degrees
  about: Math.PI,         // 180 degrees
} as const;
export type TurnName = keyof typeof TURN;

export interface Gate {
  width: GateWidth;
  /** Exit height relative to the entry. Only 0, +-4 and +-8 are legal. */
  elevation: number;
  turn: TurnName;
}

/**
 * What a section is handed. The allocators and the emitters are the only way to
 * put anything into the world; a section that pushes onto an array it captured
 * itself is a section the generator cannot account for.
 */
export interface SectionCtx {
  /** The seeded stream. Draw a fixed number of values, at the top of `build`. */
  rand: () => number;
  nextId: () => number;
  nextCrumbleSlot: () => number;
  nextPlateId: () => number;
  nextBreakerSlot: () => number;
  nextPickupSlot: () => number;
  /** A slot in the room's shell array, for a turret whose shells are shootable. */
  nextShellSlot: () => number;
  /** Verbs this course is allowed to demand. A superset of `def.requires`. */
  verbs: ReadonlySet<Verb>;
  /** Signed heading change the section must realise, in radians. */
  turn: number;
  /** Entry gate width, in units. */
  entryWidth: number;
  /** Exit gate width, in units. */
  exitWidth: number;

  // ---- emitters, all in section-local space -------------------------------
  /** A floor slab whose walkable surface sits at `topY`. */
  floor(x: number, z: number, sx: number, sz: number, topY?: number, style?: string, yaw?: number): void;
  /**
   * A run of floor, emitted in short chunks so it still reads as a surface once
   * the generator bends it. Every straight-line stretch of track should use
   * this rather than one long slab.
   */
  track(sx: number, z0: number, z1: number, topY?: number, style?: string, x?: number): void;
  /** A wall standing on `baseY`. */
  wall(x: number, z: number, sx: number, sy: number, sz: number, baseY?: number, style?: string, yaw?: number): void;
  /**
   * A run of wall, chunked the same way {@link SectionCtx.track} is. Any wall
   * that runs along the section rather than across it must use this, or a
   * bending section gets one long chord where its railing should be.
   */
  rail(x: number, z0: number, z1: number, sy: number, sx?: number, baseY?: number, style?: string): void;
  ramp(r: Omit<Ramp, "yaw"> & { yaw?: number }): void;
  /** Push an obstacle. `id` is filled in; `slot` too, for crumbles. */
  obstacle(ob: Omit<Obstacle, "id">): Obstacle;
  plate(p: Omit<Plate, "id">): Plate;
  anchor(x: number, y: number, z: number): Anchor;
  /**
   * A shootable target. `slot` is filled in from the allocator, and it is that
   * slot - not the id - that a hazard or a `collapse` slab points at through
   * its own `breaker` field.
   */
  breaker(b: Omit<Breaker, "id" | "slot">): Breaker;
  /** A floating pickup. `slot` is filled in from the allocator. */
  pickup(p: Omit<Pickup, "id" | "slot">): Pickup;
  /**
   * An enemy standing where the author put it.
   *
   * Budget: at most two per section, and never on the six units either side of
   * a gate - a bank is where a runner is meant to be able to stop.
   */
  enemy(kind: number, x: number, y: number, z: number): EnemySpawn;
  /** Render-only dressing. Landmarks go here; nothing collides with them. */
  decor(x: number, y: number, z: number, sx: number, sy: number, sz: number, style: string, yaw?: number): void;
  /** Add a centre-line vertex. Called in order, from the entry to the exit. */
  spine(x: number, y: number, z: number): void;
  note(text: string): void;
}

export interface SectionResult {
  /** Z consumed in local space, entry gate to exit gate. */
  length: number;
  solids: SolidBox[];
  ramps: Ramp[];
  obstacles: Obstacle[];
  plates: Plate[];
  anchors: Anchor[];
  breakers: Breaker[];
  pickups: Pickup[];
  spawns: EnemySpawn[];
  decor: SolidBox[];
  /** Local-space centre-line. Always starts at the entry, ends at the exit. */
  spine: Vec3[];
  notes: string[];
}

export interface SectionDef {
  id: string;
  /** Display name. The checkpoint bank at this section's exit is labelled it. */
  title: string;
  /** Selection weight. 1 is average. */
  weight: number;
  difficulty: 1 | 2 | 3 | 4;
  roles: readonly SectionRole[];
  /** Verbs a runner needs. The generator only picks what the mode allows. */
  requires: readonly Verb[];
  /** The one verb this section is built around. Presentation and tests. */
  teaches: "vault" | "carve" | "tether" | "impact" | "salvo" | null;
  entry: Gate;
  exit: Gate;
  /** Declared length, entry gate to exit gate. Must be 36-60 u. */
  length: number;
  build(ctx: SectionCtx): void;
}

export const gateWidth = (g: Gate) => GATE_WIDTH[g.width];
export const gateTurn = (g: Gate) => TURN[g.turn];
