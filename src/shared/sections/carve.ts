/**
 * Sections built around Carve.
 *
 * All three put something at 0.95 u - the height a carving capsule (0.86 u)
 * clears and a running one (1.72 u) does not. That number is the verb, and it
 * is the same number in all three so a runner only has to learn it once.
 */

import { straightSpine } from "./build.js";
import type { SectionDef } from "./types.js";

/** Underside of a bar a carving capsule fits below and a standing one does not. */
export const CARVE_BAR_Y = 0.95;

// ===========================================================================
// 1 - The Gauntlet. Difficulty 2, opener, teaches Carve.
//
// Widening the track to 26 while the arms stay 20 leaves the outer 3 u
// unswept: a genuine fast lane with no railing, unless the variant rails it.
// The void is the price.
// ===========================================================================
export const gauntlet: SectionDef = {
  id: "gauntlet",
  title: "The Gauntlet",
  weight: 1.2,
  difficulty: 2,
  roles: ["opener"],
  requires: [],
  teaches: "carve",
  entry: { width: "wide", elevation: 0, turn: "straight" },
  exit: { width: "wide", elevation: 0, turn: "straight" },
  length: 46,

  build(ctx) {
    const d = [ctx.rand(), ctx.rand(), ctx.rand(), ctx.rand(), ctx.rand(), ctx.rand(), ctx.rand()];
    const bars = 2 + Math.floor(d[0] * 3);
    const dirs = [d[1], d[2], d[3], d[4]].map((v) => (v < 0.5 ? 1 : -1));
    const speedScale = 0.85 + d[5] * 0.3;
    const railed = d[6] < 0.35;

    const width = 26;
    ctx.track(width, 0, 46);
    if (railed) {
      ctx.wall(-width / 2 - 0.4, 23, 0.8, 1.4, 46, 0, "divider");
      ctx.wall(width / 2 + 0.4, 23, 0.8, 1.4, 46, 0, "divider");
    }

    // 16 u of clear approach, then the sweeps. The last pivot sits 12 u from
    // the exit gate because the arm is 20 u across: any closer and the tip
    // sweeps over the checkpoint bank, which has to stay hazard-free.
    for (let i = 0; i < bars; i++) {
      const t = i / (bars - 1);
      ctx.obstacle({
        kind: "spinner", role: "hazard", style: "bar",
        size: { x: 20, y: 0.12, z: 1.2 },
        px: 0, py: CARVE_BAR_Y, pz: 16 + 18 * t,
        speed: (0.9 + 0.7 * t) * speedScale * dirs[i],
        phase: i * 0.31,
        // Enough to spoil a run, not enough to reliably clear a 26-wide track.
        knock: 10,
      });
    }

    // Landmark: a gantry arch over the last bar, outside the swept radius.
    ctx.decor(-12.4, 4.5, 34, 1.2, 9, 1.2, "post");
    ctx.decor(12.4, 4.5, 34, 1.2, 9, 1.2, "post");
    ctx.decor(0, 9.4, 34, 26.8, 1.2, 1.2, "post");

    straightSpine(ctx, 46);
    ctx.note(dirs[0] === dirs[1] && dirs[1] === dirs[2]
      ? "Push bars sweeping in unison"
      : "Push bars sweeping against each other");
    if (railed) { ctx.note("Gauntlet fast lane railed"); }
  },
};

// ===========================================================================
// 13 - The Turnstile. Difficulty 2, middle or rest, teaches Carve.
//
// Each panel is a spinning cross of two solid arms a quarter cycle apart: a low
// wall you vault, and a high bar you carve under. Nothing here hurts - it costs
// time rather than lives, which is what keeps it usable as a rest beat
// even though it is full of moving parts.
// ===========================================================================
export const turnstile: SectionDef = {
  id: "turnstile",
  title: "The Turnstile",
  weight: 1,
  // Tagged 2, not the spec table's 3. The spec's own text calls it "a good rest
  // beat despite the difficulty tag", and with only one difficulty-2 middle in
  // the pool the pacing rule forced the Spiral into every single course.
  difficulty: 2,
  roles: ["middle", "rest"],
  requires: [],
  teaches: "carve",
  entry: { width: "standard", elevation: 0, turn: "straight" },
  exit: { width: "standard", elevation: 0, turn: "straight" },
  length: 40,

  build(ctx) {
    const d: number[] = [];
    for (let i = 0; i < 9; i++) { d.push(ctx.rand()); }
    const panels = 2 + Math.floor(d[0] * 3);

    ctx.track(16, 0, 40);

    for (let i = 0; i < panels; i++) {
      const z = panels === 1 ? 20 : 8 + 24 * (i / (panels - 1));
      const speed = (0.5 + 0.18 * i) * (d[1 + i] < 0.5 ? 1 : -1);
      const phase = d[5 + i];
      // The vault arm: knee height, so it stops a runner but never a jump.
      ctx.obstacle({
        kind: "rotator", role: "solid", style: "panel",
        size: { x: 11, y: 1.2, z: 0.6 }, px: 0, py: 0.6, pz: z,
        speed, phase,
      });
      // The carve arm, a quarter turn away: its underside is the verb.
      ctx.obstacle({
        kind: "rotator", role: "solid", style: "panel",
        size: { x: 11, y: 1.3, z: 0.6 },
        px: 0, py: CARVE_BAR_Y + 0.65, pz: z,
        speed, phase: phase + 0.25,
      });
    }

    // One pod, outside the 5.5 u the panels sweep: the other section that can
    // be a course's rest beat also has to be somewhere coins exist.
    ctx.breaker({
      x: 6.6, y: 3, z: 20, hx: 0.75, hy: 0.75, hz: 0.75,
      yaw: 0, effect: "pod", style: "pod",
    });

    ctx.decor(9.4, 5.5, 20, 3, 11, 3, "post");
    straightSpine(ctx, 40);
    ctx.note(`Turnstile running ${panels} panels`);
  },
};

// ===========================================================================
// 11 - The Watchtower. Difficulty 3, middle, teaches Carve.
//
// Two towers over an open approach, on a 90 degree corner. The beams sweep the
// inside of the turn and the turret only reaches the inside too, so the flank
// is the outside of the corner: safe, and longer for exactly that reason. No
// extra geometry is needed to make that trade - the turn itself is the cost.
//
// It is also where the Watchers live. A sentry beam that stuns rather than
// launches, a turret firing across the lane on a fixed cycle, a hunter
// patrolling with a searching sweep, and a Lurcher waiting on the flank. Every
// one of them is a pure function of tick except the Lurcher, and the Lurcher
// moves on a committed arc - so the whole section costs four numbers on the
// wire and none of them change unless it decides something.
// ===========================================================================
export const watchtower: SectionDef = {
  id: "watchtower",
  title: "The Watchtower",
  weight: 1,
  difficulty: 3,
  roles: ["middle"],
  requires: [],
  teaches: "carve",
  entry: { width: "wide", elevation: 0, turn: "straight" },
  exit: { width: "standard", elevation: 0, turn: "corner" },
  length: 48,

  build(ctx) {
    const d: number[] = [];
    for (let i = 0; i < 8; i++) { d.push(ctx.rand()); }
    const beams = 1 + Math.floor(d[0] * 2);      // 1..2 sweeping towers
    const beamPeriod = 0.62 + d[1] * 0.26;       // rad/s, not seconds
    const turretPeriod = 2.2 + d[2] * 0.9;

    ctx.track(24, 0, 48);

    for (let i = 0; i < beams; i++) {
      ctx.obstacle({
        kind: "spinner", role: "hazard", style: "beam",
        size: { x: 16, y: 0.14, z: 0.9 },
        px: -2, py: CARVE_BAR_Y, pz: 18 + i * 14,
        speed: (beamPeriod + i * 0.14) * (d[3 + i] < 0.5 ? 1 : -1),
        phase: i * 0.4,
        // A beam stuns rather than deletes: it costs Chain and seconds.
        knock: 6,
      });
    }

    // The hunter. Mechanically a slider on a fixed patrol - it is a slider with
    // better art, and the spec says so - but the searching sweep is what makes
    // it read as looking for you rather than as machinery going back and forth.
    // Its arc stops at x 4, so the outer three metres of the corner stay clear.
    ctx.obstacle({
      kind: "slider", role: "hazard", style: "hunter",
      size: { x: 3.4, y: 1.4, z: 1 },
      px: -3.5, py: 1.5, pz: 33,
      a: { x: -11, y: 1.5, z: 33 }, b: { x: 4, y: 1.5, z: 33 },
      period: turretPeriod, phase: d[5],
      scan: 0.55, scanPeriod: 2.1 + d[6] * 0.6,
      knock: 8,
    });

    // The sentry. It stuns and does not launch, so it costs seconds and a
    // Chain rather than a place on the course - the one hazard in the pool
    // that slows a runner down instead of throwing them somewhere.
    ctx.obstacle({
      kind: "sentry", role: "hazard", style: "sentry", stunOnly: true,
      size: { x: 0.6, y: 0.5, z: 16 },
      px: -10, py: 1.3, pz: 26,
      baseYaw: Math.PI / 2,
      armLength: 8, amplitude: 0.62 + d[7] * 0.2,
      period: 3.2 + d[3] * 0.9, phase: d[4],
    });

    // The turret, firing *across* the lane rather than along it. A crossing
    // shell is a timing gate; a shell fired down the track would simply follow
    // the runner into the next section.
    ctx.obstacle({
      kind: "turret", role: "hazard", style: "shell",
      size: { x: 0.9, y: 0.9, z: 0.9 },
      px: -11, py: 3.2, pz: 40,
      baseYaw: Math.PI / 2,
      muzzleSpeed: 20, muzzlePitch: 0.5,
      period: 2.9 + d[6] * 0.8, phase: 0.3,
      knock: 11,
      shell: ctx.nextShellSlot(),
    });
    ctx.decor(-11.6, 3.2, 40, 1.8, 1.8, 1.8, "post");

    // A Lurcher on the flank: the safe line is longer, and now it is watched.
    ctx.enemy(1, 9, 0, 30);

    for (let i = 0; i < beams; i++) {
      ctx.decor(-11, 6, 18 + i * 14, 4, 12, 4, "post");
    }
    straightSpine(ctx, 48);
    ctx.note(beams > 1 ? "Both watchtowers manned" : "One watchtower dark");
  },
};
