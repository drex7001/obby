import assert from "assert";

import { PITCH_MAX, PITCH_MIN } from "../../src/shared/constants.js";
import { raycastWorld, type RayHit } from "../../src/shared/collision.js";
import { sanitizeRaceInput } from "../../src/shared/input.js";
import { buildLevel } from "../../src/shared/level.js";
import { mulberry32 } from "../../src/shared/math.js";
import type { SimInput } from "../../src/shared/movement.js";
import {
  clonePhase, createFlatLevel, createSimState, createWorld, firstStateDifference,
  simulationContext, stepSimulation,
} from "../helpers/simulation.js";

describe("foundations", () => {
  it("coerces malformed packet fields and clamps pitch before simulation", () => {
    const malformed = {
      moveX: Number.NaN, moveZ: Number.POSITIVE_INFINITY, yaw: Number.NaN,
      pitch: 50, jump: 1 as unknown as boolean, action: 0 as unknown as boolean,
      alt: "held" as unknown as boolean, use: undefined as unknown as boolean,
      respawn: null as unknown as boolean,
    };

    sanitizeRaceInput(malformed);

    assert.deepStrictEqual(malformed, {
      moveX: 0, moveZ: 0, yaw: 0, pitch: PITCH_MAX,
      jump: true, action: false, alt: true, use: false, respawn: false,
    });
    malformed.pitch = -50;
    sanitizeRaceInput(malformed);
    assert.strictEqual(malformed.pitch, PITCH_MIN);
  });

  it("replays every simulated field from every seeded snapshot", () => {
    for (let seed = 1; seed <= 16; seed++) {
      const random = mulberry32(seed);
      const inputs: SimInput[] = [];
      for (let tick = 0; tick < 120; tick++) {
        const axis = () => random() < 0.35 ? -1 : random() > 0.65 ? 1 : 0;
        inputs.push({
          moveX: axis(), moveZ: axis(), yaw: (random() * 2 - 1) * Math.PI,
          pitch: (random() * 2 - 1) * PITCH_MAX, jump: random() < 0.12,
          action: random() < 0.2, alt: random() < 0.18, use: random() < 0.1,
          respawn: tick === 83 && seed % 3 === 0,
        });
      }

      const level = buildLevel(seed * 199);
      const liveState = createSimState({ x: 0, y: 0.05, z: -14 });
      const liveWorld = createWorld(level);
      const snapshots: Array<{ tick: number; state: ReturnType<typeof createSimState>; phase: ReturnType<typeof clonePhase> }> = [];

      for (let index = 0; index < inputs.length; index++) {
        stepSimulation(liveState, inputs[index], liveWorld, index + 1);
        if ((index + 1) % 10 === 0) {
          snapshots.push({
            tick: index + 1,
            state: { ...liveState },
            phase: clonePhase(liveWorld.phase),
          });
        }
      }

      for (const snapshot of snapshots) {
        const replayState = { ...snapshot.state };
        const replayWorld = createWorld(level);
        replayWorld.phase = clonePhase(snapshot.phase);
        for (let index = snapshot.tick; index < inputs.length; index++) {
          stepSimulation(replayState, inputs[index], replayWorld, index + 1, true);
        }
        const field = firstStateDifference(liveState, replayState);
        assert.strictEqual(field, null, `seed ${seed}, snapshot ${snapshot.tick}, field ${field}`);
      }
    }
    simulationContext.tick = 0;
    simulationContext.isReplay = false;
  });

  it("returns a stable hit and outward normal for rotated static geometry", () => {
    const level = createFlatLevel();
    level.solids.push({ x: 2, y: 1, z: 0, hx: 0.5, hy: 1, hz: 2, yaw: Math.PI / 4, style: "wall" });
    const hit: RayHit = { dist: -1, kind: "solid", obstacleId: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0 };

    raycastWorld(level, createWorld(level).phase, 17.5, -4, 1, 0, 1, 0, 0, 12, hit);

    assert.strictEqual(hit.kind, "solid");
    assert.ok(hit.dist > 0, "the ray should intersect the rotated wall");
    assert.ok(hit.nx < 0, "the normal should face the ray origin");
  });

  it("returns identical dynamic-ray results at the same fractional world tick", () => {
    const level = buildLevel(2024);
    const first: RayHit = { dist: -1, kind: "solid", obstacleId: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0 };
    const second: RayHit = { ...first };

    raycastWorld(level, createWorld(level).phase, 117.25, 0, 2, 52, 0, -0.1, 1, 20, first);
    raycastWorld(level, createWorld(level).phase, 117.25, 0, 2, 52, 0, -0.1, 1, 20, second);

    assert.deepStrictEqual(second, first);
  });
});
