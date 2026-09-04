/**
 * Sections built around Impact.
 *
 * Each one is a run of landing windows over a void. Nothing in here is a hazard
 * in the knockback sense - the punishment is the fall, and the reward is the
 * Chain a clean sequence of Perfects pays out.
 */

import { TICK_RATE } from "../constants.js";
import { straightSpine } from "./build.js";
import type { SectionCtx, SectionDef } from "./types.js";

/** Shuffle in place with a fixed number of draws, whatever the outcome. */
function shuffle(ctx: SectionCtx, values: number[], draws: number[]) {
  for (let i = values.length - 1, k = 0; i > 0; i--, k++) {
    const j = Math.floor(draws[k] * (i + 1));
    const swap = values[i];
    values[i] = values[j];
    values[j] = swap;
  }
}

// ===========================================================================
// 2 - The Drift. Difficulty 3, middle, teaches Impact.
//
// Two sliding platforms to cross, then five crumble stones in sequence: five
// landing windows, and the biggest single Chain block in the pool. The section
// is early and short, and it earns the void.
// ===========================================================================
export const drift: SectionDef = {
  id: "drift",
  title: "The Drift",
  weight: 1,
  difficulty: 3,
  roles: ["middle"],
  requires: [],
  teaches: "impact",
  entry: { width: "wide", elevation: 0, turn: "straight" },
  exit: { width: "standard", elevation: 0, turn: "straight" },
  length: 40,

  build(ctx) {
    const d: number[] = [];
    for (let i = 0; i < 7; i++) { d.push(ctx.rand()); }
    const period = 3.6 + d[0] * 1.2;
    const extraSlider = d[1] < 0.3;
    const phaseOffset = d[6] * 0.2;

    ctx.track(22, 0, 4);

    const slider = (z: number, from: number, to: number, p: number, phase: number) => {
      ctx.obstacle({
        kind: "slider", role: "solid", style: "mover",
        size: { x: 7, y: 1, z: 7 },
        px: 0, py: -0.5, pz: z,
        a: { x: from, y: -0.5, z }, b: { x: to, y: -0.5, z },
        period: p, phase,
      });
    };
    slider(9, -8, 8, period, phaseOffset);
    slider(16.5, 8, -8, period, 0.5 + phaseOffset);
    if (extraSlider) {
      // A third, faster platform that arrives out of step with the other two.
      slider(12.75, -6, 6, period * 0.72, 0.25 + phaseOffset);
    }

    const lanes = [-2.4, 2.4, 0, -2.4, 2.4];
    shuffle(ctx, lanes, d.slice(2, 6));
    lanes.forEach((x, i) => {
      ctx.obstacle({
        kind: "crumble", role: "solid", style: "crumble",
        size: { x: 3.8, y: 1, z: 3.8 },
        px: x, py: -0.5, pz: 19 + i * 3.8,
      });
    });
    // A lip to land on. Without it the fifth stone IS the exit gate, so the
    // platform a runner is standing on collapses as they reach the checkpoint.
    ctx.track(14, 37, 40);

    // Landmark: lit slider rails running out past the play space, and the
    // pylon they hang from.
    ctx.decor(-13.5, 1.4, 13, 0.6, 0.6, 18, "rope");
    ctx.decor(13.5, 1.4, 13, 0.6, 0.6, 18, "rope");
    ctx.decor(14.5, 6, 12, 3, 12, 3, "post");

    straightSpine(ctx, 40);
    ctx.note(extraSlider ? "Drift running a third express platform" : "Drift on two platforms");
  },
};

// ===========================================================================
// 8 - The Sieve. Difficulty 2, middle, teaches Impact.
//
// A field of vertical pistons on offset cycles - a forest, not a corridor.
// There is no fixed safe path: the line you can take depends on the phase you
// arrive at, so two runners solve it differently on the same seed.
// ===========================================================================
export const sieve: SectionDef = {
  id: "sieve",
  title: "The Sieve",
  weight: 1,
  // Tagged 2, not the spec table's 3. There is no void anywhere in it, and the
  // one hazard is a swarm that stuns - so nothing here can end a run. It reads
  // hard and costs seconds, which is a 2.
  difficulty: 2,
  roles: ["middle"],
  requires: [],
  teaches: "impact",
  entry: { width: "wide", elevation: 0, turn: "straight" },
  exit: { width: "wide", elevation: 0, turn: "straight" },
  length: 40,

  build(ctx) {
    // Always the full grid's worth of draws, whatever the grid turns out to be.
    const d: number[] = [];
    for (let i = 0; i < 46; i++) { d.push(ctx.rand()); }
    const cols = 4 + Math.floor(d[0] * 3);       // 4..6
    const rows = 5 + Math.floor(d[1] * 3);       // 5..7
    const centreFast = d[2] < 0.5;

    ctx.track(26, 0, 40);

    const spanX = 20, z0 = 12, z1 = 34;
    for (let r = 0; r < rows; r++) {
      const z = rows === 1 ? (z0 + z1) / 2 : z0 + (z1 - z0) * (r / (rows - 1));
      for (let c = 0; c < cols; c++) {
        const x = cols === 1 ? 0 : -spanX / 2 + spanX * (c / (cols - 1));
        // Escalation runs down the section; the centre column is either the
        // fastest line or the slowest, and which one is the round's variant.
        const central = Math.abs(x) < spanX / 4;
        const base = 2.9 - 0.5 * (r / Math.max(1, rows - 1));
        const period = base * (central === centreFast ? 0.78 : 1.12);
        ctx.obstacle({
          kind: "slider", role: "solid", style: "piston",
          size: { x: 3, y: 4, z: 3 },
          px: x, py: 0, pz: z,
          a: { x, y: -2.4, z }, b: { x, y: 2, z },
          period, phase: d[3 + r * 6 + c],
        });
      }
    }

    // A trap: step on the plate and a swarm wakes for four seconds. It is the
    // exact inverse of a breaker - shooting is generous by default and helps
    // whoever is in the section, and tripping this hurts them.
    const trap = ctx.plate({
      volume: { x: 0, y: 0.7, z: 10, hx: 3, hy: 0.9, hz: 3, yaw: 0 },
      activation: "hold", holdTicks: Math.round(TICK_RATE * 4), label: "Trap",
    });
    ctx.decor(0, 0.05, 10, 6, 0.1, 6, "impact-plate");
    ctx.obstacle({
      kind: "swarm", role: "hazard", style: "swarm",
      size: { x: 20, y: 2.4, z: 6 },
      px: 0, py: 1.2, pz: 20 + d[45] * 4,
      plate: trap.id,
      knock: 7,
    });

    // The sealed catwalk.
    //
    // A raised outer lane that skips the piston field entirely, locked behind a
    // barrier that only a shot opens - and once it is open it stays open for
    // the round, for everyone. That is the point: a seal is a public act, and
    // you may not be able to defend the route you just unlocked.
    const seal = ctx.breaker({
      x: 15, y: 4.2, z: 17.6, hx: 0.8, hy: 0.8, hz: 0.8,
      yaw: 0, effect: "seal", style: "breaker",
    });
    ctx.ramp({ x: 14, z: 14.5, hx: 1.6, hz: 2.5, y0: 0, y1: 2.2, style: "ramp" });
    ctx.track(3, 17, 37, 2.2, "lane", 15);
    ctx.obstacle({
      kind: "seal", role: "solid", style: "gate",
      size: { x: 3.2, y: 2.6, z: 0.7 },
      px: 15, py: 3.5, pz: 17.6,
      breaker: seal.slot,
    });
    // The inner rail is what makes the seal mean anything: without it the lane
    // is simply jumped into from the track beside it.
    ctx.rail(13.4, 17, 33, 2.6, 0.8, 2.2, "divider");

    ctx.decor(18, 7, 34, 4, 14, 4, "post");
    straightSpine(ctx, 40);
    ctx.note(`Sieve at ${cols}x${rows}, ${centreFast ? "fast" : "slow"} through the middle`);
  },
};

// ===========================================================================
// 12 - The Cascade. Difficulty 3, middle, teaches Impact.
//
// A descending waterfall of crumble platforms. Every drop is a landing window
// and every Perfect pays overspeed, which makes this the one section where
// falling downward on purpose is the fast line - and the natural pair for the
// Spiral, which is the only section that climbs.
// ===========================================================================
export const cascade: SectionDef = {
  id: "cascade",
  title: "The Cascade",
  weight: 1,
  difficulty: 3,
  roles: ["middle"],
  requires: [],
  teaches: "impact",
  entry: { width: "standard", elevation: 0, turn: "straight" },
  exit: { width: "standard", elevation: -8, turn: "straight" },
  length: 46,

  build(ctx) {
    const d: number[] = [];
    for (let i = 0; i < 12; i++) { d.push(ctx.rand()); }
    const drops = 3 + Math.floor(d[0] * 2);      // 3..4
    const perDrop = 2;
    const count = drops * perDrop;
    const z0 = 12, z1 = 38;
    const step = (z1 - z0) / (count - 1);

    ctx.track(14, 0, 10);

    for (let i = 0; i < count; i++) {
      const drop = Math.floor(i / perDrop) + 1;
      ctx.obstacle({
        kind: "crumble", role: "solid", style: "crumble",
        size: { x: 5, y: 1, z: 4.5 },
        px: (d[2 + i] < 0.5 ? -1 : 1) * 2.2,
        py: -8 * (drop / drops) - 0.5,
        pz: z0 + step * i,
      });
    }

    ctx.track(14, 41, 46, -8);

    // Landmark: the head of the cascade, framed so it reads from the entry.
    ctx.decor(-8, 5, 10, 1.2, 10, 1.2, "post");
    ctx.decor(8, 5, 10, 1.2, 10, 1.2, "post");
    ctx.decor(0, 9.4, 10, 17.2, 1.2, 1.2, "post");

    ctx.spine(0, 0, 0);
    ctx.spine(0, 0, 10);
    for (let i = 0; i < count; i++) {
      ctx.spine(0, -8 * ((Math.floor(i / perDrop) + 1) / drops), z0 + step * i);
    }
    ctx.spine(0, -8, 46);
    ctx.note(`Cascade over ${drops} drops`);
  },
};
