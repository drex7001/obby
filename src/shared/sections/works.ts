/**
 * 5 - The Works. Difficulty 3, middle, teaches Impact.
 *
 * Was the Fork. The two parallel lanes became one lane in sequence, which is
 * what the single-line rule costs and all it costs: three timed doors, then a
 * gap crossed by a plate-driven swing bridge.
 *
 * The plate is authored as an eight-second hold - the solo and duo fallback the
 * spec asks for. It cannot be authored the other way round: generation must
 * never branch on how many runners are connected, or two clients build
 * different courses from the same seed. Making the plate a *held* plate in a
 * field of three or more is a room-side rule, not a generated one.
 */

import { PLATE_HOLD_TICKS } from "../constants.js";
import { straightSpine } from "./build.js";
import type { SectionDef } from "./types.js";

export const works: SectionDef = {
  id: "works",
  title: "The Works",
  weight: 1,
  difficulty: 3,
  roles: ["middle"],
  requires: [],
  teaches: "impact",
  entry: { width: "wide", elevation: 0, turn: "straight" },
  exit: { width: "wide", elevation: 0, turn: "bend" },
  length: 52,

  build(ctx) {
    const d: number[] = [];
    for (let i = 0; i < 6; i++) { d.push(ctx.rand()); }
    const doorPeriod = 3.8 + d[0] * 1.4;
    const doors = 2 + Math.floor(d[1] * 2);      // 2..3
    const gapWidth = 9 + d[2] * 4;               // 9..13
    const phaseJitter = d[3] * 0.12;

    const gapStart = 45 - gapWidth;
    ctx.track(16, 0, gapStart);
    ctx.rail(-8.4, 0, gapStart, 3);
    ctx.rail(8.4, 0, gapStart, 3);
    ctx.track(16, 45, 52);

    for (let i = 0; i < doors; i++) {
      ctx.obstacle({
        kind: "door", role: "solid", style: "door",
        size: { x: 8, y: 3.4, z: 0.7 },
        px: 0, py: 1.7, pz: 16 + i * 12,
        period: doorPeriod, phase: i * (0.34 + phaseJitter), openFraction: 0.42,
      });
    }

    const plate = ctx.plate({
      volume: { x: 0, y: 0.7, z: 8, hx: 2, hy: 0.9, hz: 2, yaw: 0 },
      activation: "hold", holdTicks: PLATE_HOLD_TICKS, label: "Bridge",
    });
    ctx.decor(0, 0.05, 8, 4, 0.1, 4, "plate");

    // The bridge parks along the near lip and swings out across the gap. Its
    // 0.9 s travel means a runner who timed the plate is mid-crossing by the
    // time the holder steps off.
    ctx.obstacle({
      kind: "hinge", role: "solid", style: "swingbridge",
      size: { x: 3.2, y: 0.8, z: gapWidth },
      px: 0, py: -0.4, pz: gapStart,
      offsetZ: gapWidth / 2,
      closedYaw: -Math.PI / 2, openYaw: 0,
      plate: plate.id,
    });

    // The first hand-authored Heavy target: only an Impact shockwave fires it,
    // never merely standing on it, so it teaches the distinction.
    ctx.plate({
      volume: { x: 0, y: 0.25, z: 40, hx: 2.5, hy: 0.25, hz: 2.5, yaw: 0 },
      activation: "heavy", holdTicks: 30, label: "Impact Plate",
    });
    ctx.decor(0, 0.08, 40, 5, 0.16, 5, "impact-plate");

    // Jaws: two solids closing across the corridor and opening again. The
    // classic timing gate, and it needs no new machinery at all - a jaw is a
    // slider, and two sliders in phase are a jaw pair.
    const jawPeriod = 2.4 + d[4] * 0.8;
    for (const side of [-1, 1]) {
      ctx.obstacle({
        kind: "slider", role: "solid", style: "jaws",
        size: { x: 7, y: 3.6, z: 1.4 },
        px: side * 5, py: 1.8, pz: 22,
        a: { x: side * 8.4, y: 1.8, z: 22 }, b: { x: side * 1.7, y: 1.8, z: 22 },
        period: jawPeriod, phase: 0,
      });
    }

    // A nest, because a works is exactly the sort of place things come out of.
    ctx.obstacle({
      kind: "nest", role: "solid", style: "nest",
      size: { x: 2.4, y: 2.4, z: 2.4 },
      px: -6.4, py: 1.2, pz: 9,
      period: 1, phase: d[5],
    });

    // And a Bulwark parked across the near lane. Solid, slow, and never quite
    // in the way of the whole corridor - a thing to route around or shoot down.
    ctx.enemy(2, 4.5, 0, 33);

    // The support, and the gantry it holds up.
    //
    // Shooting it drops a second plank across the gap, in its own lane, for the
    // rest of the round: a runner who missed the plate window has a way over,
    // and so does everybody behind them. It builds a route rather than removing
    // an obstacle, which is the rule every shootable effect follows.
    const support = ctx.breaker({
      x: -5, y: 7.4, z: gapStart, hx: 0.85, hy: 0.85, hz: 0.85,
      yaw: 0, effect: "collapse", style: "breaker",
    });
    ctx.obstacle({
      kind: "collapse", role: "solid", style: "swingbridge",
      size: { x: 3.4, y: 0.8, z: gapWidth },
      px: -5, py: -0.4, pz: gapStart + gapWidth / 2,
      breaker: support.slot, dropY: 8.2,
    });

    // A crate on the near rail: two shots back, for whoever spent theirs here.
    ctx.breaker({
      x: 7.2, y: 2.6, z: 12, hx: 0.7, hy: 0.7, hz: 0.7,
      yaw: 0, effect: "crate", style: "crate",
    });

    // Landmark: the gantry the bridge hangs from, silhouetted over the gap.
    ctx.decor(-5, 5, gapStart, 1.2, 10, 1.2, "post");
    ctx.decor(5, 5, gapStart, 1.2, 10, 1.2, "post");
    ctx.decor(0, 9.4, gapStart, 11.2, 1.2, 1.2, "post");

    straightSpine(ctx, 52);
    ctx.note(`Works: ${doors} doors and a ${gapWidth.toFixed(1)} u swing`);
  },
};
