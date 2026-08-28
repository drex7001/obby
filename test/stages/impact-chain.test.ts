import assert from "assert";

import { CHAIN_DECAY_TICKS, HEAVY_KNOCK, HEAVY_PLANT_TICKS } from "../../src/shared/constants.js";
import {
  createFlatLevel, createSimState, createWorld, idleInput, stepSimulation,
} from "../helpers/simulation.js";

function createFallingRunner(overrides: Parameters<typeof createSimState>[0] = {}) {
  return createSimState({ y: 0.05, vy: -9, grounded: false, vz: 10, ...overrides });
}

describe("impact and chain", () => {
  it("converts a press in the landing window into Perfect Impact and Chain", () => {
    const state = createFallingRunner();

    stepSimulation(state, { ...idleInput, alt: true }, createWorld(createFlatLevel()), 10);

    assert.strictEqual(state.chain, 1);
    assert.ok(state.vz > 10, "Perfect should convert impact speed in the facing direction");
  });

  it("keeps 85% speed for a Neutral landing without breaking Chain", () => {
    const state = createFallingRunner({ chain: 3 });

    stepSimulation(state, idleInput, createWorld(createFlatLevel()), 10);

    assert.strictEqual(state.chain, 3);
    assert.ok(state.vz > 8.1 && state.vz < 8.5, `expected 85% retention, got ${state.vz}`);
  });

  it("treats a buffered press outside the landing window as a Fumble", () => {
    const state = createFallingRunner({ impactBuf: 1, heavyHeld: true, heavySince: 5, chain: 4 });

    stepSimulation(state, { ...idleInput, alt: true }, createWorld(createFlatLevel()), 10);

    assert.strictEqual(state.chain, 0);
    assert.ok(state.vz > 6.2 && state.vz < 6.8, `expected 65% retention, got ${state.vz}`);
  });

  it("keeps the Perfect boundary through four ticks and fumbles the fifth", () => {
    const boundaryPerfect = createFallingRunner({ impactBuf: 3, heavyHeld: true, chain: 2 });
    stepSimulation(boundaryPerfect, { ...idleInput, alt: true }, createWorld(createFlatLevel()), 10);
    assert.strictEqual(boundaryPerfect.chain, 3, "a four-tick-old press should be Perfect");

    const oneTickLate = createFallingRunner({ impactBuf: 2, heavyHeld: true, chain: 2 });
    stepSimulation(oneTickLate, { ...idleInput, alt: true }, createWorld(createFlatLevel()), 10);
    assert.strictEqual(oneTickLate.chain, 0, "a five-tick-old press should Fumble");
  });

  it("commits Heavy after its hold, publishes its shockwave, and cannot be cancelled", () => {
    const level = createFlatLevel();
    const state = createFallingRunner({ heavyHeld: true, heavySince: 2, chain: 5 });
    const world = createWorld(level);
    let radius = 0;
    world.onHeavy = (_x, _y, _z, resolvedRadius) => { radius = resolvedRadius; };

    stepSimulation(state, { ...idleInput, alt: true }, world, 10);

    assert.strictEqual(state.vz, 0);
    assert.strictEqual(state.chain, 0);
    assert.ok(radius >= 2 && radius <= 6, `unexpected Heavy radius: ${radius}`);
    assert.strictEqual(state.plantUntil, 10 + HEAVY_PLANT_TICKS,
      "Heavy plant duration should be published from its landing stamp");

    const committed = createFallingRunner({ heavyArmed: true, heavySince: 2 });
    stepSimulation(committed, idleInput, createWorld(level), 10);
    assert.strictEqual(committed.vz, 0, "releasing alt must not cancel an armed Heavy");
  });

  it("arms Heavy only while descending and never from a Carve hold", () => {
    const state = createSimState({ carving: true, carveUntil: 100, vx: 8 });
    const world = createWorld(createFlatLevel());

    for (let tick = 1; tick <= 9; tick++) {
      stepSimulation(state, { ...idleInput, alt: true }, world, tick);
    }

    assert.strictEqual(state.carving, true, "the held input should remain a Carve");
    assert.strictEqual(state.heavyArmed, false, "Carve time must not count toward Heavy");
    assert.strictEqual(state.heavySince, -1, "only descending time may begin a Heavy hold");
  });

  it("fires Heavy-only plates and nearby crumble floors without normal plate contact", () => {
    const level = createFlatLevel();
    level.plates.push({
      id: 0,
      volume: { x: 0, y: 0.25, z: 0, hx: 2, hy: 0.5, hz: 2 },
      activation: "heavy",
      holdTicks: 90,
      label: "Heavy test plate",
    });
    level.obstacles.push({
      id: 1, kind: "crumble", role: "solid", style: "crumble-test",
      size: { x: 4, y: 0.2, z: 4 }, px: 0, py: -0.3, pz: 0, slot: 0,
    });
    level.crumbleCount = 1;
    const world = createWorld(level);
    const state = createFallingRunner({ heavyArmed: true, chain: 3 });

    stepSimulation(state, idleInput, world, 10);

    assert.ok(world.phase.plateTicks[0] > 10, "Heavy should stamp the Heavy-only plate");
    assert.strictEqual(world.phase.crumbleTicks[0], 10, "Heavy should stamp the fragile floor");
  });

  it("does not fire a Heavy-only plate for a Perfect landing", () => {
    const level = createFlatLevel();
    level.plates.push({
      id: 0,
      volume: { x: 0, y: 0.25, z: 0, hx: 2, hy: 0.5, hz: 2 },
      activation: "heavy",
      holdTicks: 90,
      label: "Heavy test plate",
    });
    const world = createWorld(level);

    stepSimulation(createFallingRunner(), { ...idleInput, alt: true }, world, 10);

    assert.strictEqual(world.phase.plateTicks[0], -1);
  });

  it("breaks the lander's Chain only when the authoritative landing-contact check says so", () => {
    const serverState = createFallingRunner({ chain: 4 });
    const serverWorld = createWorld(createFlatLevel());
    serverWorld.hasLandingContact = () => true;
    stepSimulation(serverState, idleInput, serverWorld, 10);
    assert.strictEqual(serverState.chain, 0);

    const predictedState = createFallingRunner({ chain: 4 });
    stepSimulation(predictedState, idleInput, createWorld(createFlatLevel()), 10);
    assert.strictEqual(predictedState.chain, 4, "a client must not infer contact from interpolated runners");
  });

  it("applies a late stamped knock as a victim impulse without a position correction", () => {
    const state = createSimState({ x: 3, z: 4, knockTick: 4, knockX: HEAVY_KNOCK, knockY: 2, knockZ: 0 });
    const before = { x: state.x, z: state.z };

    stepSimulation(state, idleInput, createWorld(createFlatLevel()), 10);

    assert.ok(state.vx > HEAVY_KNOCK * 0.95, `expected stamped impulse, got ${state.vx}`);
    assert.notDeepStrictEqual({ x: state.x, z: state.z }, before, "normal integration should continue from the victim position");
    assert.strictEqual(state.knockTick, -1, "the victim consumes a knock stamp once");
  });

  it("decays one Chain point per second after the conversion-free expiry stamp", () => {
    const state = createSimState({ y: 0, chain: 3, chainDecayUntil: 10 });
    const world = createWorld(createFlatLevel());

    stepSimulation(state, idleInput, world, 10);
    assert.strictEqual(state.chain, 2);
    assert.strictEqual(state.chainDecayUntil, 10 + CHAIN_DECAY_TICKS / 3);
  });
});
