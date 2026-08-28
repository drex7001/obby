import assert from "assert";

import {
  BACK_SCALE, CHAIN_MAX, MAX_SPEED, OVERSPEED_DECAY, PLAYER_RADIUS, RUN_SPEED, STRAFE_SCALE, TICK_RATE,
} from "../../src/shared/constants.js";
import { mulberry32 } from "../../src/shared/math.js";
import { softCap } from "../../src/shared/movement.js";
import {
  createFlatLevel, createSimState, createWorld, idleInput, stepSimulation,
} from "../helpers/simulation.js";

function runFor(state: ReturnType<typeof createSimState>, input: typeof idleInput, ticks: number) {
  const world = createWorld(createFlatLevel());
  for (let tick = 1; tick <= ticks; tick++) { stepSimulation(state, input, world, tick); }
}

describe("momentum", () => {
  it("builds speed gradually instead of reaching the soft cap in one input", () => {
    const state = createSimState();
    runFor(state, { ...idleInput, moveZ: 1 }, 12);

    const speed = Math.hypot(state.vx, state.vz);
    assert.ok(speed >= RUN_SPEED * 0.9 && speed <= RUN_SPEED,
      `expected 90% of the soft cap in the tuned window, got ${speed.toFixed(3)}`);
  });

  it("scales strafe and backpedal targets from facing direction", () => {
    const forward = createSimState();
    const strafe = createSimState();
    const backward = createSimState();
    runFor(forward, { ...idleInput, moveZ: 1 }, 90);
    runFor(strafe, { ...idleInput, moveX: 1 }, 90);
    runFor(backward, { ...idleInput, moveZ: -1 }, 90);

    assert.ok(Math.abs(Math.hypot(strafe.vx, strafe.vz) / Math.hypot(forward.vx, forward.vz) - STRAFE_SCALE) < 0.025);
    assert.ok(Math.abs(Math.hypot(backward.vx, backward.vz) / Math.hypot(forward.vx, forward.vz) - BACK_SCALE) < 0.025);
  });

  it("uses Chain as an additive soft cap and decays excess speed rather than clamping it", () => {
    const state = createSimState({ y: 0, chain: CHAIN_MAX });
    const cap = softCap(state);
    assert.strictEqual(cap, RUN_SPEED * 1.28);

    const world = createWorld(createFlatLevel());
    state.vz = cap + 2;
    stepSimulation(state, idleInput, world, 1);

    assert.ok(state.vz > cap, "overspeed should remain after the tick that decays it");
    assert.ok(Math.abs(state.vz - (cap + 2 - OVERSPEED_DECAY / TICK_RATE)) < 1e-9,
      `overspeed must decay at exactly ${OVERSPEED_DECAY} u/s², got ${state.vz}`);
  });

  it("accelerates downhill along a ramp", () => {
    const level = createFlatLevel();
    level.ramps.push({ x: 0, z: 0, hx: 8, hz: 6, y0: 0, y1: 4, style: "ramp" });
    const state = createSimState({ y: 2, z: 0, grounded: true });

    stepSimulation(state, idleInput, createWorld(level), 1);

    assert.ok(state.vz < 0, `a +Z uphill should accelerate an idle runner downhill, got ${state.vz}`);
  });

  it("loses measurable speed while travelling uphill compared with flat ground", () => {
    const flat = createSimState({ vz: 5 });
    stepSimulation(flat, idleInput, createWorld(createFlatLevel()), 1);

    const rampLevel = createFlatLevel();
    rampLevel.ramps.push({ x: 0, z: 0, hx: 8, hz: 6, y0: 0, y1: 4, style: "ramp" });
    const uphill = createSimState({ y: 2, z: 0, grounded: true, vz: 5 });
    stepSimulation(uphill, idleInput, createWorld(rampLevel), 1);

    assert.ok(uphill.vz < flat.vz, `uphill (${uphill.vz}) should cost speed against flat (${flat.vz})`);
  });

  it("does not tunnel through thin walls at hard-cap speed across seeded approach angles", () => {
    const angles = 8;
    for (let seed = 1; seed <= 1000; seed++) {
      const random = mulberry32(seed);
      const level = createFlatLevel();
      const wall = {
        x: (random() - 0.5) * 12,
        y: 1,
        z: (random() - 0.5) * 12,
        hx: 0.04,
        hy: 1,
        hz: 0.04,
        yaw: random() * Math.PI,
        style: "thin-wall",
      };
      level.solids.push(wall);

      for (let index = 0; index < angles; index++) {
        const angle = (Math.PI * 2 * index) / angles;
        const outwardX = Math.cos(angle);
        const outwardZ = Math.sin(angle);
        const state = createSimState({
          x: wall.x + outwardX * (PLAYER_RADIUS + 0.38),
          y: 0,
          z: wall.z + outwardZ * (PLAYER_RADIUS + 0.38),
          vx: -outwardX * MAX_SPEED,
          vz: -outwardZ * MAX_SPEED,
        });

        stepSimulation(state, idleInput, createWorld(level), 1);

        const side = (state.x - wall.x) * outwardX + (state.z - wall.z) * outwardZ;
        assert.ok(side > -1e-6, `seed ${seed}, angle ${index} crossed the thin wall`);
      }
    }
  });
});
