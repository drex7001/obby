/**
 * Sections built around the jump.
 *
 * The Carousel and the Spiral are both platform sequences over a void; the
 * Climb is the section every course ends on, and the only one that is uphill.
 */

import { straightSpine } from "./build.js";
import type { SectionDef } from "./types.js";
import { CARVE_BAR_Y } from "./carve.js";

// ===========================================================================
// 4 - The Carousel. Difficulty 3, middle, teaches the jump.
//
// The first section that turns. Rotators carry momentum, and a pusher taken
// from behind while it travels your way pays a few units of overspeed that fall
// straight out of the soft cap - a hazard turned into a tool.
// ===========================================================================
export const carousel: SectionDef = {
  id: "carousel",
  title: "The Carousel",
  weight: 1,
  difficulty: 3,
  roles: ["middle"],
  requires: [],
  teaches: "vault",
  entry: { width: "standard", elevation: 0, turn: "straight" },
  exit: { width: "wide", elevation: 0, turn: "corner" },
  length: 44,

  build(ctx) {
    const d: number[] = [];
    for (let i = 0; i < 11; i++) { d.push(ctx.rand()); }
    // Two or three, not the spec's two to four: a 9 u rotator needs 9.6 u of
    // pitch, and a fourth would land on the exit pad.
    const rotators = 2 + Math.floor(d[0] * 2);
    const pusherPeriod = 3.1 + d[9] * 0.7;
    const pitch = 9.6 + d[10] * 0.8;

    ctx.track(14, 0, 4);

    const speeds = [0.55, 0.72, 0.86];
    for (let i = 0; i < rotators; i++) {
      ctx.obstacle({
        kind: "rotator", role: "solid", style: "rotator",
        size: { x: 9, y: 1, z: 9 },
        px: 0, py: -0.5, pz: 9 + i * pitch,
        speed: speeds[i] * (d[1 + i] < 0.5 ? 1 : -1),
        phase: d[5 + i],
      });
      // A short column under each rotator, so the eye has an axis to read the
      // spin against.
      ctx.decor(0, -3, 9 + i * pitch, 1.6, 5, 1.6, "post");
    }

    ctx.track(20, 33, 44, 0, "pad");

    // Two scissoring walls that shove runners straight off the landing pad.
    ctx.obstacle({
      kind: "slider", role: "solid", style: "pusher",
      size: { x: 5, y: 3.2, z: 1 },
      px: 0, py: 1.6, pz: 38,
      a: { x: -9, y: 1.6, z: 38 }, b: { x: 1, y: 1.6, z: 38 },
      period: pusherPeriod, phase: 0,
    });
    ctx.obstacle({
      kind: "slider", role: "solid", style: "pusher",
      size: { x: 5, y: 3.2, z: 1 },
      px: 0, py: 1.6, pz: 41,
      a: { x: 9, y: 1.6, z: 41 }, b: { x: -1, y: 1.6, z: 41 },
      period: pusherPeriod, phase: 0.5,
    });

    // Landmark: a central column running through the whole rotator field.
    ctx.decor(0, 7, 9 + ((rotators - 1) * pitch) / 2, 2.4, 14, 2.4, "post");

    straightSpine(ctx, 44);
    ctx.note(`Carousel on ${rotators} rotators`);
  },
};

// ===========================================================================
// 7 - The Spiral. Difficulty 2, middle, teaches the jump.
//
// An ascending helix wrapping a central column, climbing 8 u while turning
// through 180 degrees. Follow the turn, or cut the corner by jumping the
// chord. This is the section that proves the turning cursor: a course that
// turns feels twice the size of one that does not.
// ===========================================================================
export const spiral: SectionDef = {
  id: "spiral",
  title: "The Spiral",
  weight: 1.1,
  difficulty: 2,
  roles: ["middle"],
  requires: [],
  teaches: "vault",
  entry: { width: "standard", elevation: 0, turn: "straight" },
  exit: { width: "standard", elevation: 8, turn: "about" },
  length: 44,

  build(ctx) {
    const d: number[] = [];
    for (let i = 0; i < 25; i++) { d.push(ctx.rand()); }
    const count = 8 + Math.floor(d[0] * 5);      // 8..12

    // The helix wraps the arc's own centre of curvature. `turn` is signed, so
    // this lands the column on the inside of the turn whichever way it bends.
    const radius = Math.abs(ctx.turn) > 1e-9 ? 44 / ctx.turn : 0;
    const columnX = radius !== 0 ? -radius : -16;

    for (let i = 0; i < count; i++) {
      const t = i / (count - 1);
      const z = 2 + 40 * t;
      const y = 8 * t;
      const x = (i % 2 === 0 ? -1 : 1) * 3;
      // The helix has to reach both gates or it leaves a hole where the
      // checkpoint bank meets it - but a platform that reaches a bank must not
      // MOVE, or a runner standing on the bank is picked up and swung around
      // the platform's axis. A 6 u square sweeps a 4.24 u radius, so six units
      // of clearance is what keeps a spinning one out of the bank entirely.
      const clearOfBanks = z >= 6 && z <= 38;
      if (clearOfBanks && d[1 + i] < 0.42) {
        ctx.obstacle({
          kind: "rotator", role: "solid", style: "rotator",
          size: { x: 6, y: 1, z: 6 },
          px: x, py: y - 0.5, pz: z,
          speed: 0.4 * (d[13 + i] < 0.5 ? 1 : -1),
          phase: d[13 + i],
        });
      } else {
        ctx.floor(x, z, 8, 5, y);
      }
    }

    ctx.decor(columnX, 11, 22, 7, 22, 7, "post");

    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      ctx.spine(0, 8 * t, 44 * t);
    }
    ctx.note(`Spiral of ${count} platforms`);
  },
};

// ===========================================================================
// 6 - The Climb. Difficulty 3, always last.
//
// Genuinely uphill now that slopes charge, so arriving with overspeed is worth
// seconds and the whole preceding section matters. The last sweeper sits at
// carve height rather than vault height, mixing both verbs at the climax.
// ===========================================================================
export const climb: SectionDef = {
  id: "climb",
  title: "The Climb",
  weight: 1,
  difficulty: 3,
  roles: ["climb"],
  requires: [],
  teaches: "vault",
  entry: { width: "wide", elevation: 0, turn: "straight" },
  exit: { width: "wide", elevation: 4, turn: "straight" },
  length: 38,

  build(ctx) {
    const d = [ctx.rand(), ctx.rand(), ctx.rand(), ctx.rand(), ctx.rand(), ctx.rand(), ctx.rand()];
    const sweepers = 2 + Math.floor(d[0] * 3);   // 2..4
    const periodScale = 0.88 + d[5] * 0.28;
    const rampLength = 12 + Math.round(d[6] * 4);

    ctx.ramp({
      x: 0, z: rampLength / 2, hx: 8, hz: rampLength / 2,
      y0: 0, y1: 4, style: "ramp",
    });
    ctx.wall(-8.4, rampLength / 2, 0.8, 5.5, rampLength, 0);
    ctx.wall(8.4, rampLength / 2, 0.8, 5.5, rampLength, 0);
    ctx.track(16, rampLength, 38, 4, "top");

    /** Walkable height at a point along the section. */
    const surface = (z: number) => (z >= rampLength ? 4 : (4 * z) / rampLength);

    for (let i = 0; i < sweepers; i++) {
      const z = 6 + i * 7;
      const last = i === sweepers - 1;
      // Vault sweepers sit on the surface; the last one sits at carve height.
      const bottom = surface(z) + (last ? CARVE_BAR_Y : 0.05);
      const y = bottom + 0.75;
      const flip = d[1 + i] < 0.5;
      ctx.obstacle({
        kind: "slider", role: "hazard", style: "sweeper",
        size: { x: 4.2, y: 1.5, z: 1.2 },
        px: 0, py: y, pz: z,
        a: { x: flip ? 9 : -9, y, z }, b: { x: flip ? -9 : 9, y, z },
        period: (2.5 - i * 0.18) * periodScale, phase: i * 0.37,
        knock: 12,
      });
    }

    // Landmark: the finish gantry, deliberately tall enough to be picked out
    // three sections back.
    ctx.decor(-9, 10, 36, 1.4, 12, 1.4, "post");
    ctx.decor(9, 10, 36, 1.4, 12, 1.4, "post");
    ctx.decor(0, 15.6, 36, 19.4, 1.4, 1.4, "post");

    ctx.spine(0, 0, 0);
    for (let i = 1; i <= 4; i++) {
      const z = (rampLength * i) / 4;
      ctx.spine(0, surface(z), z);
    }
    ctx.spine(0, 4, 38);
    ctx.note(`Climb with ${sweepers} sweepers, last one a carve`);
  },
};
