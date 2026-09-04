/**
 * Sections built around the Tether.
 *
 * Anchors are placed as level content now, before the verb that uses them
 * exists: authoring a section twice is how a pool ends up inconsistent. Only
 * the Chasm actually *requires* the tether - Pendulum Pass stays completable on
 * foot, which is why it is the one that can be selected today.
 */

import { straightSpine } from "./build.js";
import type { SectionDef } from "./types.js";

// ===========================================================================
// 3 - Pendulum Pass. Difficulty 4, middle, teaches the Tether.
//
// The hardest section in the pool, and it should stay that way: a narrow deck,
// a void either side, and four heads to thread. The anchors on the pivot
// housings are what make it a Tether section - swing the deck entirely, timed
// against the heads, at the cost of a Chain level to attach.
// ===========================================================================
export const pendulum: SectionDef = {
  id: "pendulum",
  title: "Pendulum Pass",
  weight: 0.8,
  difficulty: 4,
  roles: ["middle"],
  requires: [],
  teaches: "tether",
  entry: { width: "narrow", elevation: 0, turn: "straight" },
  exit: { width: "standard", elevation: 0, turn: "straight" },
  length: 46,

  build(ctx) {
    const d = [ctx.rand(), ctx.rand(), ctx.rand(), ctx.rand(), ctx.rand()];
    const heads = 3 + Math.floor(d[0] * 3);      // 3..5
    const inSync = d[1] < 0.35;
    const period = 2.4 + d[2] * 0.7;
    const amplitude = 0.98 + d[3] * 0.2;
    const deck = 3.2 + d[4] * 1.2;

    ctx.track(deck, 0, 46, 0, "bridge");

    const spread = inSync ? 0 : 0.27;
    for (let i = 0; i < heads; i++) {
      const z = heads === 1 ? 23 : 7 + 32 * (i / (heads - 1));
      ctx.obstacle({
        kind: "pendulum", role: "hazard", style: "hammer",
        size: { x: 2.7, y: 2.7, z: 2.2 },
        px: 0, py: 9, pz: z,
        armLength: 7, amplitude,
        period, phase: i * spread,
        knock: 13,
      });
      // Five heads are a legal variant; four anchors are the budget, so the
      // last head in a five-head round is the one you have to time on foot.
      if (i < 4) { ctx.anchor(0, 9, z); }
      // The pivot housing the anchor hangs from.
      ctx.decor(0, 9.4, z, 1.4, 0.9, 1.4, "post");
    }

    // Deck posts, purely so the eye can judge depth and speed on the section
    // where that matters most. These used to be hard-coded in the renderer.
    for (let z = 4; z <= 42; z += 8) {
      ctx.decor(-deck / 2 - 0.1, 0.55, z, 0.28, 1.1, 0.28, "post");
      ctx.decor(deck / 2 + 0.1, 0.55, z, 0.28, 1.1, 0.28, "post");
    }
    // Landmark: the pivot gantry, the tallest structure in the course.
    ctx.decor(0, 10.6, 23, 1, 1, 46, "post");
    ctx.decor(-4, 5.5, 23, 1, 11, 1, "post");
    ctx.decor(4, 5.5, 23, 1, 11, 1, "post");

    straightSpine(ctx, 46);
    ctx.note(inSync ? "Pendulums swinging as one wall" : "Pendulums staggered into a wave");
  },
};

// ===========================================================================
// 10 - The Chasm. Difficulty 4, middle, requires the Tether.
//
// A gap with anchors and one clean line. Nothing catches you. This is the
// section that prices the tether honestly - the verb has to be able to punish
// or it means nothing - and the only one in the pool that hard-requires a verb,
// so the generator must never pick it when the tether is disabled.
// ===========================================================================
export const chasm: SectionDef = {
  id: "chasm",
  title: "The Chasm",
  weight: 0.7,
  difficulty: 4,
  roles: ["middle"],
  requires: ["tether"],
  teaches: "tether",
  entry: { width: "standard", elevation: 0, turn: "straight" },
  exit: { width: "narrow", elevation: 0, turn: "straight" },
  length: 42,

  build(ctx) {
    const d = [ctx.rand(), ctx.rand(), ctx.rand()];
    const count = 2 + Math.floor(d[0] * 3);      // 2..4
    /*
     * 16-21, not the 26-34 it was authored at, and anchors at 6.5-8 rather
     * than 9-11.
     *
     * Both numbers came out of measuring what a swing can actually do. A rope
     * catch destroys the outward radial velocity - correct for something
     * inextensible - so a swing never returns to the height it left from, and
     * an exhaustive search over run-up and release timing put the ceiling at
     * about 27 u of crossing with no margin at all. Three chasms in ten were
     * completable and the rest were not, which is not difficulty, it is a wall.
     *
     * Lower anchors help twice: they are inside the camera's look-up range, and
     * a shorter rope puts the bottom of the arc nearer the deck, so there is
     * less depth to climb back out of on the far side.
     *
     * Twenty-one is the ceiling with margin; a running jump at chain 8 clears
     * about twelve, so the section still cannot be run on foot - which is the
     * whole reason it is the one place in the pool that hard-requires a verb.
     */
    const gap = 16 + d[1] * 5;
    const height = 6.5 + d[2] * 1.5;

    const lip = (42 - gap) / 2;
    ctx.track(14, 0, lip);
    ctx.track(6, 42 - lip, 42);

    for (let i = 0; i < count; i++) {
      const z = lip + gap * ((i + 1) / (count + 1));
      ctx.anchor(0, height, z);
      ctx.decor(0, height + 0.5, z, 1.2, 1, 1.2, "post");
    }
    ctx.decor(0, height + 1.2, lip + gap / 2, 1, 1, gap, "rope");

    // Landmark: the far tower, which is also the only thing to aim at.
    ctx.decor(0, 9, 41, 5, 18, 5, "post");

    straightSpine(ctx, 42);
    ctx.note(`Chasm of ${gap.toFixed(1)} u on ${count} anchors`);
  },
};
