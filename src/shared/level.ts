/**
 * The course, as data.
 *
 * `buildLevel(seed)` is a pure function: the server puts one integer in the room
 * state and every client rebuilds a bit-identical course from it - geometry,
 * obstacle phases and the per-round variant alike. Nothing about the level is
 * ever sent over the wire beyond that seed.
 */

import { mulberry32 } from "./math.js";
import { TICK_RATE } from "./constants.js";

export interface Vec3 { x: number; y: number; z: number }

/** A yaw-rotated solid box. Half-extents, because that is what collision wants. */
export interface SolidBox {
  x: number; y: number; z: number;
  hx: number; hy: number; hz: number;
  yaw: number;
  style: string;
}

/** A one-way sloped floor: a walkable surface rising linearly along +Z. */
export interface Ramp {
  x: number; z: number;
  hx: number; hz: number;
  y0: number; y1: number;
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
  /** Index into the room's crumble-state array. Set for `crumble` only. */
  slot?: number;
}

/** An axis-aligned trigger volume. */
export interface Volume {
  x: number; y: number; z: number;
  hx: number; hy: number; hz: number;
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

export interface Level {
  seed: number;
  solids: SolidBox[];
  ramps: Ramp[];
  obstacles: Obstacle[];
  checkpoints: Checkpoint[];
  plates: Plate[];
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
  /** Human-readable summary of what this round's variant changed. */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Timing shared with the room: how a crumble platform behaves once triggered.
// ---------------------------------------------------------------------------

/** Ticks between "someone stood on it" and "it drops". */
export const CRUMBLE_DELAY_TICKS = 17;   // ~0.55s
/** Ticks the gap stays open before the platform snaps back. */
export const CRUMBLE_GONE_TICKS = 135;   // ~4.5s
/** Seconds a pressure plate stays hot after the last player steps off it. */
export const PLATE_HOLD_SECONDS = 8;

export const START_GATE_STYLE = "gate";

// ---------------------------------------------------------------------------

export function buildLevel(seed: number): Level {
  const rand = mulberry32(seed || 1);
  const notes: string[] = [];

  const solids: SolidBox[] = [];
  const ramps: Ramp[] = [];
  const obstacles: Obstacle[] = [];
  const checkpoints: Checkpoint[] = [];
  const plates: Plate[] = [];
  let nextId = 1;
  let crumbleCount = 0;

  /** A floor slab whose walkable surface sits at `topY`. */
  const floor = (x: number, z: number, sx: number, sz: number, topY = 0, style = "track", yaw = 0) => {
    solids.push({ x, y: topY - 0.5, z, hx: sx / 2, hy: 0.5, hz: sz / 2, yaw, style });
  };
  /** A wall standing on `baseY`. */
  const wall = (x: number, z: number, sx: number, sy: number, sz: number, baseY = 0, style = "wall", yaw = 0) => {
    solids.push({ x, y: baseY + sy / 2, z, hx: sx / 2, hy: sy / 2, hz: sz / 2, yaw, style });
  };
  const vol = (x: number, y: number, z: number, sx: number, sy: number, sz: number): Volume =>
    ({ x, y, z, hx: sx / 2, hy: sy / 2, hz: sz / 2 });

  // ======================================================== 0. LOBBY / STAGING
  floor(0, -12, 26, 24, 0, "lobby");
  wall(-13.5, -12, 1, 3, 24, 0, "wall");
  wall(13.5, -12, 1, 3, 24, 0, "wall");
  wall(0, -24.5, 28, 3, 1, 0, "wall");

  obstacles.push({
    id: nextId++, kind: "startgate", role: "solid", style: START_GATE_STYLE,
    size: { x: 26, y: 4, z: 0.7 }, px: 0, py: 2, pz: 0,
  });

  // ==================================================== 1. THE GAUNTLET (bars)
  floor(0, 23, 22, 46, 0, "track");

  // Sweep directions are re-rolled every round: sometimes the three bars chase
  // each other, sometimes they scissor.
  const barDirs = [rand() < 0.5 ? 1 : -1, rand() < 0.5 ? 1 : -1, rand() < 0.5 ? 1 : -1];
  // Tuned down from where this started. A 10-unit arm at 2.2 rad/s sweeps its
  // tip at 22 u/s - more than twice a runner's top speed, which reads as
  // unfair rather than hard. These give a rhythm you can actually watch and
  // time, ramping up across the three.
  const barSpeeds = [0.9, 1.25, 1.6];
  [12, 24, 36].forEach((z, i) => {
    obstacles.push({
      id: nextId++, kind: "spinner", role: "hazard", style: "bar",
      // Raised and thin enough that a 0.86u carving capsule can pass below,
      // while a standing capsule's middle still catches it. This is the first
      // course element that explicitly teaches Carve.
      size: { x: 20, y: 0.12, z: 1.2 },
      px: 0, py: 1.35, pz: z,
      speed: barSpeeds[i] * barDirs[i],
      phase: i * 0.31,
      // Enough to spoil a run, not enough to reliably clear a 22-wide track -
      // this is the section before anyone has banked a checkpoint.
      knock: 10,
    });
  });
  notes.push(barDirs[0] === barDirs[1] && barDirs[1] === barDirs[2]
    ? "Push bars sweeping in unison"
    : "Push bars sweeping against each other");

  floor(0, 50, 16, 10, 0, "pad");
  checkpoints.push({
    index: 0, volume: vol(0, 1.6, 50, 16, 4, 8),
    spawn: { x: 0, y: 0.05, z: 48 }, yaw: 0, label: "The Gauntlet",
  });

  // ============================================= 2. THE DRIFT (movers/crumble)
  const moverPeriod = 4.2;
  obstacles.push({
    id: nextId++, kind: "slider", role: "solid", style: "mover",
    size: { x: 7, y: 1, z: 7 },
    px: 0, py: -0.5, pz: 60,
    a: { x: -8, y: -0.5, z: 60 }, b: { x: 8, y: -0.5, z: 60 },
    period: moverPeriod, phase: 0,
  });
  obstacles.push({
    id: nextId++, kind: "slider", role: "solid", style: "mover",
    size: { x: 7, y: 1, z: 7 },
    px: 0, py: -0.5, pz: 68,
    a: { x: 8, y: -0.5, z: 68 }, b: { x: -8, y: -0.5, z: 68 },
    period: moverPeriod, phase: 0.5,
  });

  // Five stepping stones that give way. Their lateral pattern is re-rolled each
  // round, so the safe rhythm through the section is never quite the same.
  const crumbleLanes = [-2.4, 2.4, 0, -2.4, 2.4];
  for (let i = crumbleLanes.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const swap = crumbleLanes[i];
    crumbleLanes[i] = crumbleLanes[j];
    crumbleLanes[j] = swap;
  }
  crumbleLanes.forEach((x, i) => {
    obstacles.push({
      id: nextId++, kind: "crumble", role: "solid", style: "crumble",
      size: { x: 3.8, y: 1, z: 3.8 },
      px: x, py: -0.5, pz: 76 + i * 4.2,
      slot: crumbleCount++,
    });
  });

  floor(0, 100, 16, 10, 0, "pad");
  checkpoints.push({
    index: 1, volume: vol(0, 1.6, 100, 16, 4, 8),
    spawn: { x: 0, y: 0.05, z: 99 }, yaw: 0, label: "The Drift",
  });

  // ================================================= 3. PENDULUM PASS (bridge)
  floor(0, 128, 3.6, 46, 0, "bridge");

  // Phase spread decides whether the heads swing as a travelling wave or as a
  // single wall you have to thread in one go.
  const inSync = rand() < 0.35;
  const hammerSpread = inSync ? 0 : 0.27;
  const hammerPeriod = 2.4 + rand() * 0.7;
  [112, 122, 132, 142].forEach((z, i) => {
    obstacles.push({
      id: nextId++, kind: "pendulum", role: "hazard", style: "hammer",
      size: { x: 2.7, y: 2.7, z: 2.2 },
      px: 0, py: 9, pz: z,
      armLength: 7, amplitude: 1.08,
      period: hammerPeriod, phase: i * hammerSpread,
      knock: 13,
    });
  });
  notes.push(inSync ? "Pendulums swinging as one wall" : "Pendulums staggered into a wave");

  floor(0, 156, 16, 10, 0, "pad");
  checkpoints.push({
    index: 2, volume: vol(0, 1.6, 156, 16, 4, 8),
    spawn: { x: 0, y: 0.05, z: 155 }, yaw: 0, label: "Pendulum Pass",
  });

  // ============================================ 4. THE CAROUSEL (spin + walls)
  const rotSpeeds = [0.55, 0.72, 0.86];
  [168, 179, 190].forEach((z, i) => {
    obstacles.push({
      id: nextId++, kind: "rotator", role: "solid", style: "rotator",
      size: { x: 9, y: 1, z: 9 },
      px: 0, py: -0.5, pz: z,
      speed: rotSpeeds[i] * (rand() < 0.5 ? 1 : -1),
      phase: rand(),
    });
  });

  floor(0, 200, 18, 12, 0, "pad");
  // Two scissoring walls that shove players straight off the landing pad.
  obstacles.push({
    id: nextId++, kind: "slider", role: "solid", style: "pusher",
    size: { x: 5, y: 3.2, z: 1 },
    px: 0, py: 1.6, pz: 199,
    a: { x: -9, y: 1.6, z: 199 }, b: { x: 1, y: 1.6, z: 199 },
    period: 3.4, phase: 0,
  });
  obstacles.push({
    id: nextId++, kind: "slider", role: "solid", style: "pusher",
    size: { x: 5, y: 3.2, z: 1 },
    px: 0, py: 1.6, pz: 202,
    a: { x: 9, y: 1.6, z: 202 }, b: { x: -1, y: 1.6, z: 202 },
    period: 3.4, phase: 0.5,
  });

  checkpoints.push({
    index: 3, volume: vol(0, 1.6, 204.5, 18, 4, 3),
    spawn: { x: 0, y: 0.05, z: 204 }, yaw: 0, label: "The Carousel",
  });

  // ================================================== 5. THE FORK (two routes)
  wall(0, 226, 0.8, 3, 38, 0, "divider");

  // -- left route: three doors on a timed cycle -------------------------------
  floor(-5, 226, 8, 38, 0, "lane");
  wall(-9.4, 226, 0.8, 3, 38, 0, "divider");
  const doorPeriod = 3.8 + rand() * 1.4;
  [214, 226, 238].forEach((z, i) => {
    obstacles.push({
      id: nextId++, kind: "door", role: "solid", style: "door",
      size: { x: 8, y: 3.4, z: 0.7 },
      px: -5, py: 1.7, pz: z,
      period: doorPeriod, phase: i * 0.34, openFraction: 0.42,
    });
  });

  // -- right route: a plate-driven swing bridge over a gap --------------------
  floor(6.5, 214, 11, 14, 0, "lane");
  floor(6.5, 238, 11, 12, 0, "lane");
  wall(12.4, 226, 0.8, 3, 38, 0, "divider");

  const bridgeArmed = rand() < 0.72;
  plates.push({
    id: 0, volume: vol(6.5, 0.7, 210, 4, 1.8, 4),
    activation: "hold", holdTicks: Math.round(PLATE_HOLD_SECONDS * TICK_RATE), label: "Bridge",
  });
  solids.push({
    x: 6.5, y: -0.1, z: 210, hx: 2, hy: 0.2, hz: 2, yaw: 0,
    style: bridgeArmed ? "plate" : "plate-dead",
  });
  // The first hand-authored Heavy target. It is only fired by an Impact
  // shockwave, never by merely standing on it, so it teaches the distinction.
  plates.push({
    id: 1, volume: vol(0, 0.25, 54, 5, 0.5, 5), activation: "heavy",
    holdTicks: TICK_RATE, label: "Impact Plate",
  });
  solids.push({ x: 0, y: -0.08, z: 54, hx: 2.5, hy: 0.08, hz: 2.5, yaw: 0, style: "impact-plate" });
  if (bridgeArmed) {
    obstacles.push({
      id: nextId++, kind: "hinge", role: "solid", style: "swingbridge",
      size: { x: 3.2, y: 0.8, z: 11 },
      px: 6.5, py: -0.4, pz: 221.5,
      offsetZ: 5.5,
      closedYaw: -Math.PI / 2, openYaw: 0,
      plate: 0,
    });
    notes.push("Swing bridge armed - hit the plate to open the right route");
  } else {
    notes.push("Swing bridge offline - the doors are the only way through");
  }

  floor(0, 249, 24, 10, 0, "pad");

  // ======================================================= 6. THE CLIMB (ramp)
  ramps.push({ x: 0, z: 261, hx: 8, hz: 7, y0: 0, y1: 4.5, style: "ramp" });
  wall(-8.4, 261, 0.8, 5.5, 14, 0, "wall");
  wall(8.4, 261, 0.8, 5.5, 14, 0, "wall");
  floor(0, 280, 16, 24, 4.5, "top");

  // [z, y, period] - low sweepers you jump, climbing with the ramp.
  const sweeperSpecs: Array<[number, number, number]> = [
    [259, 2.25, 2.3],
    [265, 4.05, 1.95],
    [275, 5.15, 2.5],
  ];
  sweeperSpecs.forEach(([z, y, period], i) => {
    const flip = rand() < 0.5;
    obstacles.push({
      id: nextId++, kind: "slider", role: "hazard", style: "sweeper",
      size: { x: 4.2, y: 1.5, z: 1.2 },
      px: 0, py: y, pz: z,
      a: { x: flip ? 9 : -9, y, z }, b: { x: flip ? -9 : 9, y, z },
      period, phase: i * 0.37,
      knock: 12,
    });
  });

  const finish = vol(0, 6.5, 289, 16, 6, 3);
  floor(0, 297, 16, 12, 4.5, "runout");
  wall(0, 303.5, 18, 4, 1, 4.5, "wall");

  // ------------------------------------------------------------ progress path
  const path: Vec3[] = [
    { x: 0, y: 0, z: -12 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 46 },
    { x: 0, y: 0, z: 52 }, { x: 0, y: 0, z: 60 }, { x: 0, y: 0, z: 68 },
    { x: 0, y: 0, z: 84 }, { x: 0, y: 0, z: 100 }, { x: 0, y: 0, z: 128 },
    { x: 0, y: 0, z: 156 }, { x: 0, y: 0, z: 168 }, { x: 0, y: 0, z: 190 },
    { x: 0, y: 0, z: 204 }, { x: 0, y: 0, z: 226 }, { x: 0, y: 0, z: 249 },
    { x: 0, y: 0, z: 254 }, { x: 0, y: 2.25, z: 261 }, { x: 0, y: 4.5, z: 268 },
    { x: 0, y: 4.5, z: 289 },
  ];
  const pathCum: number[] = [0];
  for (let i = 1; i < path.length; i++) {
    const dx = path[i].x - path[i - 1].x;
    const dz = path[i].z - path[i - 1].z;
    pathCum.push(pathCum[i - 1] + Math.hypot(dx, dz));
  }

  return {
    seed,
    solids, ramps, obstacles, checkpoints, plates,
    finish,
    finishGroundY: 4.5,
    spawn: { x: 0, y: 0.05, z: -14 },
    spawnYaw: 0,
    path, pathLength: pathCum[pathCum.length - 1], pathCum,
    crumbleCount,
    notes,
  };
}

/** Ordered spawn slots inside the lobby, so nobody spawns inside anyone else. */
export function lobbySlot(index: number): { x: number; z: number } {
  const cols = 3;
  const col = index % cols;
  const row = Math.floor(index / cols);
  return { x: (col - 1) * 4.5, z: -17 + row * 4.5 };
}
