import assert from "assert";

import { SUB_STEPS, TICK_RATE, KILL_Y, STUN_TICKS } from "../src/shared/constants.js";
import { buildLevel, CRUMBLE_DELAY_TICKS, type Level } from "../src/shared/level.js";
import { makePose, poseAt, type WorldPhase } from "../src/shared/obstacles.js";
import {
  stepPlayer, type SimInput, type SimState, type SimWorld,
} from "../src/shared/movement.js";
import { checkpointProgress } from "../src/shared/progress.js";

const ctx = {
  dt: 1 / TICK_RATE,
  tick: 0,
  subSteps: SUB_STEPS,
  subDt: 1 / (TICK_RATE * SUB_STEPS),
  isReplay: false,
};

function freshWorld(level: Level): SimWorld & { phase: WorldPhase } {
  return {
    level,
    phase: {
      raceStartTick: 0,
      crumbleTicks: new Array(level.crumbleCount).fill(-1),
      plateTicks: new Array(level.plates.length).fill(-1),
      plateSince: new Array(level.plates.length).fill(-1),
    },
    tickBase: 0,
    others: [],
  };
}

function player(over: Partial<SimState> = {}): SimState {
  return {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0,
    grounded: true, groundId: 0, coyote: 0, jumpBuf: 0, jumpHeld: false,
    stun: 0, respawn: 0, checkpoint: -1, progress: 0,
    chain: 0, impactBuf: 0, heavyHeld: false, heavyArmed: false, heavySince: -1,
    plantUntil: -1, chainDecayUntil: -1,
    carving: false, carveUntil: -1, carveCool: -1, hopWindow: 0,
    knockTick: -1, knockX: 0, knockY: 0, knockZ: 0,
    ...over,
  };
}

const idle: SimInput = {
  moveX: 0, moveZ: 0, yaw: 0, pitch: 0, jump: false,
  action: false, alt: false, use: false, respawn: false,
};
const forward: SimInput = { ...idle, moveZ: 1 };

function run(state: SimState, cmd: SimInput, world: SimWorld, from: number, ticks: number) {
  for (let i = 0; i < ticks; i++) {
    ctx.tick = from + i;
    stepPlayer(ctx, state, cmd, world);
  }
  ctx.tick = 0;
  return state;
}

describe("movement", () => {
  const level = buildLevel(2024);

  it("accelerates toward the run speed and stays on the ground", () => {
    const world = freshWorld(level);
    const p = player({ x: 0, y: 0.05, z: -14 });
    run(p, forward, world, 1, 30);

    assert.ok(p.grounded, "should still be standing on the lobby floor");
    assert.ok(p.z > -14, "should have moved forward");
    assert.ok(Math.abs(p.y) < 0.01, `should rest on the floor, got y=${p.y}`);
  });

  it("never lets a floor eject the player sideways", () => {
    // Regression: an ulp of float error at the contact plane used to make the
    // horizontal pass treat the floor underfoot as a wall the body was buried
    // inside, launching it half a platform sideways.
    //
    // Held in the lobby with the start gate still shut, so the only things
    // touching the player are the floor and the gate - no hazard can supply a
    // sideways impulse of its own and mask the bug.
    const world = freshWorld(level);
    world.phase.raceStartTick = -1;
    const p = player({ x: 0, y: 0.05, z: -14 });

    for (let i = 0; i < 90; i++) {
      ctx.tick = i + 1;
      stepPlayer(ctx, p, forward, world);
      assert.ok(Math.abs(p.x) < 0.05, `drifted sideways to x=${p.x} on tick ${i}`);
      assert.ok(p.z < 0.2, `should be held behind the start gate, got z=${p.z}`);
    }
    ctx.tick = 0;
    assert.ok(p.grounded, "should still be standing after running into the gate");
  });

  it("jumps roughly to the height the tuning implies", () => {
    const world = freshWorld(level);
    const p = player({ x: 0, y: 0.05, z: -14 });
    let peak = 0;
    const jump: SimInput = { ...idle, jump: true };
    for (let i = 0; i < 40; i++) {
      ctx.tick = i + 1;
      stepPlayer(ctx, p, jump, world);
      peak = Math.max(peak, p.y);
    }
    ctx.tick = 0;
    assert.ok(peak > 1.5 && peak < 3.0, `jump peaked at ${peak}, outside the usable band`);
  });
});

describe("moving platforms", () => {
  const level = buildLevel(2024);
  const mover = level.obstacles.find((o) => o.kind === "slider" && o.role === "solid")!;

  it("carries a player standing on it", () => {
    const world = freshWorld(level);
    const start = 300;
    const pose = poseAt(mover, start, world.phase, makePose());

    const p = player({
      x: pose.x, y: pose.y + mover.size.y / 2, z: pose.z,
      groundId: mover.id, grounded: true,
    });

    const before = p.x;
    run(p, idle, world, start, 12);

    const after = poseAt(mover, start + 12, world.phase, makePose());
    assert.ok(Math.abs(after.x - pose.x) > 0.4, "the platform should have moved at all");
    assert.ok(
      Math.abs(p.x - after.x) < 0.35,
      `rider drifted off: player x=${p.x}, platform x=${after.x} (started ${before})`,
    );
    assert.ok(p.grounded, "should still be standing on it");
    assert.strictEqual(p.groundId, mover.id);
  });
});

describe("crumble platforms", () => {
  const level = buildLevel(2024);
  const crumble = level.obstacles.find((o) => o.kind === "crumble")!;

  it("reports the touch, then stops being solid once it has collapsed", () => {
    const world = freshWorld(level);
    const touched: number[] = [];
    world.onCrumble = (slot, tick) => {
      if (world.phase.crumbleTicks[slot] < 0) {
        (world.phase.crumbleTicks as number[])[slot] = tick;
      }
      touched.push(slot);
    };

    const p = player({
      x: crumble.px, y: crumble.py + crumble.size.y / 2, z: crumble.pz,
      groundId: crumble.id, grounded: true,
    });

    run(p, idle, world, 100, 2);
    assert.ok(touched.includes(crumble.slot!), "standing on it should report the touch");
    assert.ok(p.grounded, "it stays solid for a moment first");

    // Past the delay it drops out from under whoever is still on it.
    run(p, idle, world, 102, CRUMBLE_DELAY_TICKS + 10);
    assert.ok(!p.grounded, "should be falling once the platform has gone");
    assert.ok(p.y < crumble.py, `should have dropped below the platform, y=${p.y}`);
  });
});

describe("the pressure plate and the swing bridge", () => {
  // Seeds vary whether the bridge is armed at all; find one where it is.
  let level!: Level;
  for (let seed = 1; seed < 200; seed++) {
    const candidate = buildLevel(seed);
    if (candidate.obstacles.some((o) => o.kind === "hinge")) { level = candidate; break; }
  }

  it("swings the bridge into place while the plate is hot, and back after", () => {
    assert.ok(level, "some seed should arm the bridge");
    const hinge = level.obstacles.find((o) => o.kind === "hinge")!;
    const world = freshWorld(level);

    const closed = poseAt(hinge, 100, world.phase, makePose()).yaw;
    assert.ok(Math.abs(closed - hinge.closedYaw!) < 1e-6, "starts closed");

    // Plate pressed at tick 100, hot for its hold window.
    (world.phase.plateSince as number[])[0] = 100;
    (world.phase.plateTicks as number[])[0] = 100 + level.plates[0].holdTicks;

    const opening = poseAt(hinge, 110, world.phase, makePose()).yaw;
    const open = poseAt(hinge, 140, world.phase, makePose()).yaw;
    assert.ok(Math.abs(opening - closed) > 1e-4, "should begin swinging immediately");
    assert.ok(Math.abs(open - hinge.openYaw!) < 1e-6, `should be fully open, got ${open}`);

    // Regression: `since` and `until` are separate stamps. With one stamp, a
    // player standing on the plate kept restarting the ramp and the bridge
    // never finished opening.
    const stillOpen = poseAt(hinge, 100 + level.plates[0].holdTicks - 1, world.phase, makePose()).yaw;
    assert.ok(Math.abs(stillOpen - hinge.openYaw!) < 1e-6, "stays open while the plate is hot");

    const after = poseAt(hinge, 100 + level.plates[0].holdTicks + 40, world.phase, makePose()).yaw;
    assert.ok(Math.abs(after - hinge.closedYaw!) < 1e-6, "swings back once the plate cools");
  });

  it("reports a player standing on the plate", () => {
    const world = freshWorld(level);
    const hits: number[] = [];
    world.onPlate = (id) => hits.push(id);

    const plate = level.plates[0];
    const p = player({ x: plate.volume.x, y: 0, z: plate.volume.z });
    run(p, idle, world, 50, 3);

    assert.ok(hits.length > 0, "standing on the plate should report it");
  });
});

describe("checkpoints and respawning", () => {
  const level = buildLevel(2024);

  it("refuses to bank a checkpoint out of order", () => {
    const world = freshWorld(level);
    const third = level.checkpoints[2];
    const p = player({ x: third.volume.x, y: 0, z: third.volume.z, checkpoint: -1 });

    run(p, idle, world, 10, 3);
    assert.strictEqual(p.checkpoint, -1, "you cannot skip straight to the third checkpoint");
  });

  it("banks a checkpoint when the previous one is already held", () => {
    const world = freshWorld(level);
    const second = level.checkpoints[1];
    const p = player({ x: second.volume.x, y: 0, z: second.volume.z, checkpoint: 0 });

    run(p, idle, world, 10, 2);
    assert.strictEqual(p.checkpoint, 1);
  });

  it("returns a fallen player to their checkpoint and rolls progress back to it", () => {
    const world = freshWorld(level);
    const cp = level.checkpoints[1];
    const p = player({ x: 40, y: KILL_Y - 5, z: 120, checkpoint: 1, progress: 0.62 });

    run(p, idle, world, 10, 1);

    assert.strictEqual(p.x, cp.spawn.x);
    assert.strictEqual(p.z, cp.spawn.z);
    assert.ok(p.respawn > 0, "should be in the respawn freeze");
    assert.ok(
      Math.abs(p.progress - checkpointProgress(level, 1)) < 1e-9,
      "progress banked past the checkpoint should be given back",
    );
  });

  it("falls back to the start line when no checkpoint has been banked", () => {
    const world = freshWorld(level);
    const p = player({ x: 3, y: KILL_Y - 2, z: 20, checkpoint: -1 });
    run(p, idle, world, 10, 1);
    assert.strictEqual(p.z, level.spawn.z);
  });
});

describe("hazards", () => {
  const level = buildLevel(2024);

  it("knocks a player off their feet and stuns them", () => {
    const world = freshWorld(level);
    const bar = level.obstacles.find((o) => o.kind === "spinner")!;

    // Sit right where the sweeping arm passes, at its own height.
    const p = player({ x: 0.8, y: 0, z: bar.pz, grounded: true });
    let hit = false;
    for (let i = 0; i < 120 && !hit; i++) {
      ctx.tick = i + 1;
      stepPlayer(ctx, p, idle, world);
      if (p.stun > 0) { hit = true; }
    }
    ctx.tick = 0;

    assert.ok(hit, "a sweeping bar should connect within one rotation");
    assert.ok(p.stun <= STUN_TICKS && p.stun > 0);
    assert.ok(Math.hypot(p.vx, p.vz) > 3, "should have been launched, not nudged");
  });
});

describe("player interaction", () => {
  const level = buildLevel(2024);

  it("shoves an overlapping runner apart without launching them", () => {
    const world = freshWorld(level);
    // Two runners on the lobby floor, closer than their combined radii.
    world.others = [{ x: 0, y: 0, z: -14 }];
    const p = player({ x: 0.3, y: 0, z: -14 });

    run(p, idle, world, 10, 6);

    assert.ok(p.x > 0.3, `should have been pushed away, x=${p.x}`);
    assert.ok(p.x < 3, `the shove must stay gentle, x=${p.x}`);
    assert.ok(p.grounded, "a shove should not knock anyone off their feet");
  });

  it("leaves runners who are not touching alone", () => {
    const world = freshWorld(level);
    world.others = [{ x: 6, y: 0, z: -14 }];
    const p = player({ x: 0, y: 0, z: -14 });

    run(p, idle, world, 10, 6);
    assert.ok(Math.abs(p.x) < 1e-6, `should not have moved, x=${p.x}`);
  });

  it("ignores a runner on a completely different level", () => {
    const world = freshWorld(level);
    world.others = [{ x: 0, y: 9, z: -14 }];
    const p = player({ x: 0, y: 0, z: -14 });

    run(p, idle, world, 10, 6);
    assert.ok(Math.abs(p.x) < 1e-6, "vertical separation means no contact");
  });
});

describe("rollback determinism", () => {
  const level = buildLevel(7331);

  /**
   * The contract the whole netcode rests on: the same state plus the same
   * inputs at the same world tick must produce the same result, every time and
   * regardless of whether it is a live step or a replay. If this ever fails,
   * clients rubber-band.
   */
  it("reproduces an identical trajectory on replay", () => {
    const inputs: SimInput[] = [];
    for (let i = 0; i < 60; i++) {
      inputs.push({
        moveX: (i % 7 === 0 ? 1 : i % 5 === 0 ? -1 : 0) as -1 | 0 | 1,
        moveZ: 1,
        yaw: Math.sin(i * 0.13) * 0.9,
        pitch: Math.sin(i * 0.07) * 0.4,
        jump: i % 11 === 0,
        action: i % 17 < 4,
        alt: i % 13 < 5,
        use: i % 19 === 0,
        respawn: false,
      });
    }

    const live = player({ x: 0, y: 0.05, z: -14 });
    const worldA = freshWorld(level);
    inputs.forEach((cmd, i) => {
      ctx.tick = i + 1;
      ctx.isReplay = false;
      stepPlayer(ctx, live, cmd, worldA);
    });

    const replayed = player({ x: 0, y: 0.05, z: -14 });
    const worldB = freshWorld(level);
    inputs.forEach((cmd, i) => {
      ctx.tick = i + 1;
      ctx.isReplay = true;
      stepPlayer(ctx, replayed, cmd, worldB);
    });

    ctx.tick = 0;
    ctx.isReplay = false;
    assert.deepStrictEqual(replayed, live, "a replay must land bit-identically on the live result");
  });

  it("depends on the world tick, not on wall-clock time", () => {
    const worldA = freshWorld(level);
    const worldB = freshWorld(level);
    const mover = level.obstacles.find((o) => o.kind === "slider" && o.role === "solid")!;

    const at = (tick: number, world: SimWorld) => {
      const pose = poseAt(mover, tick, world.phase, makePose());
      const p = player({
        x: pose.x, y: pose.y + mover.size.y / 2, z: pose.z,
        groundId: mover.id, grounded: true,
      });
      return run(p, forward, world, tick, 10);
    };

    // Same tick range twice: identical. A different range: different.
    assert.deepStrictEqual(at(500, worldA), at(500, worldB));
    assert.notDeepStrictEqual(at(500, worldA), at(537, worldB));
  });
});
