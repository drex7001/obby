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
import { levelWith } from "./helpers/simulation.js";
import { hazardHit, type Body, type HitNormal } from "../src/shared/collision.js";
import { makePose, poseAt, type WorldPhase } from "../src/shared/obstacles.js";
import { Course } from "../src/client/render/course.js";
import { meshYaw, type Stage } from "../src/client/render/scene.js";

/** A cold world phase sized for whichever course a test happens to build. */
function idlePhase(
  level: {
    crumbleCount: number; plates: unknown[];
    breakerCount: number; pickupCount: number; shellCount: number;
  },
): WorldPhase {
  return {
    raceStartTick: 0,
    crumbleTicks: new Array(level.crumbleCount).fill(-1),
    plateTicks: new Array(level.plates.length).fill(-1),
    plateSince: new Array(level.plates.length).fill(-1),
    breakerTicks: new Array(level.breakerCount).fill(-1),
    pickupTicks: new Array(level.pickupCount).fill(-1),
    shellTicks: new Array(level.shellCount).fill(-1),
  };
}

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

    // Since stage 4 a seed draws seven sections from a pool, so two rounds have
    // genuinely different mesh counts and an absolute bound proves nothing.
    // Coming back to the same seed and landing on the same count does.
    for (let round = 2; round <= 8; round++) { course.rebuild(buildLevel(round)); }
    course.rebuild(buildLevel(1));

    assert.strictEqual(scene.meshes.length, first,
      "seven rounds later, the same seed should rebuild to the same scene");
    engine.dispose();
  });

  it("places dynamic meshes exactly where the simulation says they are", () => {
    const { stage, scene, engine } = makeStage();
    const level = buildLevel(4242);
    const course = new Course(stage, level);
    const phase = idlePhase(level);

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
    // Any course with sweeping bars will do - the pool decides which seeds have
    // them, and the convention under test is not seed-specific.
    const level = levelWith((l) => l.obstacles.some((o) => o.kind === "spinner"));
    const course = new Course(stage, level);
    const phase = idlePhase(level);
    const spinners = level.obstacles.filter((o) => o.kind === "spinner");

    const body: Body = {
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, height: 1.72, grounded: true, groundId: 0,
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

        // ...and the reflection of that point across the arm's own axis must
        // NOT hit, or a mirrored hitbox would still pass the check above. The
        // arm axis is the pivot plus the tip direction, so reflect the offset
        // about the perpendicular: rotating it a quarter turn puts it off the
        // arm entirely while staying the same distance from the pivot.
        const armX = tip.x - ob.px, armZ = tip.z - ob.pz;
        if (Math.hypot(armX, armZ) > 3) {
          body.x = ob.px - armZ; body.z = ob.pz + armX;
          hazardHit(body, pose, ob.size.x, ob.size.y, ob.size.z, out);
          assert.ok(!out.hit,
            `tick ${tick}: a point square to the arm ` +
            `(${body.x.toFixed(2)}, ${body.z.toFixed(2)}) must be clear`);
        }
      }
    }
    engine.dispose();
  });

  it("hides a solid obstacle once its pose goes inactive", () => {
    const { stage, scene, engine } = makeStage();
    const level = buildLevel(4242);
    const course = new Course(stage, level);
    const phase = idlePhase(level);

    const gate = level.obstacles.find((o) => o.kind === "startgate")!;
    const mesh = scene.getMeshByName(`ob-${gate.id}`)!;

    course.update(10, { ...phase, raceStartTick: -1 });
    assert.strictEqual(mesh.isEnabled(), true, "the gate is up before the race");

    course.update(200, { ...phase, raceStartTick: 100 });
    assert.strictEqual(mesh.isEnabled(), false, "the gate is gone once the race starts");
    engine.dispose();
  });

  it("draws the tether rope between the runner's hand and the anchor", () => {
    // The smoke run cannot be relied on to reach an anchor, so the attached
    // rendering path is exercised here rather than left to a live match.
    const { stage, scene, engine } = makeStage();
    const level = levelWith((l) => l.anchors.length > 0);
    const course = new Course(stage, level);
    const rope = scene.getMeshByName("tether-rope")!;
    assert.ok(rope, "the course builds one reusable rope");
    assert.strictEqual(rope.isEnabled(), false, "and puts it away when detached");

    const anchor = level.anchors[0];
    const hand = { x: anchor.x + 3, y: anchor.y - 6, z: anchor.z - 2 };
    course.setTether(anchor, hand.x, hand.y, hand.z);

    const length = Math.hypot(anchor.x - hand.x, anchor.y - hand.y, anchor.z - hand.z);
    assert.strictEqual(rope.isEnabled(), true);
    assert.ok(Math.abs(rope.scaling.y - length) < 1e-6,
      `rope is ${rope.scaling.y} long, should be ${length}`);
    assert.ok(Math.abs(rope.position.x - (hand.x + anchor.x) / 2) < 1e-6);
    assert.ok(Math.abs(rope.position.y - (hand.y + anchor.y) / 2) < 1e-6);

    // Its local +Y must end up pointing along the rope, or it is drawn across
    // the runner rather than up to the anchor.
    rope.computeWorldMatrix(true);
    const tip = Vector3.TransformCoordinates(new Vector3(0, 0.5, 0), rope.getWorldMatrix());
    assert.ok(Vector3.Distance(tip, new Vector3(anchor.x, anchor.y, anchor.z)) < 1e-3,
      `the rope ends at ${tip} rather than at the anchor`);

    course.setTether(null, 0, 0, 0);
    assert.strictEqual(rope.isEnabled(), false);
    engine.dispose();
  });

  it("swells only the anchor the aim is on", () => {
    const { stage, scene, engine } = makeStage();
    const level = levelWith((l) => l.anchors.length > 1);
    const course = new Course(stage, level);
    const [first, second] = level.anchors;

    course.setAim(first.id);
    assert.ok(scene.getMeshByName(`anchor-${first.id}`)!.scaling.x > 1.2);
    assert.strictEqual(scene.getMeshByName(`anchor-${second.id}`)!.scaling.x, 1);

    course.setAim(second.id);
    assert.strictEqual(scene.getMeshByName(`anchor-${first.id}`)!.scaling.x, 1,
      "the previous anchor must go back down");
    assert.ok(scene.getMeshByName(`anchor-${second.id}`)!.scaling.x > 1.2);

    course.setAim(-1);
    assert.strictEqual(scene.getMeshByName(`anchor-${second.id}`)!.scaling.x, 1);
    engine.dispose();
  });
});
