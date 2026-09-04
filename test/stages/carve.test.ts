import assert from "assert";

import { CARVE_COOL_TICKS, HOP_SPEED_BONUS, LAUNCH_CHAIN, LAUNCH_WINDOW, RUN_SPEED } from "../../src/shared/constants.js";
import {
  createFlatLevel, createSimState, createWorld, idleInput, stepSimulation,
} from "../helpers/simulation.js";

describe("carve", () => {
  it("enters at the speed threshold, applies cooldown after exit, and can re-enter when it expires", () => {
    const state = createSimState({ y: 0, vz: RUN_SPEED });
    const world = createWorld(createFlatLevel());
    world.phase.raceStartTick = -1;

    stepSimulation(state, { ...idleInput, alt: true }, world, 1);
    assert.strictEqual(state.carving, true);

    stepSimulation(state, idleInput, world, 2);
    assert.strictEqual(state.carving, false);
    assert.strictEqual(state.carveCool, 2 + CARVE_COOL_TICKS);

    stepSimulation(state, { ...idleInput, alt: true }, world, 3);
    assert.strictEqual(state.carving, false, "cooldown must prevent an immediate re-entry");

    stepSimulation(state, { ...idleInput, alt: true }, world, 2 + CARVE_COOL_TICKS);
    assert.strictEqual(state.carving, true, "Carve should be available on its cooldown stamp");
  });

  it("stays carved when standing up would expand the capsule into a ceiling", () => {
    const state = createSimState({ carving: true, carveUntil: 100, vx: 8 });

    stepSimulation(state, idleInput, createWorld(createFlatLevel(true)), 10);

    assert.strictEqual(state.carving, true);
  });

  it("opens an eight-tick hop window on a safe stand-up and awards Chain to a hop", () => {
    const state = createSimState({ carving: true, carveUntil: 100, vx: 8, z: 6 });
    const world = createWorld(createFlatLevel());

    stepSimulation(state, idleInput, world, 10);
    assert.strictEqual(state.carving, false);
    assert.strictEqual(state.hopWindow, 8);

    stepSimulation(state, { ...idleInput, jump: true }, world, 11);
    assert.strictEqual(state.chain, 1);
  });

  it("awards the 10% hop bonus on the eighth input after exit but not the ninth", () => {
    const world = createWorld(createFlatLevel());
    world.phase.raceStartTick = -1;
    const withinWindow = createSimState({ y: 0, carving: true, carveUntil: 100, vx: 8, z: 6 });
    const expiredWindow = createSimState({ y: 0, carving: true, carveUntil: 100, vx: 8, z: 6 });

    stepSimulation(withinWindow, idleInput, world, 10);
    stepSimulation(expiredWindow, idleInput, createWorld(createFlatLevel()), 10);
    for (let tick = 11; tick <= 17; tick++) {
      stepSimulation(withinWindow, idleInput, world, tick);
      stepSimulation(expiredWindow, idleInput, createWorld(createFlatLevel()), tick);
    }
    expiredWindow.hopWindow = 0;
    stepSimulation(withinWindow, { ...idleInput, jump: true }, world, 18);
    stepSimulation(expiredWindow, { ...idleInput, jump: true }, createWorld(createFlatLevel()), 18);
    const withoutHopSpeed = Math.hypot(expiredWindow.vx, expiredWindow.vz);

    assert.strictEqual(withinWindow.chain, 1);
    assert.ok(Math.abs(Math.hypot(withinWindow.vx, withinWindow.vz) / withoutHopSpeed - (1 + HOP_SPEED_BONUS)) < 1e-9);

    const ninthInput = createSimState({ y: 0, carving: true, carveUntil: 100, vx: 8, z: 6 });
    const ninthWorld = createWorld(createFlatLevel());
    ninthWorld.phase.raceStartTick = -1;
    stepSimulation(ninthInput, idleInput, ninthWorld, 10);
    for (let tick = 11; tick <= 18; tick++) { stepSimulation(ninthInput, idleInput, ninthWorld, tick); }
    stepSimulation(ninthInput, { ...idleInput, jump: true }, ninthWorld, 19);
    assert.strictEqual(ninthInput.chain, 0, "the hop window closes before the ninth post-exit input");
  });

  it("allows higher Chain to make a stronger air-control correction", () => {
    const noChain = createSimState({ y: 4, grounded: false });
    const fullChain = createSimState({ y: 4, grounded: false, chain: 8 });
    const input = { ...idleInput, moveZ: 1 };

    stepSimulation(noChain, input, createWorld(createFlatLevel()), 1);
    stepSimulation(fullChain, input, createWorld(createFlatLevel()), 1);

    assert.ok(fullChain.vz > noChain.vz,
      `expected Chain air control to improve acceleration (${fullChain.vz} <= ${noChain.vz})`);
  });

  it("enters a Dive from air and preserves its Carve state through landing", () => {
    const state = createSimState({ y: 0.5, vy: -2, grounded: false, vz: 5 });
    const world = createWorld(createFlatLevel());

    stepSimulation(state, { ...idleInput, alt: true }, world, 1);

    assert.strictEqual(state.carving, true);
    assert.ok(state.vz > 5, "Dive should add its forward impulse before landing");
  });

  it("banks checkpoints and holds normal plates while carved", () => {
    const level = createFlatLevel();
    level.checkpoints.push({
      index: 0,
      volume: { x: 0, y: 0.5, z: 0, hx: 4, hy: 1, hz: 4, yaw: 0 },
      spawn: { x: 0, y: 0, z: 0 }, yaw: 0, label: "Carve checkpoint",
    });
    level.plates.push({
      id: 0,
      volume: { x: 0, y: 0.5, z: 0, hx: 4, hy: 1, hz: 4, yaw: 0 },
      activation: "hold", holdTicks: 30, label: "Carve plate",
    });
    const world = createWorld(level);
    world.phase.raceStartTick = -1;
    const state = createSimState({ y: 0, carving: true, carveUntil: 100, vx: 8 });

    stepSimulation(state, { ...idleInput, alt: true }, world, 10);

    assert.strictEqual(state.checkpoint, 0);
    assert.ok(world.phase.plateTicks[0] > 10);
  });

  it("awards launch Chain symmetrically at either edge of the launch window", () => {
    for (const tick of [100 - LAUNCH_WINDOW, 100 + LAUNCH_WINDOW]) {
      const state = createSimState({ y: 0 });
      const world = createWorld(createFlatLevel());
      world.phase.raceStartTick = 100;
      stepSimulation(state, { ...idleInput, jump: true }, world, tick);
      assert.strictEqual(state.chain, LAUNCH_CHAIN, `tick ${tick} should receive the launch reward`);
    }
  });

  it("fits below the raised Gauntlet bar only while carving", () => {
    const level = createFlatLevel();
    level.obstacles.push({
      id: 1, kind: "slider", role: "hazard", style: "raised-bar",
      size: { x: 8, y: 0.12, z: 0.8 }, px: 0, py: 1.35, pz: 0,
      a: { x: 0, y: 1.35, z: 0 }, b: { x: 0, y: 1.35, z: 0 }, period: 1,
    });
    const standing = createSimState();
    stepSimulation(standing, idleInput, createWorld(level), 1);
    assert.ok(standing.stun > 0, "a standing capsule should hit the bar");

    const carving = createSimState({ carving: true, carveUntil: 100, vx: 8 });
    stepSimulation(carving, { ...idleInput, alt: true }, createWorld(level), 1);
    assert.strictEqual(carving.stun, 0, "a carving capsule should clear the bar");
  });
});
