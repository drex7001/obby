/**
 * Stage 8 - Recall.
 *
 * The verb is one sentence - restore your own state from forty-five ticks ago -
 * and almost every test here is about the half of that sentence people skip:
 * *your own*. The world does not rewind, the chain does not come back, and the
 * ring the restore reads from is never sent to anybody.
 */

import assert from "assert";

import {
  CHAIN_MAX, CRUMBLE_DELAY_TICKS, KILL_Y, RECALL_ARM_TICKS, RECALL_FINISH_GUARD,
  RECALL_FREEZE_TICKS, RECALL_HISTORY, RECALL_MAX_CHARGES, RECALL_TICKS,
  RESPAWN_TICKS, RUN_SPEED, TICK_RATE,
} from "../../src/shared/constants.js";
import { buildLevel, type Level } from "../../src/shared/level.js";
import type { SimInput, SimState } from "../../src/shared/movement.js";
import {
  clearRecallRing, makeRecallRing, recallSampleAt, recordRecall,
} from "../../src/shared/recall.js";
import {
  createFlatLevel, createSimState, createWorld, firstStateDifference, idleInput,
  levelWith, stepSimulation,
} from "../helpers/simulation.js";

/** A world with a history ring wired in, which is what the verb needs. */
function armed(level: Level) {
  const world = createWorld(level);
  world.history = makeRecallRing();
  return world;
}

const forward: SimInput = { ...idleInput, moveZ: 1 };
const holding: SimInput = { ...forward, use: true };

/** Run a runner forward for `ticks`, then hold `use` long enough to fire. */
function runThenRecall(
  state: SimState, world: ReturnType<typeof armed>, ticks: number, from = 0,
) {
  let tick = from;
  for (let i = 0; i < ticks; i++, tick++) {
    stepSimulation(state, forward, world, tick);
  }
  const before = { x: state.x, y: state.y, z: state.z, tick };
  for (let i = 0; i < RECALL_ARM_TICKS; i++, tick++) {
    stepSimulation(state, holding, world, tick);
  }
  return { tick, before };
}

describe("recall", () => {
  // ==================================================================== the ring

  it("indexes the ring by world tick, so a rollback rewrites rather than shifts", () => {
    const ring = makeRecallRing();
    for (let tick = 0; tick < 30; tick++) {
      recordRecall(ring, tick, tick, 0, 0, 0, 0, 0, true, 0);
    }
    // Re-simulate the last ten with different values, exactly as a rollback
    // replay does. An append-only queue would now remember twice as much past.
    for (let tick = 20; tick < 30; tick++) {
      recordRecall(ring, tick, tick * 100, 0, 0, 0, 0, 0, true, 0);
    }
    assert.strictEqual(recallSampleAt(ring, 25)!.x, 2500, "a replay overwrites its own ticks");
    assert.strictEqual(recallSampleAt(ring, 15)!.x, 15, "and leaves the rest alone");
  });

  it("refuses a slot that has wrapped around to a different moment", () => {
    const ring = makeRecallRing();
    recordRecall(ring, 5, 1, 2, 3, 0, 0, 0, true, 0);
    assert.ok(recallSampleAt(ring, 5));
    // The same slot, one full lap later. Restoring to it would put a runner two
    // seconds into a past that is not theirs.
    assert.strictEqual(recallSampleAt(ring, 5 + RECALL_HISTORY), null);
    assert.strictEqual(recallSampleAt(ring, 6), null, "and an untouched slot is empty");
  });

  it("keeps a continuous history across every early return in the step", () => {
    // The step bails out early on respawn freezes, on the recall freeze, and on
    // falling out of the world. A history with holes is one a restore silently
    // refuses to use, so the sample is taken outside all of that.
    const level = createFlatLevel();
    const world = armed(level);
    const state = createSimState({ y: 0.05 });
    for (let tick = 0; tick < 40; tick++) {
      stepSimulation(state, tick === 10 ? { ...forward, respawn: true } : forward, world, tick);
    }
    for (let tick = 0; tick < 40; tick++) {
      assert.ok(recallSampleAt(world.history!, tick), `tick ${tick} is missing from the ring`);
    }
  });

  // ================================================================== the verb

  it("restores exactly the state from forty-five ticks earlier", () => {
    const level = createFlatLevel();
    const world = armed(level);
    const state = createSimState({ y: 0.05 });

    const { tick } = runThenRecall(state, world, 60);
    const want = recallSampleAt(world.history!, tick - 1 - RECALL_TICKS)!;

    assert.strictEqual(state.x, want.x);
    assert.strictEqual(state.y, want.y);
    assert.strictEqual(state.z, want.z);
    assert.strictEqual(state.vx, want.vx);
    assert.strictEqual(state.vy, want.vy);
    assert.strictEqual(state.vz, want.vz);
    assert.strictEqual(state.grounded, want.grounded);
    assert.strictEqual(state.groundId, want.groundId);
  });

  it("needs the whole four-tick hold, and fires exactly once for it", () => {
    const level = createFlatLevel();
    const world = armed(level);
    const state = createSimState({ y: 0.05 });
    for (let tick = 0; tick < 60; tick++) { stepSimulation(state, forward, world, tick); }

    // Three ticks is a tap, and a tap is a Burn, not a Recall.
    let spends = 0;
    world.onSpend = () => { spends++; };
    for (let tick = 60; tick < 63; tick++) { stepSimulation(state, holding, world, tick); }
    stepSimulation(state, forward, world, 63);
    assert.strictEqual(state.recallCharges, 1, "three ticks must not fire it");
    assert.strictEqual(spends, 1, "a short hold is the Burn");

    // Four is the arm. Holding for forty more does not fire a second one.
    const held = state.recallCharges;
    for (let tick = 64; tick < 104; tick++) { stepSimulation(state, holding, world, tick); }
    assert.strictEqual(state.recallCharges, held - 1, "one hold, one restore");
  });

  it("freezes for the confirmation window and then hands control back moving", () => {
    const level = createFlatLevel();
    const world = armed(level);
    const state = createSimState({ y: 0.05 });
    const { tick } = runThenRecall(state, world, 60);

    assert.strictEqual(state.recallUntil, tick - 1 + RECALL_FREEZE_TICKS);
    const frozen = { x: state.x, z: state.z };
    const speed = Math.hypot(state.vx, state.vz);
    assert.ok(speed > 1, "the restored moment includes how fast the runner was going");

    for (let i = 0; i < RECALL_FREEZE_TICKS - 2; i++) {
      stepSimulation(state, forward, world, tick + i);
      assert.strictEqual(state.x, frozen.x, "nothing moves during the freeze");
      assert.strictEqual(state.z, frozen.z);
      assert.strictEqual(Math.hypot(state.vx, state.vz), speed,
        "and the restored velocity is not thrown away either");
    }

    stepSimulation(state, forward, world, state.recallUntil + 1);
    assert.strictEqual(state.recallUntil, -1, "the freeze ends on its own");
    assert.notStrictEqual(state.z, frozen.z, "and control returns with the runner moving");
  });

  it("always costs the whole Chain", () => {
    const level = createFlatLevel();
    const world = armed(level);
    const state = createSimState({ y: 0.05, chain: CHAIN_MAX });
    runThenRecall(state, world, 60);
    assert.strictEqual(state.chain, 0, "the price is the Chain, in full, every time");
  });

  it("refuses a second restore in the same checkpoint segment", () => {
    const level = createFlatLevel();
    const world = armed(level);
    const state = createSimState({ y: 0.05 });

    let tick = runThenRecall(state, world, 60).tick;
    assert.strictEqual(state.recallCharges, 0);

    tick += RECALL_FREEZE_TICKS + 1;
    for (let i = 0; i < 60; i++, tick++) { stepSimulation(state, forward, world, tick); }
    const where = { x: state.x, z: state.z };
    for (let i = 0; i < RECALL_ARM_TICKS + 4; i++, tick++) {
      stepSimulation(state, holding, world, tick);
    }
    assert.strictEqual(state.recallCharges, 0);
    assert.ok(state.z > where.z, "with no charge the hold does nothing at all");
  });

  it("hands the segment charge back at a checkpoint, and stacks a bought one", () => {
    const level = levelWith((l) => l.checkpoints.length > 1);
    const world = armed(level);
    const cp = level.checkpoints[0];
    const state = createSimState({
      x: cp.volume.x, y: cp.spawn.y + 0.05, z: cp.volume.z,
      checkpoint: -1, recallCharges: 0,
    });

    stepSimulation(state, idleInput, world, 0);
    assert.strictEqual(state.checkpoint, 0, "the fixture must actually bank one");
    assert.strictEqual(state.recallCharges, 1, "banking a checkpoint restores the charge");

    // A charge bought with coins sits on top of the segment one, and no amount
    // of checkpoint banking can push it past the cap.
    state.recallCharges = RECALL_MAX_CHARGES;
    state.checkpoint = 0;
    const second = level.checkpoints[1];
    state.x = second.volume.x; state.y = second.spawn.y + 0.05; state.z = second.volume.z;
    stepSimulation(state, idleInput, world, 1);
    assert.strictEqual(state.recallCharges, RECALL_MAX_CHARGES);
  });

  // ============================================================ the world does not

  it("leaves the world exactly where it was", () => {
    // The platform has moved on and the stone has already collapsed. That is
    // the read the ghost exists to let a player make.
    const level = levelWith((l) => l.obstacles.some((o) => o.kind === "crumble"));
    const world = armed(level);
    const crumble = level.obstacles.find((o) => o.kind === "crumble")!;
    (world.phase.crumbleTicks as number[])[crumble.slot!] = 5;

    // The runner stands on the start line, not on the stone: what is under
    // test is whether the *world* rewinds, not whether they survive the drop.
    const state = createSimState({
      x: level.spawn.x, y: level.spawn.y, z: level.spawn.z,
    });
    for (let tick = 0; tick < 60; tick++) { stepSimulation(state, idleInput, world, tick); }

    const before = Array.from(world.phase.crumbleTicks);
    for (let tick = 60; tick < 60 + RECALL_ARM_TICKS; tick++) {
      stepSimulation(state, { ...idleInput, use: true }, world, tick);
    }
    assert.strictEqual(state.recallCharges, 0, "the fixture must actually recall");
    assert.deepStrictEqual(Array.from(world.phase.crumbleTicks), before,
      "a restore must not un-trigger anything");
    assert.ok(60 > CRUMBLE_DELAY_TICKS, "the fixture must have actually dropped it");
  });

  it("resolves a restore into occupied space through the ordinary collision pass", () => {
    const level = createFlatLevel();
    const world = armed(level);
    const state = createSimState({ y: 0.05 });
    for (let tick = 0; tick < 60; tick++) { stepSimulation(state, forward, world, tick); }

    // Drop a pillar onto the spot the runner is about to be restored into.
    const past = recallSampleAt(world.history!, 59 + RECALL_ARM_TICKS - RECALL_TICKS)!;
    level.solids.push({
      x: past.x, y: 1.5, z: past.z, hx: 2, hy: 2, hz: 2, yaw: 0, style: "wall",
    });

    let tick = 60;
    for (let i = 0; i < RECALL_ARM_TICKS; i++, tick++) {
      stepSimulation(state, holding, world, tick);
    }
    for (let i = 0; i < RECALL_FREEZE_TICKS + 12; i++, tick++) {
      stepSimulation(state, idleInput, world, tick);
    }
    assert.strictEqual(state.recallCharges, 0, "the fixture must actually recall");
    const pillar = level.solids[level.solids.length - 1];
    const inside = Math.abs(state.x - pillar.x) < pillar.hx - 0.1
      && Math.abs(state.z - pillar.z) < pillar.hz - 0.1
      && state.y < pillar.y + pillar.hy - 0.1
      && state.y + 1.72 > pillar.y - pillar.hy + 0.1;
    assert.ok(!inside, `the capsule was left inside the pillar at (${state.x}, ${state.y}, ${state.z})`);
  });

  it("starts an ordinary respawn when the ground it came back to is gone", () => {
    const level = createFlatLevel();
    const world = armed(level);
    const state = createSimState({ y: 0.05 });
    for (let tick = 0; tick < 60; tick++) { stepSimulation(state, forward, world, tick); }

    // Take the floor away entirely. The restore succeeds; the fall is normal.
    level.solids.length = 0;
    let tick = 60;
    for (let i = 0; i < RECALL_ARM_TICKS; i++, tick++) {
      stepSimulation(state, holding, world, tick);
    }
    assert.strictEqual(state.recallCharges, 0, "the restore itself is not special-cased");
    for (let i = 0; i < RECALL_FREEZE_TICKS + TICK_RATE * 3; i++, tick++) {
      stepSimulation(state, idleInput, world, tick);
      if (state.respawn > 0) { break; }
    }
    assert.ok(state.respawn > 0 && state.respawn <= RESPAWN_TICKS,
      "falling out of the world after a recall is just falling out of the world");
    assert.ok(state.y > KILL_Y, "and it respawns rather than sinking forever");
  });

  // ================================================================ the guards

  it("is refused on the doorstep of the finish", () => {
    const level = levelWith(() => true);
    const world = armed(level);
    const state = createSimState({
      x: level.finish.x, y: level.finishGroundY + 0.05, z: level.finish.z,
      recallCharges: 1,
    });
    for (let tick = 0; tick < 60; tick++) { stepSimulation(state, idleInput, world, tick); }
    for (let tick = 60; tick < 60 + RECALL_ARM_TICKS + 2; tick++) {
      stepSimulation(state, { ...idleInput, use: true }, world, tick);
    }
    assert.strictEqual(state.recallCharges, 1,
      "a restore this close to the line is a second attempt at the finish");
    assert.ok(RECALL_FINISH_GUARD > RUN_SPEED * 0.5,
      "the guard has to be worth more than a stride");

    // ...and it is the distance doing it, not a missing history: step back off
    // the doorstep with the same ring and the same charge, and it fires.
    state.x = level.finish.x + RECALL_FINISH_GUARD + 2;
    for (let tick = 70; tick < 130; tick++) { stepSimulation(state, idleInput, world, tick); }
    for (let tick = 130; tick < 130 + RECALL_ARM_TICKS; tick++) {
      stepSimulation(state, { ...idleInput, use: true }, world, tick);
    }
    assert.strictEqual(state.recallCharges, 0, "off the doorstep it is an ordinary recall");
  });

  it("is refused when the ring cannot reach back far enough", () => {
    const level = createFlatLevel();
    const world = armed(level);
    const state = createSimState({ y: 0.05 });
    // Only twenty ticks of history exist, and the verb wants forty-five.
    for (let tick = 0; tick < 20; tick++) { stepSimulation(state, forward, world, tick); }
    for (let tick = 20; tick < 20 + RECALL_ARM_TICKS; tick++) {
      stepSimulation(state, holding, world, tick);
    }
    assert.strictEqual(state.recallCharges, 1, "no history, no restore, no charge spent");
  });

  it("cannot be fired again from inside its own freeze", () => {
    const level = createFlatLevel();
    const world = armed(level);
    const state = createSimState({ y: 0.05, recallCharges: RECALL_MAX_CHARGES });
    const { tick } = runThenRecall(state, world, 60);
    assert.strictEqual(state.recallCharges, RECALL_MAX_CHARGES - 1);

    for (let i = 0; i < RECALL_FREEZE_TICKS - 1; i++) {
      stepSimulation(state, holding, world, tick + i);
    }
    assert.strictEqual(state.recallCharges, RECALL_MAX_CHARGES - 1,
      "the second charge is not spendable until the freeze is over");
  });

  // ================================================================= netcode

  it("replays a restore bit-identically", () => {
    const run = (replay: boolean) => {
      const level = createFlatLevel();
      const world = armed(level);
      const state = createSimState({ y: 0.05, chain: 5 });
      for (let tick = 0; tick < 90; tick++) {
        const held = tick >= 60 && tick < 68;
        stepSimulation(state, held ? holding : forward, world, tick, replay);
      }
      return state;
    };
    const live = run(false);
    const replayed = run(true);
    assert.strictEqual(firstStateDifference(live, replayed), null,
      "a replayed restore must land on exactly the same state");
    assert.strictEqual(live.recallCharges, 0, "the fixture must actually fire");
  });

  it("keeps the ring off the wire and out of the simulated state", () => {
    // The ring is server-side and client-side, and synchronised by neither: the
    // *result* of a restore is ordinary simulated state the reconciler handles.
    const state = createSimState();
    for (const key of Object.keys(state)) {
      assert.ok(!key.toLowerCase().includes("history"),
        `${key} looks like history on the wire`);
    }
    assert.ok(RECALL_HISTORY > RECALL_TICKS,
      "the ring has to outreach the verb, with room for a replay on top");
  });

  it("bounds the ring, whatever the length of the race", () => {
    const ring = makeRecallRing();
    assert.strictEqual(ring.length, RECALL_HISTORY);
    for (let tick = 0; tick < TICK_RATE * 300; tick++) {
      recordRecall(ring, tick, tick, 0, 0, 0, 0, 0, true, 0);
    }
    assert.strictEqual(ring.length, RECALL_HISTORY, "a five-minute race must not grow it");
    clearRecallRing(ring);
    assert.strictEqual(recallSampleAt(ring, TICK_RATE * 300 - 1), null,
      "and a new round is a new past");
  });

  it("costs nothing on a course a runner never recalls on", () => {
    // Regression guard on the split step: the ring is written on every path
    // through stepPlayer, and none of that may change the simulation.
    const level = buildLevel(31);
    const bare = createWorld(level);
    const withRing = armed(level);
    const a = createSimState({ y: level.spawn.y, z: level.spawn.z });
    const b = createSimState({ y: level.spawn.y, z: level.spawn.z });
    for (let tick = 0; tick < 120; tick++) {
      stepSimulation(a, forward, bare, tick);
      stepSimulation(b, forward, withRing, tick);
    }
    assert.strictEqual(firstStateDifference(a, b), null,
      "keeping a history must not change what the history is of");
  });
});
