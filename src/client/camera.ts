/**
 * Third-person follow rig.
 *
 * Two things matter here. The camera tracks the player's *predicted* position,
 * not the server's, so it never lags your own input. And it damps position but
 * not orientation - the view turns instantly with the mouse while the boom
 * eases behind you, which is what makes a course this fast readable.
 *
 * The boom's collision test runs against the shared `Level` data rather than
 * Babylon's scene picking: it is the same geometry the simulation uses, so the
 * camera can never be pulled in by something you can walk through (or clip
 * through something you cannot).
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { damp } from "../shared/math.js";
import { PLAYER_HEIGHT } from "../shared/constants.js";
import { type BoxLike, rayBoxDistance } from "../shared/collision.js";
import type { Level } from "../shared/level.js";
import { isActiveAt, makePose, poseAt, type WorldPhase } from "../shared/obstacles.js";
import type { Stage } from "./render/scene.js";

const BOOM = 7.4;
const SHOULDER = 0.55;
const EYE = PLAYER_HEIGHT * 0.78;
/** Keep the near plane clear of whatever the boom stopped against. */
const SKIN = 0.4;

const probeBox: BoxLike = { x: 0, y: 0, z: 0, hx: 0, hy: 0, hz: 0, yaw: 0 };
const probePose = makePose();

export class FollowCamera {
  private stage: Stage;
  private focus = new Vector3(0, 1, 0);
  private shake = 0;

  constructor(stage: Stage) {
    this.stage = stage;
  }

  /** Kick the camera - used on hazard hits and hard landings. */
  impulse(amount: number) {
    this.shake = Math.min(this.shake + amount, 1.4);
  }

  /** Snap straight to the target, for respawns and round resets. */
  reset(x: number, y: number, z: number) {
    this.focus.set(x, y + EYE, z);
    this.shake = 0;
  }

  update(
    x: number, y: number, z: number,
    yaw: number, pitch: number, dt: number,
    level: Level, phase: WorldPhase, tick: number,
  ) {
    const camera = this.stage.camera;

    // Damp the look-at point, not the camera position: the boom stays rigidly
    // attached to the aim direction, so mouse input feels 1:1.
    this.focus.x = damp(this.focus.x, x, 18, dt);
    this.focus.y = damp(this.focus.y, y + EYE, 11, dt);
    this.focus.z = damp(this.focus.z, z, 18, dt);

    const cosP = Math.cos(pitch);
    const forwardX = Math.sin(yaw) * cosP;
    const forwardY = -Math.sin(pitch);
    const forwardZ = Math.cos(yaw) * cosP;

    // Offset the boom over one shoulder so the avatar does not sit dead centre.
    const eyeX = this.focus.x + Math.cos(yaw) * SHOULDER;
    const eyeZ = this.focus.z - Math.sin(yaw) * SHOULDER;

    const boom = this.clearBoom(
      eyeX, this.focus.y, eyeZ,
      -forwardX, -forwardY, -forwardZ,
      level, phase, tick,
    );

    let px = eyeX - forwardX * boom;
    let py = this.focus.y - forwardY * boom;
    let pz = eyeZ - forwardZ * boom;

    if (this.shake > 0.001) {
      const s = this.shake * 0.34;
      px += (Math.random() - 0.5) * s;
      py += (Math.random() - 0.5) * s;
      pz += (Math.random() - 0.5) * s;
      this.shake = damp(this.shake, 0, 7, dt);
    }

    camera.position.set(px, py, pz);
    camera.setTarget(this.focus);
    this.stage.followShadows(this.focus);
  }

  /** Shortest unobstructed boom length along the backward view ray. */
  private clearBoom(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    level: Level, phase: WorldPhase, tick: number,
  ): number {
    let best = BOOM;

    for (const s of level.solids) {
      // The course is 300 units long; reject on Z before doing any real work.
      if (Math.abs(s.z - oz) > s.hz + BOOM) { continue; }
      probeBox.x = s.x; probeBox.y = s.y; probeBox.z = s.z;
      probeBox.hx = s.hx; probeBox.hy = s.hy; probeBox.hz = s.hz;
      probeBox.yaw = s.yaw;
      const d = rayBoxDistance(ox, oy, oz, dx, dy, dz, probeBox, best);
      if (d > 0 && d < best) { best = d; }
    }

    for (const ob of level.obstacles) {
      if (ob.role !== "solid") { continue; }
      if (Math.abs(ob.pz - oz) > ob.size.z / 2 + ob.size.x / 2 + BOOM) { continue; }
      if (!isActiveAt(ob, tick, phase)) { continue; }
      poseAt(ob, tick, phase, probePose);
      if (!probePose.active) { continue; }
      probeBox.x = probePose.x; probeBox.y = probePose.y; probeBox.z = probePose.z;
      probeBox.hx = ob.size.x / 2; probeBox.hy = ob.size.y / 2; probeBox.hz = ob.size.z / 2;
      probeBox.yaw = probePose.yaw;
      const d = rayBoxDistance(ox, oy, oz, dx, dy, dz, probeBox, best);
      if (d > 0 && d < best) { best = d; }
    }

    return best < BOOM ? Math.max(1.7, best - SKIN) : BOOM;
  }
}
