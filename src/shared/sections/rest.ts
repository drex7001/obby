/**
 * 14 - The Straightaway. Difficulty 1, opener or rest, teaches nothing.
 *
 * Open run, a gentle slalom of soft obstacles, and a narrowing where slipstream
 * will do its most visible work. Every course needs one breath, and this is the
 * only section in the pool whose job is to be uneventful.
 */

import type { SectionDef } from "./types.js";

export const straightaway: SectionDef = {
  id: "straightaway",
  title: "The Straightaway",
  weight: 1.1,
  difficulty: 1,
  roles: ["opener", "rest"],
  requires: [],
  teaches: null,
  entry: { width: "wide", elevation: 0, turn: "straight" },
  exit: { width: "wide", elevation: 0, turn: "straight" },
  length: 36,

  build(ctx) {
    const d: number[] = [];
    for (let i = 0; i < 8; i++) { d.push(ctx.rand()); }
    const spacing = 5.5 + d[0] * 2;
    const narrowAt = 20 + d[1] * 4;

    ctx.track(24, 0, narrowAt);
    ctx.track(12, narrowAt, 36);
    // The funnel walls, which is where the narrowing reads as a decision.
    ctx.wall(-6.4, (narrowAt + 36) / 2, 0.8, 1.6, 36 - narrowAt, 0, "divider");
    ctx.wall(6.4, (narrowAt + 36) / 2, 0.8, 1.6, 36 - narrowAt, 0, "divider");

    // Soft blocks: they cost a line, never a life.
    for (let i = 0; i < 6; i++) {
      const z = 6 + i * spacing;
      if (z > narrowAt - 2) { break; }
      const x = (i % 2 === 0 ? -1 : 1) * (2.5 + d[2 + i] * 4);
      ctx.wall(x, z, 2.2, 1.1, 2.2, 0, "divider");
    }

    // Coin pods. The rest beat is where aiming is affordable, which is exactly
    // where the loot belongs: a player at 19 u/s in a chain cannot spare the
    // line, and a player who just fumbled can. The rubber band comes out of the
    // mechanics rather than being imposed on top of them.
    ctx.breaker({
      x: -6, y: 2.6, z: 10, hx: 0.75, hy: 0.75, hz: 0.75,
      yaw: 0, effect: "pod", style: "pod",
    });
    ctx.breaker({
      x: 6, y: 2.6, z: 17, hx: 0.75, hy: 0.75, hz: 0.75,
      yaw: 0, effect: "pod", style: "pod",
    });

    // Landmark: a distant arch, framing whatever comes next.
    ctx.decor(-7, 5, 34, 1.2, 10, 1.2, "post");
    ctx.decor(7, 5, 34, 1.2, 10, 1.2, "post");
    ctx.decor(0, 9.4, 34, 15.2, 1.2, 1.2, "post");

    ctx.spine(0, 0, 0);
    ctx.spine(0, 0, narrowAt);
    ctx.spine(0, 0, 36);
    ctx.note("Straightaway: a breath");
  },
};
