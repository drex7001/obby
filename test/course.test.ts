/**
 * Renderer tests, run headlessly on Babylon's NullEngine.
 *
 * These exist for one reason: the course is torn down and rebuilt when a round
 * ends and the seed changes, and that code path does not execute until the
 * second round of a live match. A leak or a stale reference there would only
 * ever be found by playing for four minutes.
 */

import assert from "assert";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";

import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { buildLevel } from "../src/shared/level.js";
import { hazardHit, type Body, type HitNormal } from "../src/shared/collision.js";
import { makePose, poseAt, type WorldPhase } from "../src/shared/obstacles.js";
import { Course } from "../src/client/render/course.js";
import { meshYaw, type Stage } from "../src/client/render/scene.js";

const phase: WorldPhase = {
  raceStartTick: 0,
  crumbleTicks: [-1, -1, -1, -1, -1],
  plateTicks: [-1],
  plateSince: [-1],
};

/**
 * The Course only needs a scene, a material lookup and the shadow hooks - not a
 * whole Stage. Standing one up keeps these tests free of a GL context.
 */
function makeStage(): { stage: Stage; scene: Scene; engine: NullEngine } {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const stage = {
    scene,
    material: () => null as any,
    castsAndReceives: () => {},
  } as unknown as Stage;
  return { stage, scene, engine };
}

describe("course rendering", () => {
  it("builds a mesh for every solid, ramp and obstacle", () => {
    const { stage, scene, engine } = makeStage();
    const level = buildLevel(4242);
    new Course(stage, level);

    const expected = level.solids.length + level.ramps.length + level.obstacles.length;
    assert.ok(scene.meshes.length >= expected,
      `expected at least ${expected} meshes, found ${scene.meshes.length}`);

    for (const ob of level.obstacles) {
      assert.ok(scene.getMeshByName(`ob-${ob.id}`), `no mesh for obstacle ${ob.id} (${ob.kind})`);
    }
    engine.dispose();
  });

  it("rebuilds for a new round without leaking the previous course", () => {
    const { stage, scene, engine } = makeStage();
    const course = new Course(stage, buildLevel(1));
    const first = scene.meshes.length;

    for (let round = 2; round <= 6; round++) {
      course.rebuild(buildLevel(round));
      assert.ok(
        Math.abs(scene.meshes.length - first) < 30,
        `round ${round} left ${scene.meshes.length} meshes, started from ${first}`,
      );
    }

    // The variant changes obstacle counts a little; nothing should accumulate.
    assert.ok(scene.meshes.length < first * 1.5, "meshes are accumulating across rounds");
    engine.dispose();
  });

  it("places dynamic meshes exactly where the simulation says they are", () => {
    const { stage, scene, engine } = makeStage();
    const level = buildLevel(4242);
    const course = new Course(stage, level);

    const tick = 517.5;
    course.update(tick, phase);

    for (const ob of level.obstacles) {
      const mesh = scene.getMeshByName(`ob-${ob.id}`)!;
      const pose = poseAt(ob, tick, phase, makePose());
      assert.ok(Math.abs(mesh.position.x - pose.x) < 1e-9, `${ob.kind} x drifted`);
      assert.ok(Math.abs(mesh.position.y - pose.y) < 1e-9, `${ob.kind} y drifted`);
      assert.ok(Math.abs(mesh.position.z - pose.z) < 1e-9, `${ob.kind} z drifted`);
      // Course geometry is drawn with the yaw convention flipped; getting this
      // wrong would mirror every rotating platform against its own collider.
      assert.ok(Math.abs(mesh.rotation.y - meshYaw(pose.yaw)) < 1e-9, `${ob.kind} yaw drifted`);
    }
    engine.dispose();
  });

  /**
   * The renderer and the simulation each rotate a box by yaw, in separate code,
   * with separate conventions. This crosses the two: it takes a point from the
   * MESH's own world matrix and asks the collider whether it is inside.
   *
   * Regression. `hazardHit` used to invert with `cos(-yaw)` while `toLocal` -
   * which every solid uses, and which `meshYaw()` was derived from - inverts
   * with `cos(yaw)`. Same formula, opposite angle, so a push bar's hitbox was
   * the mirror image of the bar being drawn. The two met twice per revolution
   * and the rest of the time players were hit by a bar visibly clear of them.
   */
  it("puts a hazard's hitbox exactly where its mesh is drawn", () => {
    const { stage, scene, engine } = makeStage();
    const level = buildLevel(4242);
    const course = new Course(stage, level);
    const spinners = level.obstacles.filter((o) => o.kind === "spinner");
    assert.ok(spinners.length > 0, "the course should have sweeping bars");

    const body: Body = {
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grounded: true, groundId: 0,
    };
    const out: HitNormal = { nx: 0, nz: 0, hit: false };

    // Sample right around a sweep, so no single lucky angle can pass this.
    for (const tick of [0, 7, 13, 21, 34, 55, 89]) {
      course.update(tick, phase);

      for (const ob of spinners) {
        const mesh = scene.getMeshByName(`ob-${ob.id}`)!;
        mesh.computeWorldMatrix(true);
        const pose = poseAt(ob, tick, phase, makePose());

        // A point just inside the far end of the arm, taken from the mesh.
        const local = new Vector3(ob.size.x / 2 - 0.6, 0, 0);
        const tip = Vector3.TransformCoordinates(local, mesh.getWorldMatrix());

        body.x = tip.x; body.y = tip.y - 0.86; body.z = tip.z;
        hazardHit(body, pose, ob.size.x, ob.size.y, ob.size.z, out);
        assert.ok(out.hit,
          `tick ${tick}: standing at the drawn arm tip (${tip.x.toFixed(2)}, ` +
          `${tip.z.toFixed(2)}) should register a hit`);

        // ...and the mirror of that point, about the pivot, must NOT hit -
        // otherwise a symmetric bug would still pass the check above.
        const mirrored = 2 * ob.pz - tip.z;
        if (Math.abs(mirrored - tip.z) > 3) {
          body.z = mirrored;
          hazardHit(body, pose, ob.size.x, ob.size.y, ob.size.z, out);
          assert.ok(!out.hit,
            `tick ${tick}: the mirrored point (z=${mirrored.toFixed(2)}) must be clear`);
        }
      }
    }
    engine.dispose();
  });

  it("hides a solid obstacle once its pose goes inactive", () => {
    const { stage, scene, engine } = makeStage();
    const level = buildLevel(4242);
    const course = new Course(stage, level);

    const gate = level.obstacles.find((o) => o.kind === "startgate")!;
    const mesh = scene.getMeshByName(`ob-${gate.id}`)!;

    course.update(10, { ...phase, raceStartTick: -1 });
    assert.strictEqual(mesh.isEnabled(), true, "the gate is up before the race");

    course.update(200, { ...phase, raceStartTick: 100 });
    assert.strictEqual(mesh.isEnabled(), false, "the gate is gone once the race starts");
    engine.dispose();
  });
});
