import type { Level } from "../../src/shared/level.js";
import {
  SUB_STEPS, TICK_RATE,
} from "../../src/shared/constants.js";
import {
  stepPlayer, type SimInput, type SimState, type SimWorld,
} from "../../src/shared/movement.js";
import type { WorldPhase } from "../../src/shared/obstacles.js";

/** Reused fixed-step context. Tests set its tick through `stepSimulation()`. */
export const simulationContext = {
  dt: 1 / TICK_RATE,
  tick: 0,
  subSteps: SUB_STEPS,
  subDt: 1 / (TICK_RATE * SUB_STEPS),
  isReplay: false,
};

export function createSimState(overrides: Partial<SimState> = {}): SimState {
  return {
    x: 0, y: 0.05, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0,
    grounded: true, groundId: 0, coyote: 0, jumpBuf: 0, jumpHeld: false,
    stun: 0, respawn: 0, checkpoint: -1, progress: 0,
    chain: 0, impactBuf: 0, heavyHeld: false, heavyArmed: false, heavySince: -1,
    plantUntil: -1, chainDecayUntil: -1,
    carving: false, carveUntil: -1, carveCool: -1, hopWindow: 0,
    knockTick: -1, knockX: 0, knockY: 0, knockZ: 0,
    ...overrides,
  };
}

export const idleInput: SimInput = {
  moveX: 0, moveZ: 0, yaw: 0, pitch: 0, jump: false,
  action: false, alt: false, use: false, respawn: false,
};

/** A deterministic level with a wide floor, suitable for isolated mechanics. */
export function createFlatLevel(withLowCeiling = false): Level {
  const solids = [{ x: 0, y: -0.5, z: 0, hx: 20, hy: 0.5, hz: 20, yaw: 0, style: "floor" }];
  if (withLowCeiling) {
    // The 0.95u underside fits a carving capsule but not a standing capsule.
    solids.push({ x: 0, y: 1.05, z: 0, hx: 2, hy: 0.1, hz: 2, yaw: 0, style: "low-ceiling" });
  }
  return {
    seed: 1, solids, ramps: [], obstacles: [], checkpoints: [], plates: [],
    finish: { x: 999, y: 0, z: 999, hx: 1, hy: 1, hz: 1 }, finishGroundY: 0,
    spawn: { x: 0, y: 0.05, z: 0 }, spawnYaw: 0,
    path: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 10 }], pathLength: 10, pathCum: [0, 10],
    crumbleCount: 0, notes: [],
  };
}

export function createWorld(level: Level): SimWorld & { phase: WorldPhase } {
  const phase: WorldPhase = {
    raceStartTick: 0,
    crumbleTicks: new Array(level.crumbleCount).fill(-1),
    plateTicks: new Array(level.plates.length).fill(-1),
    plateSince: new Array(level.plates.length).fill(-1),
  };
  const world: SimWorld & { phase: WorldPhase } = {
    level, phase, tickBase: 0, others: [],
  };
  world.onCrumble = (slot, tick) => {
    if (world.phase.crumbleTicks[slot] < 0) { (world.phase.crumbleTicks as number[])[slot] = tick; }
  };
  world.onPlate = (plate, tick) => {
    if (world.phase.plateTicks[plate] < 0) { (world.phase.plateSince as number[])[plate] = tick; }
    (world.phase.plateTicks as number[])[plate] = tick + level.plates[plate].holdTicks;
  };
  world.onHeavyPlate = world.onPlate;
  return world;
}

export function stepSimulation(
  state: SimState, input: SimInput, world: SimWorld, tick: number, replay = false,
) {
  simulationContext.tick = tick;
  simulationContext.isReplay = replay;
  stepPlayer(simulationContext, state, input, world);
}

export function clonePhase(phase: WorldPhase): WorldPhase {
  return {
    raceStartTick: phase.raceStartTick,
    crumbleTicks: Array.from(phase.crumbleTicks),
    plateTicks: Array.from(phase.plateTicks),
    plateSince: Array.from(phase.plateSince),
  };
}

export function firstStateDifference(a: SimState, b: SimState): string | null {
  for (const key of Object.keys(a) as Array<keyof SimState>) {
    if (!Object.is(a[key], b[key])) { return key; }
  }
  return null;
}
