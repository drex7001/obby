/**
 * The course generator.
 *
 * `buildLevel(seed)` picks seven sections from the registry and assembles them
 * at a **cursor** - a frame carrying a heading and an elevation, not just a Z
 * coordinate. That is the whole reason a course can turn. Sections are authored
 * in local space (+Z forward, entry gate at the origin, floor at y 0) and know
 * nothing about where they land.
 *
 * Determinism is the invariant, not any particular course. Every value here
 * comes from the seed and from the verb set, which is itself part of the seeded
 * input; nothing branches on player count, wall-clock time or the room tick.
 */

import {
  AMMO_MAX, CHAIN_DECAY_TICKS, GRAVITY, GROUND_FRICTION, PUSH_STRENGTH,
  START_GATE_STYLE,
} from "./constants.js";
import { mulberry32 } from "./math.js";
import type {
  Anchor, Breaker, Checkpoint, EnemySpawn, Level, Obstacle, Pickup, Plate, Ramp,
  SectionPlacement, SolidBox, Tuning, Vec3, Volume,
} from "./level.js";
import {
  applyTuning, mutatorNotes, sanitizeMutators, sectionCount, withheldVerbs,
} from "./mutators.js";
import { runSection } from "./sections/build.js";
import { SECTIONS } from "./sections/registry.js";
import type { SectionDef, SectionResult, SectionRole, Verb } from "./sections/types.js";
import { gateTurn, gateWidth } from "./sections/types.js";

/**
 * Verbs a runner is assumed to have.
 *
 * This list grows one entry per stage that ships a verb, and it is what the
 * generator filters the pool on - a section requiring a verb that is not here
 * is simply never picked. All four are now shipped, so the whole pool is live;
 * a mode or a mutator that withholds one passes a shorter list and the sections
 * built around it drop out of selection on their own.
 */
export const DEFAULT_VERBS: readonly Verb[] = ["vault", "carve", "salvo", "tether"];

export interface LevelOptions {
  /** Movement verbs a section is allowed to require. Part of the seeded input. */
  verbs?: readonly Verb[];
  /**
   * The round's mutators.
   *
   * Omitted means "whatever this seed is worth", so a client that knows only the
   * seed still builds the right course. The room passes them explicitly anyway,
   * because a mode may want to force or forbid part of the deck - and because a
   * list on the wire is one small string rather than a rule both ends have to
   * agree to have implemented identically.
   */
  mutators?: readonly string[];
  /**
   * Extra coin pods to scatter, for Collect.
   *
   * A mode changes what a course is *for*, and Collect needs something to
   * collect. Pods rather than a new prop class, because a pod is already the
   * thing a section author declares as "worth going out of your way for", and
   * it already reads at speed.
   */
  tokens?: number;
}

/** The tuning a course runs at when nothing is varying it. */
export function baseTuning(): Tuning {
  return {
    gravity: GRAVITY,
    groundFriction: GROUND_FRICTION,
    chainDecayTicks: CHAIN_DECAY_TICKS,
    chainGain: 1,
    pushStrength: PUSH_STRENGTH,
  };
}

// --------------------------------------------------------------- course shape
/**
 * Sections between the opener and the Climb, before the rest beat is inserted.
 *
 * Seven sections total by default; Marathon and Sprint move it.
 */
const MIDDLE_COUNT = 4;
/**
 * The hazard-free link the generator drops between two sections.
 *
 * `BANK_WIDTH` is a floor, not the answer: the bank is widened to whatever the
 * ground either side of it actually is. A section may build a track wider than
 * the gate it declares - the Gauntlet's whole point is a 26 u track with an
 * unswept outer lane - and a bank narrower than the track feeding it is a hole
 * at the one place on the course that has to be safe.
 */
const BANK_WIDTH = 20;
const BANK_DEPTH = 4;
/** Clearance a turn must leave from the course already built, in units. */
const MIN_SELF_CLEARANCE = 26;
/**
 * Arc length that must separate two points on the course before they are
 * expected to be apart in space. Anything closer along the centre-line is the
 * course being joined to itself, which is the point.
 */
const SELF_CLEARANCE_TAIL = 60;
/** The course may not wind past a half turn in either direction, cumulatively. */
const MAX_HEADING = Math.PI + 1e-6;

// ---------------------------------------------------------------- the cursor
interface Cursor { x: number; z: number; y: number; yaw: number }

/**
 * A section is bent by warping the points it emits onto a constant-radius arc:
 * `turn` radians over `length` units gives radius `length / turn`. A straight
 * section is the degenerate case and passes through untouched.
 *
 * Positive yaw takes +Z toward -X - the convention `rotateY()` and the whole
 * collision layer already use - so a positive turn bends the course left.
 */
interface Warp { radius: number; turning: boolean }

const makeWarp = (length: number, turn: number): Warp =>
  Math.abs(turn) < 1e-9
    ? { radius: 0, turning: false }
    : { radius: length / turn, turning: true };

/**
 * Heading the warp imposed on the point most recently passed to `place()`.
 *
 * A side channel rather than a second return value because `place()` runs once
 * per emitted box on a path that must not allocate.
 */
let warpYaw = 0;

/** Local point -> world point, through the warp and then the cursor. */
function place(warp: Warp, cur: Cursor, x: number, y: number, z: number, out: Vec3): Vec3 {
  let lx = x, lz = z, spin = 0;
  if (warp.turning) {
    const r = warp.radius;
    const phi = z / r;
    const reach = r + x;
    lx = reach * Math.cos(phi) - r;
    lz = reach * Math.sin(phi);
    spin = phi;
  }
  const c = Math.cos(cur.yaw), s = Math.sin(cur.yaw);
  out.x = cur.x + lx * c - lz * s;
  out.y = cur.y + y;
  out.z = cur.z + lx * s + lz * c;
  warpYaw = cur.yaw + spin;
  return out;
}

// ------------------------------------------------------------------ selection
function weightedPick(rand: () => number, pool: readonly SectionDef[]): SectionDef {
  let total = 0;
  for (const def of pool) { total += def.weight; }
  let roll = rand() * total;
  for (const def of pool) {
    roll -= def.weight;
    if (roll < 0) { return def; }
  }
  return pool[pool.length - 1];
}

/**
 * Difficulty pacing.
 *
 * The spec's "no two difficulty >= 3 adjacent" cannot be satisfied by the pool
 * it ships with - nine of the ten middles are tagged 3 or 4 - so the generator
 * enforces the intent instead: never two 4s in a row, never three hard sections
 * in a row, and the rest beat placed straight after the hardest run.
 */
function pacingOk(order: readonly SectionDef[]): boolean {
  for (let i = 1; i < order.length; i++) {
    if (order[i].difficulty >= 4 && order[i - 1].difficulty >= 4) { return false; }
  }
  for (let i = 2; i < order.length; i++) {
    if (order[i].difficulty >= 3 && order[i - 1].difficulty >= 3 && order[i - 2].difficulty >= 3) {
      return false;
    }
  }
  return true;
}

/**
 * Elevation has to net out: a course ends within +-4 u of where it started,
 * plus the Climb's own +4. Only 0 and +-8 are in the pool, so "can we still get
 * back" reduces to "is the section that undoes this one still available".
 */
function elevationOk(
  net: number, def: SectionDef, picksAfter: number, rest: readonly SectionDef[],
): boolean {
  const after = net + def.exit.elevation;
  if (after === 0) { return true; }
  if (picksAfter <= 0) { return false; }
  return rest.some((d) => d !== def && d.exit.elevation === -after);
}

function selectSections(
  rand: () => number, verbs: ReadonlySet<Verb>, middleCount = MIDDLE_COUNT,
): SectionDef[] {
  const pool = SECTIONS.filter((def) => def.requires.every((v) => verbs.has(v)));
  const used = new Set<SectionDef>();
  const free = (role: SectionRole) =>
    pool.filter((d) => !used.has(d) && d.roles.includes(role));
  const take = (candidates: SectionDef[], fallback: SectionDef[]) => {
    const from = candidates.length > 0 ? candidates : fallback;
    const def = weightedPick(rand, from);
    used.add(def);
    return def;
  };

  // The opener sets the difficulty floor for the whole course.
  const opener = take(free("opener").filter((d) => d.difficulty <= 2), free("opener"));
  // The rest beat is claimed before the middles, so a pool where the same
  // section can open *and* rest never leaves the generator without one.
  const rest = take(free("rest"), free("middle"));

  const middles: SectionDef[] = [];
  let net = opener.exit.elevation + rest.exit.elevation;
  for (let i = 0; i < middleCount; i++) {
    const picksAfter = middleCount - 1 - i;
    const available = free("middle");
    const paced = available.filter((def) => pacingOk([opener, ...middles, def]));
    const level = available.filter((def) => elevationOk(net, def, picksAfter, available));
    // Elevation outranks pacing when the two disagree. A course that does not
    // net out ends eight units off its own datum, which is a broken course;
    // one hard section too many in a row is only a worse course.
    const both = paced.filter((def) => level.includes(def));
    const chosen = take(both, level.length > 0 ? level : paced);
    net += chosen.exit.elevation;
    middles.push(chosen);
  }

  const climb = take(free("climb"), pool.filter((d) => d.roles.includes("climb")));

  // The rest goes straight after the hardest section, then slides along until
  // the pacing rule is happy with where it landed.
  let hardest = 0;
  for (let i = 1; i < middles.length; i++) {
    if (middles[i].difficulty > middles[hardest].difficulty) { hardest = i; }
  }
  const wanted = hardest + 1;
  let at = wanted;
  let settled = false;
  for (let step = 0; step <= middles.length && !settled; step++) {
    for (const candidate of [wanted - step, wanted + step]) {
      if (candidate < 0 || candidate > middles.length) { continue; }
      const trial = middles.slice();
      trial.splice(candidate, 0, rest);
      if (pacingOk([opener, ...trial, climb])) { at = candidate; settled = true; break; }
    }
  }
  const body = middles.slice();
  body.splice(Math.min(Math.max(at, 0), body.length), 0, rest);

  return [opener, ...body, climb];
}

// ------------------------------------------------------------------ assembly
export function buildLevel(seed: number): Level {
  return buildLevelWith(seed, {});
}

export function buildLevelWith(seed: number, options: LevelOptions): Level {
  const rand = mulberry32(seed || 1);
  // Explicit, never implicit. `buildLevel(seed)` is the clean game and keeps
  // every guarantee stage 4 makes about it; a mutated round is one the room
  // asked for and published, so a client is never guessing which deck it is on.
  const mutators = sanitizeMutators(options.mutators ?? []);
  const withheld = new Set(withheldVerbs(mutators));
  const verbList = (options.verbs ?? DEFAULT_VERBS)
    .filter((v) => !withheld.has(v)).slice().sort();
  const verbs = new Set(verbList) as ReadonlySet<Verb>;
  const middles = Math.max(1, sectionCount(mutators) - 3);

  const solids: SolidBox[] = [];
  const ramps: Ramp[] = [];
  const obstacles: Obstacle[] = [];
  const checkpoints: Checkpoint[] = [];
  const plates: Plate[] = [];
  const decor: SolidBox[] = [];
  const anchors: Anchor[] = [];
  const breakers: Breaker[] = [];
  const pickups: Pickup[] = [];
  const spawns: EnemySpawn[] = [];
  const placements: SectionPlacement[] = [];
  const path: Vec3[] = [];
  const notes: string[] = [];

  let nextId = 1;
  let crumbleCount = 0;
  let plateCount = 0;
  let breakerCount = 0;
  let pickupCount = 0;
  let shellCount = 0;
  const alloc = {
    rand,
    nextId: () => nextId++,
    nextCrumbleSlot: () => crumbleCount++,
    nextPlateId: () => plateCount++,
    nextBreakerSlot: () => breakerCount++,
    nextPickupSlot: () => pickupCount++,
    nextShellSlot: () => shellCount++,
    verbs,
  };

  const scratch: Vec3 = { x: 0, y: 0, z: 0 };
  const straight: Warp = { radius: 0, turning: false };

  // ======================================================== 0. LOBBY / STAGING
  solids.push({ x: 0, y: -0.5, z: -12, hx: 13, hy: 0.5, hz: 12, yaw: 0, style: "lobby" });
  solids.push({ x: -13.5, y: 1.5, z: -12, hx: 0.5, hy: 1.5, hz: 12, yaw: 0, style: "wall" });
  solids.push({ x: 13.5, y: 1.5, z: -12, hx: 0.5, hy: 1.5, hz: 12, yaw: 0, style: "wall" });
  solids.push({ x: 0, y: 1.5, z: -24.5, hx: 14, hy: 1.5, hz: 0.5, yaw: 0, style: "wall" });
  obstacles.push({
    id: nextId++, kind: "startgate", role: "solid", style: START_GATE_STYLE,
    size: { x: 26, y: 4, z: 0.7 }, px: 0, py: 2, pz: 0,
  });

  path.push({ x: 0, y: 0, z: -12 });
  path.push({ x: 0, y: 0, z: 0 });

  const order = selectSections(rand, verbs, middles);
  const cursor: Cursor = { x: 0, z: 0, y: 0, yaw: 0 };
  let heading = 0;
  let travelled = 0;
  // Banks are emitted after the loop: sizing one needs the measured width of
  // the section on BOTH sides of it, and the far side is not built yet.
  const banks: { at: Cursor; label: string }[] = [];

  // How much course is still to come after each section. A turn is judged on
  // where it points the rest of the run, not just on the arc itself.
  const remaining: number[] = new Array(order.length).fill(0);
  for (let i = order.length - 2; i >= 0; i--) {
    remaining[i] = remaining[i + 1] + order[i + 1].length + BANK_DEPTH;
  }

  for (let index = 0; index < order.length; index++) {
    const def = order[index];
    const size = gateTurn(def.exit);
    const turn = size === 0
      ? 0
      : chooseTurn(rand, cursor, heading, def, size, path, remaining[index]);
    heading += turn;

    const entry = { x: cursor.x, y: cursor.y, z: cursor.z, yaw: cursor.yaw };
    const result = runSection(def, alloc, turn);
    const warp = makeWarp(def.length, turn);

    emit(result, warp, cursor);
    for (const point of result.spine) {
      place(warp, cursor, point.x, point.y, point.z, scratch);
      pushPath(path, scratch);
    }
    for (const text of result.notes) { notes.push(text); }

    placements.push({
      id: def.id, title: def.title, role: def.roles[0],
      difficulty: def.difficulty, teaches: def.teaches,
      at: travelled, length: def.length,
      x: entry.x, y: entry.y, z: entry.z, yaw: entry.yaw, turn,
      entryTrack: gateSpan(result, 0),
      exitTrack: gateSpan(result, def.length),
    });
    travelled += def.length;

    // Advance the cursor to the section's exit gate.
    place(warp, cursor, 0, def.exit.elevation, def.length, scratch);
    cursor.x = scratch.x; cursor.y = scratch.y; cursor.z = scratch.z;
    cursor.yaw += turn;

    if (index < order.length - 1) {
      banks.push({ at: { ...cursor }, label: def.title });
      place(straight, cursor, 0, 0, BANK_DEPTH, scratch);
      cursor.x = scratch.x; cursor.z = scratch.z;
      pushPath(path, scratch);
      travelled += BANK_DEPTH;
    }
  }

  banks.forEach((bank, i) => {
    const width = Math.max(
      BANK_WIDTH,
      gateWidth(order[i].exit), gateWidth(order[i + 1].entry),
      placements[i].exitTrack, placements[i + 1].entryTrack,
    );
    emitBank(solids, checkpoints, bank.at, width, bank.label, i);

    // One gun on the course, on the first bank, off to one side.
    //
    // It belongs to the generator rather than to a section because a course
    // whose draw happens to contain no armed section would otherwise have no
    // gun at all - and "did you find a gun" is not a decision, it is a lottery.
    // A bank is the right spot for the same reason it carries the checkpoint:
    // it is the one place on the course where looking sideways is affordable,
    // and two runners converging on it is a race within the race.
    if (i === 0 && verbs.has("salvo")) {
      const c = Math.cos(bank.at.yaw), sn = Math.sin(bank.at.yaw);
      const lx = width / 2 - 2.4;
      pickups.push({
        id: nextId++, slot: pickupCount++,
        x: bank.at.x + lx * c - BANK_DEPTH / 2 * sn,
        y: bank.at.y + 1.3,
        z: bank.at.z + lx * sn + BANK_DEPTH / 2 * c,
        kind: "gun", ammo: AMMO_MAX,
      });
    }
  });

  // ------------------------------------------------------- finish and run-out
  const finish: Volume = {
    x: cursor.x, y: cursor.y + 3, z: cursor.z, hx: 8, hy: 3, hz: 1.5, yaw: cursor.yaw,
  };
  emitBox(solids, straight, cursor,
    { x: 0, y: -0.5, z: 5, hx: 10, hy: 0.5, hz: 5, yaw: 0, style: "runout" });
  emitBox(solids, straight, cursor,
    { x: 0, y: 2, z: 10.5, hx: 11, hy: 2, hz: 0.5, yaw: 0, style: "wall" });

  const courseLength = travelled;
  const pathCum: number[] = [0];
  for (let i = 1; i < path.length; i++) {
    const dx = path[i].x - path[i - 1].x;
    const dz = path[i].z - path[i - 1].z;
    pathCum.push(pathCum[i - 1] + Math.sqrt(dx * dx + dz * dz));
  }

  // Collect's tokens, strung along the centre-line and pushed off it, so each
  // one is a genuine detour rather than something collected by running.
  const tokens = options.tokens ?? 0;
  for (let i = 0; i < tokens; i++) {
    const along = travelled * ((i + 1) / (tokens + 1));
    let at = 1;
    while (at < pathCumOf(path).length - 1 && pathCumOf(path)[at] < along + 12) { at++; }
    const p = path[Math.min(at, path.length - 1)];
    const side = i % 2 === 0 ? -1 : 1;
    breakers.push({
      id: nextId++, slot: breakerCount++,
      x: p.x + side * (4 + (i % 3) * 1.5), y: p.y + 2.4, z: p.z,
      hx: 0.75, hy: 0.75, hz: 0.75, yaw: 0,
      effect: "pod", style: "pod",
    });
  }

  notes.unshift(order.map((d) => d.title).join(" → "));
  for (const note of mutatorNotes(mutators)) { notes.unshift(note); }

  // Rush hour is applied here rather than inside the sections: a period is a
  // property of a piece of course, and scaling every one of them in one place
  // is both cheaper and impossible to forget in a new section.
  if (mutators.includes("rushhour")) {
    for (const ob of obstacles) {
      if (ob.period !== undefined) { ob.period *= 0.75; }
      if (ob.scanPeriod !== undefined) { ob.scanPeriod *= 0.75; }
      if (ob.speed !== undefined) { ob.speed /= 0.75; }
    }
  }

  const level: Level = {
    seed,
    solids, ramps, obstacles, checkpoints, plates, decor, anchors, breakers,
    pickups, spawns,
    finish,
    finishGroundY: cursor.y,
    spawn: { x: 0, y: 0.05, z: -14 },
    spawnYaw: 0,
    path, pathLength: pathCum[pathCum.length - 1], pathCum,
    crumbleCount,
    breakerCount,
    pickupCount,
    shellCount,
    sections: placements,
    courseLength,
    verbs: verbList.slice(),
    tuning: applyTuning(baseTuning(), mutators),
    mutators: mutators.slice(),
    notes,
  };

  return mutators.includes("mirror") ? mirrorLevel(level) : level;

  // ----------------------------------------------------------------- helpers
  /** Transform everything one section emitted into world space. */
  function emit(result: SectionResult, warp: Warp, cur: Cursor) {
    for (const s of result.solids) { emitBox(solids, warp, cur, s); }
    for (const d of result.decor) { emitBox(decor, warp, cur, d); }
    for (const r of result.ramps) {
      place(warp, cur, r.x, 0, r.z, scratch);
      ramps.push({
        ...r,
        x: scratch.x, z: scratch.z,
        y0: r.y0 + cur.y, y1: r.y1 + cur.y,
        yaw: warpYaw + r.yaw,
      });
    }
    for (const ob of result.obstacles) { obstacles.push(emitObstacle(warp, cur, ob)); }
    for (const p of result.plates) {
      plates.push({ ...p, volume: emitVolume(warp, cur, p.volume) });
    }
    for (const a of result.anchors) {
      place(warp, cur, a.x, a.y, a.z, scratch);
      anchors.push({ id: a.id, x: scratch.x, y: scratch.y, z: scratch.z });
    }
    for (const b of result.breakers) {
      place(warp, cur, b.x, b.y, b.z, scratch);
      breakers.push({ ...b, x: scratch.x, y: scratch.y, z: scratch.z, yaw: warpYaw + b.yaw });
    }
    for (const pk of result.pickups) {
      place(warp, cur, pk.x, pk.y, pk.z, scratch);
      pickups.push({ ...pk, x: scratch.x, y: scratch.y, z: scratch.z });
    }
    for (const sp of result.spawns) {
      place(warp, cur, sp.x, sp.y, sp.z, scratch);
      spawns.push({ ...sp, x: scratch.x, y: scratch.y, z: scratch.z });
    }
  }

  function emitBox(into: SolidBox[], warp: Warp, cur: Cursor, s: SolidBox) {
    place(warp, cur, s.x, s.y, s.z, scratch);
    into.push({ ...s, x: scratch.x, y: scratch.y, z: scratch.z, yaw: warpYaw + s.yaw });
  }

  function emitVolume(warp: Warp, cur: Cursor, v: Volume): Volume {
    place(warp, cur, v.x, v.y, v.z, scratch);
    return { ...v, x: scratch.x, y: scratch.y, z: scratch.z, yaw: warpYaw + v.yaw };
  }

  function emitObstacle(warp: Warp, cur: Cursor, ob: Obstacle): Obstacle {
    place(warp, cur, ob.px, ob.py, ob.pz, scratch);
    const out: Obstacle = {
      ...ob,
      px: scratch.x, py: scratch.y, pz: scratch.z,
      baseYaw: warpYaw + (ob.baseYaw ?? 0),
    };
    if (ob.a) {
      place(warp, cur, ob.a.x, ob.a.y, ob.a.z, scratch);
      out.a = { x: scratch.x, y: scratch.y, z: scratch.z };
    }
    if (ob.b) {
      place(warp, cur, ob.b.x, ob.b.y, ob.b.z, scratch);
      out.b = { x: scratch.x, y: scratch.y, z: scratch.z };
    }
    return out;
  }
}

/**
 * The same course, reflected.
 *
 * Reflection is an isometry with a sign flip, so *everything* angular has to
 * flip with it: a yaw, a baked-in `baseYaw`, a spinner's direction, a hinge's
 * swept angles, an arc's turn. Missing one leaves a door lying across the track
 * it used to lie along, and it would read as a level bug rather than as the one
 * missing negation it is. Applied to the finished level rather than threaded
 * through the emitters, because doing it once at the end is provably total.
 */
function mirrorLevel(level: Level): Level {
  const point = <T extends { x: number; z: number }>(p: T): T => {
    p.x = -p.x;
    return p;
  };
  const yawed = <T extends { x: number; z: number; yaw: number }>(b: T): T => {
    b.x = -b.x;
    b.yaw = -b.yaw;
    return b;
  };

  level.solids.forEach(yawed);
  level.decor.forEach(yawed);
  level.ramps.forEach(yawed);
  level.anchors.forEach(point);
  level.breakers.forEach(yawed);
  level.pickups.forEach(point);
  level.spawns.forEach(point);
  level.path.forEach(point);
  level.spawn.x = -level.spawn.x;
  level.spawnYaw = -level.spawnYaw;
  yawed(level.finish);

  for (const cp of level.checkpoints) {
    yawed(cp.volume);
    cp.spawn.x = -cp.spawn.x;
    cp.yaw = -cp.yaw;
  }
  for (const plate of level.plates) { yawed(plate.volume); }

  for (const ob of level.obstacles) {
    ob.px = -ob.px;
    if (ob.a) { ob.a.x = -ob.a.x; }
    if (ob.b) { ob.b.x = -ob.b.x; }
    if (ob.baseYaw !== undefined) { ob.baseYaw = -ob.baseYaw; }
    if (ob.speed !== undefined) { ob.speed = -ob.speed; }
    if (ob.scan !== undefined) { ob.scan = -ob.scan; }
    if (ob.closedYaw !== undefined) { ob.closedYaw = -ob.closedYaw; }
    if (ob.openYaw !== undefined) { ob.openYaw = -ob.openYaw; }
    if (ob.muzzlePitch !== undefined) { /* pitch is unaffected by a reflection */ }
    if (ob.amplitude !== undefined) { ob.amplitude = -ob.amplitude; }
  }

  for (const s of level.sections) {
    s.x = -s.x;
    s.yaw = -s.yaw;
    s.turn = -s.turn;
  }
  return level;
}

/**
 * Width of the ground a section builds where it meets a gate.
 *
 * Measured rather than declared, because a gate width is one of three values
 * and real track is whatever the section wanted it to be.
 */
function gateSpan(result: SectionResult, z: number): number {
  let half = 0;
  for (const s of result.solids) {
    if (s.z - s.hz <= z + 0.01 && s.z + s.hz >= z - 0.01) {
      const reach = Math.abs(s.x) + s.hx;
      if (reach > half) { half = reach; }
    }
  }
  return half * 2;
}

/** Bank plus checkpoint: the hazard-free link the generator drops at a join. */
function emitBank(
  solids: SolidBox[], checkpoints: Checkpoint[], cur: Cursor,
  width: number, label: string, index: number,
) {
  const c = Math.cos(cur.yaw), s = Math.sin(cur.yaw);
  const at = (lx: number, lz: number) =>
    ({ x: cur.x + lx * c - lz * s, z: cur.z + lx * s + lz * c });

  const centre = at(0, BANK_DEPTH / 2);
  solids.push({
    x: centre.x, y: cur.y - 0.5, z: centre.z,
    hx: width / 2, hy: 0.5, hz: BANK_DEPTH / 2 + 0.6, yaw: cur.yaw, style: "pad",
  });
  const spawn = at(0, BANK_DEPTH * 0.35);
  checkpoints.push({
    index,
    volume: {
      x: centre.x, y: cur.y + 1.6, z: centre.z,
      hx: width / 2 - 1, hy: 2, hz: BANK_DEPTH / 2, yaw: cur.yaw,
    },
    spawn: { x: spawn.x, y: cur.y + 0.05, z: spawn.z },
    yaw: cur.yaw,
    label,
  });
}

/** Cumulative arc length along a path. Used when scattering Collect's tokens. */
function pathCumOf(path: readonly Vec3[]): number[] {
  const cum: number[] = [0];
  for (let i = 1; i < path.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z));
  }
  return cum;
}

/** Append a path vertex, skipping duplicates so `pathCum` never stalls. */
function pushPath(path: Vec3[], p: Vec3) {
  const last = path[path.length - 1];
  if (last && Math.abs(last.x - p.x) < 1e-9 && Math.abs(last.z - p.z) < 1e-9) { return; }
  path.push({ x: p.x, y: p.y, z: p.z });
}

/**
 * Pick which way a turning section bends.
 *
 * The draw decides, then two rules can veto it: the course may not wind past a
 * half turn cumulatively, and a bend that would bring the course back within
 * `MIN_SELF_CLEARANCE` of track already laid is flipped. Both are functions of
 * the seed alone, so both ends of the wire agree.
 */
function chooseTurn(
  rand: () => number, cur: Cursor, heading: number,
  def: SectionDef, size: number, path: readonly Vec3[], lookahead: number,
): number {
  const sign = rand() < 0.5 ? 1 : -1;
  // The draw first, then its mirror, then not turning at all. Running straight
  // is always legal and is exactly what every earlier turn assumed the rest of
  // the course would do, which is what makes the guarantee hold: a later turn
  // can always fall back to the shape its predecessor was judged against.
  const options = [sign * size, -sign * size, 0];

  let best = 0;
  let bestRoom = -Infinity;
  for (const turn of options) {
    if (turn !== 0 && Math.abs(heading + turn) > MAX_HEADING) { continue; }
    const room = clearance(cur, def, turn, path, lookahead);
    if (room >= MIN_SELF_CLEARANCE) { return turn; }
    if (room > bestRoom) { bestRoom = room; best = turn; }
  }
  return best;
}

/**
 * Closest approach between a candidate bend and the course already laid.
 *
 * The probe does not stop at the section's exit gate: it carries straight on
 * for everything still to be built, because a bend that only just clears is a
 * bend whose run-out lands on top of the course two sections later. Assuming
 * the remainder runs straight is pessimistic in the right direction - later
 * turns are chosen under this same rule, and one of the options they always
 * have is to run straight, which is exactly what was assumed here.
 *
 * Pairs are excluded by the gap in **arc length** between them, not by how far
 * back along the path the older one sits. Those are not the same thing once the
 * course can turn: two right angles bring the course back within fifteen units
 * of a leg that is only a hundred units behind it, and a fixed "ignore the last
 * sixty units of path" window hides exactly the crossing that matters.
 */
function clearance(
  cur: Cursor, def: SectionDef, turn: number, path: readonly Vec3[], lookahead: number,
): number {
  const warp = makeWarp(def.length, turn);
  const probe: Vec3 = { x: 0, y: 0, z: 0 };
  if (path.length < 2) { return Infinity; }

  const cum: number[] = [0];
  for (let i = 1; i < path.length; i++) {
    const dx = path[i].x - path[i - 1].x;
    const dz = path[i].z - path[i - 1].z;
    cum.push(cum[i - 1] + Math.sqrt(dx * dx + dz * dz));
  }
  const base = cum[cum.length - 1];

  let worst = Infinity;
  const total = def.length + lookahead;
  const steps = Math.max(8, Math.ceil(total / 6));
  for (let i = 1; i <= steps; i++) {
    const local = total * (i / steps);
    if (local <= def.length) {
      place(warp, cur, 0, 0, local, probe);
    } else {
      place(warp, cur, 0, 0, def.length, probe);
      const exitYaw = cur.yaw + turn;
      const run = local - def.length;
      probe.x -= run * Math.sin(exitYaw);
      probe.z += run * Math.cos(exitYaw);
    }
    const reach = base + local - SELF_CLEARANCE_TAIL;
    for (let j = 0; j < path.length && cum[j] <= reach; j++) {
      const dx = probe.x - path[j].x;
      const dz = probe.z - path[j].z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < worst) { worst = d; }
    }
  }
  return worst;
}
