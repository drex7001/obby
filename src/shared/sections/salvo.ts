/**
 * 9 - The Gallery. Difficulty 2, opener, requires the Salvo.
 *
 * A long bend with weak points on the walls: shoot one and the bar it feeds
 * goes inert for five seconds - for everyone in the section, including the
 * runner right behind you. Shooting is generous by default, and deciding
 * whether your pursuer benefits more than you do is the actual read here.
 *
 * Every effect is a window, never a deletion, so the section stays completable
 * with the gun disabled - which is the only reason it is safe to open on.
 */

import { AMMO_MAX } from "../constants.js";
import { straightSpine } from "./build.js";
import type { SectionDef } from "./types.js";

export const gallery: SectionDef = {
  id: "gallery",
  title: "The Gallery",
  weight: 1,
  difficulty: 2,
  roles: ["opener"],
  requires: ["salvo"],
  teaches: "salvo",
  entry: { width: "standard", elevation: 0, turn: "straight" },
  exit: { width: "standard", elevation: 0, turn: "bend" },
  length: 44,

  build(ctx) {
    const d: number[] = [];
    for (let i = 0; i < 7; i++) { d.push(ctx.rand()); }
    const count = 2 + Math.floor(d[0] * 2);      // 2..3, inside the 3 budget
    const gunSide = d[1] < 0.5 ? -1 : 1;
    const target = 1.1 + d[2] * 0.8;

    ctx.track(16, 0, 44);
    ctx.rail(-8.4, 0, 44, 3.4);
    ctx.rail(8.4, 0, 44, 3.4);

    // The gun sits off the fast line, and it is the only thing in the section
    // that is worth a metre of racing to reach. Aiming already costs a runner
    // their line - the camera is the movement frame - so nothing else here
    // needs to charge for the privilege.
    ctx.pickup({ x: gunSide * 5, y: 1.3, z: 6, kind: "gun", ammo: AMMO_MAX });
    ctx.decor(gunSide * 5, 0.3, 6, 1.8, 0.6, 1.8, "plate");

    for (let i = 0; i < count; i++) {
      // An opener has no section in front of it to see past, so the whole 16 u
      // of telegraph has to fit inside the section.
      const z = count === 1 ? 26 : 16 + 16 * (i / (count - 1));
      const side = i % 2 === 0 ? -1 : 1;
      const weakPoint = ctx.breaker({
        x: side * 7.6, y: 2.4, z,
        hx: target / 2, hy: target / 2, hz: target / 2,
        yaw: 0, effect: "disable", style: "breaker",
      });
      // The hazard the weak point answers. It is timed and clearable on foot;
      // the shot buys five seconds, and buying them costs a shot and a line.
      ctx.obstacle({
        kind: "spinner", role: "hazard", style: "bar",
        size: { x: 13, y: 0.14, z: 1 },
        px: 0, py: 0.95, pz: z,
        speed: (0.72 + i * 0.16) * (d[3 + i] < 0.5 ? 1 : -1),
        phase: i * 0.29,
        knock: 8,
        breaker: weakPoint.slot,
      });
    }

    // A turret firing across the lane, and the reason it is in the section that
    // teaches the Salvo: a shell in flight is a pure function of tick, so
    // shooting one down is a *timing window* in exactly the same language as
    // Impact and the tether release. Defence and offence are one verb at
    // different moments, and this is where a runner finds that out.
    ctx.obstacle({
      kind: "turret", role: "hazard", style: "shell",
      size: { x: 0.8, y: 0.8, z: 0.8 },
      px: -7.4, py: 3, pz: 36,
      baseYaw: Math.PI / 2,
      muzzleSpeed: 18, muzzlePitch: 0.5,
      period: 2.4 + d[6] * 0.7, phase: 0.15,
      knock: 10,
      shell: ctx.nextShellSlot(),
    });
    ctx.decor(-8, 3, 36, 1.6, 1.6, 1.6, "post");

    // Landmark: the gantry the wall supports hold up.
    ctx.decor(-8, 5.5, 30, 1.4, 11, 1.4, "post");
    ctx.decor(8, 5.5, 30, 1.4, 11, 1.4, "post");
    ctx.decor(0, 10.6, 30, 17.4, 1.2, 1.2, "post");

    straightSpine(ctx, 44);
    ctx.note(`Gallery: ${count} weak points and a gun`);
  },
};
