/**
 * The emitter a section builds through.
 *
 * Everything here works in section-local space and appends to plain arrays. It
 * exists so the fourteen section files contain course design and nothing else -
 * no id bookkeeping, no array plumbing, and no knowledge of where the section
 * will end up.
 */

import type {
  Anchor, Breaker, EnemySpawn, Obstacle, Pickup, Plate, Ramp, SolidBox, Vec3,
} from "../level.js";
import type { SectionCtx, SectionDef, SectionResult, Verb } from "./types.js";
import { gateTurn, gateWidth } from "./types.js";

/**
 * Depth of one slab of `track()`.
 *
 * A section is bent by warping the points it emits onto an arc, so a single
 * 40-unit slab would come out as one long box rotated to the arc's average
 * heading - a chord, with the track falling away either side of it. Chunking
 * turns the chord into a polygon that hugs the arc. Five units keeps the worst
 * sagitta on the tightest turn in the pool (the Spiral, radius 14) at 0.22 u,
 * comfortably under a step.
 */
const TRACK_CHUNK = 5;
/** Chunks overlap slightly so a bent join leaves no gap on the outer edge. */
const TRACK_OVERLAP = 0.6;

export interface Allocators {
  rand: () => number;
  nextId: () => number;
  nextCrumbleSlot: () => number;
  nextPlateId: () => number;
  nextBreakerSlot: () => number;
  nextPickupSlot: () => number;
  nextShellSlot: () => number;
  verbs: ReadonlySet<Verb>;
}

/** Run one section's `build()` and collect everything it emitted. */
export function runSection(def: SectionDef, alloc: Allocators, turn: number): SectionResult {
  const solids: SolidBox[] = [];
  const ramps: Ramp[] = [];
  const obstacles: Obstacle[] = [];
  const plates: Plate[] = [];
  const anchors: Anchor[] = [];
  const breakers: Breaker[] = [];
  const pickups: Pickup[] = [];
  const spawns: EnemySpawn[] = [];
  const decor: SolidBox[] = [];
  const spine: Vec3[] = [];
  const notes: string[] = [];

  const ctx: SectionCtx = {
    rand: alloc.rand,
    nextId: alloc.nextId,
    nextCrumbleSlot: alloc.nextCrumbleSlot,
    nextPlateId: alloc.nextPlateId,
    nextBreakerSlot: alloc.nextBreakerSlot,
    nextPickupSlot: alloc.nextPickupSlot,
    nextShellSlot: alloc.nextShellSlot,
    verbs: alloc.verbs,
    turn,
    entryWidth: gateWidth(def.entry),
    exitWidth: gateWidth(def.exit),

    floor(x, z, sx, sz, topY = 0, style = "track", yaw = 0) {
      solids.push({ x, y: topY - 0.5, z, hx: sx / 2, hy: 0.5, hz: sz / 2, yaw, style });
    },

    track(sx, z0, z1, topY = 0, style = "track", x = 0) {
      const span = z1 - z0;
      // A straight section is emitted as one slab, exactly as it was before the
      // generator existed. Only a bent section pays for the chunking.
      const count = turn === 0 ? 1 : Math.max(1, Math.round(span / TRACK_CHUNK));
      const step = span / count;
      for (let i = 0; i < count; i++) {
        const mid = z0 + step * (i + 0.5);
        const depth = step + (count > 1 ? TRACK_OVERLAP : 0);
        solids.push({
          x, y: topY - 0.5, z: mid,
          hx: sx / 2, hy: 0.5, hz: depth / 2, yaw: 0, style,
        });
      }
    },

    wall(x, z, sx, sy, sz, baseY = 0, style = "wall", yaw = 0) {
      solids.push({ x, y: baseY + sy / 2, z, hx: sx / 2, hy: sy / 2, hz: sz / 2, yaw, style });
    },

    rail(x, z0, z1, sy, sx = 0.8, baseY = 0, style = "divider") {
      const span = z1 - z0;
      const count = turn === 0 ? 1 : Math.max(1, Math.round(span / TRACK_CHUNK));
      const step = span / count;
      for (let i = 0; i < count; i++) {
        const depth = step + (count > 1 ? TRACK_OVERLAP : 0);
        solids.push({
          x, y: baseY + sy / 2, z: z0 + step * (i + 0.5),
          hx: sx / 2, hy: sy / 2, hz: depth / 2, yaw: 0, style,
        });
      }
    },

    ramp(r) {
      ramps.push({ ...r, yaw: r.yaw ?? 0 });
    },

    obstacle(ob) {
      const full = { ...ob, id: alloc.nextId() } as Obstacle;
      if (full.kind === "crumble" && full.slot === undefined) {
        full.slot = alloc.nextCrumbleSlot();
      }
      obstacles.push(full);
      return full;
    },

    plate(p) {
      const full: Plate = { ...p, id: alloc.nextPlateId() };
      plates.push(full);
      return full;
    },

    anchor(x, y, z) {
      const a: Anchor = { id: alloc.nextId(), x, y, z };
      anchors.push(a);
      return a;
    },

    breaker(b) {
      const full: Breaker = { ...b, id: alloc.nextId(), slot: alloc.nextBreakerSlot() };
      breakers.push(full);
      return full;
    },

    pickup(p) {
      const full: Pickup = { ...p, id: alloc.nextId(), slot: alloc.nextPickupSlot() };
      pickups.push(full);
      return full;
    },

    enemy(kind, x, y, z) {
      const full: EnemySpawn = { id: alloc.nextId(), kind, x, y, z };
      spawns.push(full);
      return full;
    },

    decor(x, y, z, sx, sy, sz, style, yaw = 0) {
      decor.push({ x, y, z, hx: sx / 2, hy: sy / 2, hz: sz / 2, yaw, style });
    },

    spine(x, y, z) { spine.push({ x, y, z }); },

    note(text) { notes.push(text); },
  };

  def.build(ctx);

  // A section that forgot its centre-line still has to be placeable, and the
  // straight line from gate to gate is the only defensible default.
  if (spine.length < 2) {
    spine.length = 0;
    spine.push({ x: 0, y: 0, z: 0 });
    spine.push({ x: 0, y: def.exit.elevation, z: def.length });
  }

  return {
    length: def.length,
    solids, ramps, obstacles, plates, anchors, breakers, pickups, spawns,
    decor, spine, notes,
  };
}

/** Convenience for section authors: the straight spine most sections want. */
export function straightSpine(ctx: SectionCtx, length: number, elevation = 0, steps = 4) {
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    ctx.spine(0, elevation * t, length * t);
  }
}

export { gateTurn, gateWidth };
