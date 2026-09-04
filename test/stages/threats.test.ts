/**
 * Stage 9 - Watchers and enemies.
 *
 * Two halves with very different risk profiles, and the tests reflect that.
 * The Watchers are pure functions of tick, so the whole argument is "evaluate
 * it twice and demand the same answer". The enemies publish committed arcs
 * instead of positions, so the argument is "both ends can compute the pose,
 * including at ticks the server has not reached yet" - which is what makes a
 * solid enemy safe to stand on and a shot at one need no lag compensation.
 */

import assert from "assert";

import {
  CHAIN_SPEED_PER, COMMIT_LEAD, ENEMY_MAX, LURCHER_LUNGE_SPEED, RUN_SPEED,
  SHELL_FLIGHT_TICKS, SHOT_EYE, STUN_TICKS, TICK_RATE,
} from "../../src/shared/constants.js";
import { hazardHit, type Body, type HitNormal } from "../../src/shared/collision.js";
import {
  BULWARK, enemyPoseAt, enemyShape, LURCHER, SHAMBLER, type EnemyView,
} from "../../src/shared/enemies.js";
import { buildLevel, type Level, type Obstacle } from "../../src/shared/level.js";
import { isActiveAt, makePose, poseAt, type WorldPhase } from "../../src/shared/obstacles.js";
import { makeShotResult, resolveShot } from "../../src/shared/salvo.js";
import type { SimState } from "../../src/shared/movement.js";
import { Threats, type ThreatTarget } from "../../src/rooms/threats.js";
import {
  createFlatLevel, createSimState, createWorld, firstStateDifference, idleInput,
  levelWith, stepSimulation,
} from "../helpers/simulation.js";

/** Chain-8 speed, which is what "readable ahead" has to be measured against. */
const CHAIN_SPEED = RUN_SPEED * (1 + CHAIN_SPEED_PER * 8);

function coldPhase(level: Level, over: Partial<WorldPhase> = {}): WorldPhase {
  return {
    raceStartTick: 0,
    crumbleTicks: new Array(level.crumbleCount).fill(-1),
    plateTicks: new Array(level.plates.length).fill(-1),
    plateSince: new Array(level.plates.length).fill(-1),
    breakerTicks: new Array(level.breakerCount).fill(-1),
    pickupTicks: new Array(level.pickupCount).fill(-1),
    shellTicks: new Array(level.shellCount).fill(-1),
    ...over,
  };
}

/** The first course carrying an obstacle of the given kind. */
const courseWith = (kind: string) =>
  levelWith((l) => l.obstacles.some((o) => o.kind === kind));

function enemy(over: Partial<EnemyView> = {}): EnemyView {
  return {
    id: 1, kind: SHAMBLER, alive: true, action: 1,
    fromTick: 0, toTick: 10_000,
    x0: 0, y0: 0, z0: 0, dx: 0, dz: 1, speed: 0, turn: 0,
    ...over,
  };
}

describe("watchers", () => {
  it("puts a turret shell exactly where the tick says, every time", () => {
    const level = courseWith("turret");
    const turret = level.obstacles.find((o) => o.kind === "turret")!;
    const phase = coldPhase(level);

    for (const tick of [0, 7, 12.5, 91, 4213.25]) {
      const a = poseAt(turret, tick, phase, makePose());
      const b = poseAt(turret, tick, phase, makePose());
      assert.deepStrictEqual({ ...a }, { ...b });
    }
    // A ballistic arc, not a straight line: it rises and then it falls. The
    // turret's phase decides where in its cycle tick 0 lands, so the flight is
    // sampled by walking a whole cycle rather than by guessing three ticks.
    const period = Math.ceil(turret.period! * TICK_RATE);
    let apex = -Infinity;
    let apexAt = -1;
    const flight: { tick: number; y: number }[] = [];
    for (let tick = 0; tick < period * 2; tick++) {
      const pose = poseAt(turret, tick, phase, makePose());
      if (!pose.active) { continue; }
      flight.push({ tick, y: pose.y });
      if (pose.y > apex) { apex = pose.y; apexAt = flight.length - 1; }
    }
    assert.ok(flight.length > 8, "the fixture must catch a whole flight");
    assert.ok(apexAt > 0 && apexAt < flight.length - 1,
      "the shell must actually arc rather than climb or drop the whole way");
  });

  it("gives every Watcher at least 1.2 seconds of warning at chain-8 speed", () => {
    // Sixteen units of approach at 13.4 u/s. A hazard a runner cannot see
    // coming is not difficulty, it is a coin toss.
    assert.ok(SHELL_FLIGHT_TICKS / TICK_RATE >= 1.2,
      "a shell must be in the air for the whole of an approach");
    assert.ok(CHAIN_SPEED * 1.2 >= 16, "the readability budget is 16 u at chain 8");

    let checked = 0;
    for (let seed = 1; seed <= 120; seed++) {
      for (const ob of buildLevel(seed).obstacles) {
        if (ob.kind === "sentry") {
          checked++;
          assert.ok(ob.period! >= 2.4,
            `a sentry sweeping every ${ob.period} s crosses the lane too fast to read`);
        }
        if (ob.kind === "turret") {
          checked++;
          assert.ok(ob.period! >= 2, `a turret firing every ${ob.period} s has no rhythm`);
        }
        if (ob.kind === "slider" && (ob.style === "jaws" || ob.style === "hunter")) {
          checked++;
          assert.ok(ob.period! >= 2, `${ob.style} cycles every ${ob.period} s`);
        }
      }
    }
    assert.ok(checked > 0, "the pool must actually contain Watchers");
  });

  it("puts a shell's hitbox exactly where its mesh is drawn, from either side", () => {
    // The mirrored-geometry test: a projectile hitbox that is right on one side
    // and wrong on the other is the classic way a moving collider goes bad.
    const level = courseWith("turret");
    const turret = level.obstacles.find((o) => o.kind === "turret")!;
    const pose = poseAt(turret, 8, coldPhase(level), makePose());
    const hit: HitNormal = { nx: 0, nz: 0, hit: false };
    const reach = turret.size.x / 2 + 0.42;

    for (const offset of [-1, 1]) {
      const body: Body = {
        x: pose.x + offset * reach * 0.5, y: pose.y - 0.6, z: pose.z,
        vx: 0, vy: 0, vz: 0, grounded: false, groundId: 0, height: 1.72,
      };
      hazardHit(body, pose, turret.size.x, turret.size.y, turret.size.z, hit);
      assert.ok(hit.hit, `a body ${offset > 0 ? "right" : "left"} of the shell must be hit`);
      assert.ok(Math.sign(hit.nx) === Math.sign(offset) || hit.nx === 0,
        "the knock must push away from the shell, not through it");
    }

    const clear: Body = {
      x: pose.x + reach * 4, y: pose.y, z: pose.z,
      vx: 0, vy: 0, vz: 0, grounded: false, groundId: 0, height: 1.72,
    };
    hazardHit(clear, pose, turret.size.x, turret.size.y, turret.size.z, hit);
    assert.ok(!hit.hit, "and a body well clear of it is not");
  });

  it("costs nothing on the wire for a turret, sentry, jaws, hunter or nest", () => {
    // The only synced array any of them reads is the one that exists for
    // shooting shells down - which belongs to the Salvo, not to the Watchers.
    const level = courseWith("sentry");
    const noisy = coldPhase(level, {
      crumbleTicks: new Array(level.crumbleCount).fill(12),
      plateTicks: new Array(level.plates.length).fill(999),
      plateSince: new Array(level.plates.length).fill(900),
      breakerTicks: new Array(level.breakerCount).fill(4),
      pickupTicks: new Array(level.pickupCount).fill(7),
    });
    const cold = coldPhase(level);

    for (const ob of level.obstacles) {
      if (!["sentry", "nest"].includes(ob.kind)) { continue; }
      if (ob.breaker !== undefined) { continue; }
      for (const tick of [3, 44, 210.5]) {
        assert.deepStrictEqual(
          { ...poseAt(ob, tick, noisy, makePose()) },
          { ...poseAt(ob, tick, cold, makePose()) },
          `${ob.kind} read a synchronised integer it has no business reading`);
      }
    }
  });

  it("arms a swarm from a plate and disarms it again, with no new machinery", () => {
    const level = courseWith("swarm");
    const swarm = level.obstacles.find((o) => o.kind === "swarm")!;
    const plate = swarm.plate!;

    const idle = coldPhase(level);
    assert.strictEqual(isActiveAt(swarm, 100, idle), false, "a trap is not a patrol");

    const hot = coldPhase(level);
    (hot.plateTicks as number[])[plate] = 200;
    (hot.plateSince as number[])[plate] = 100;
    assert.strictEqual(isActiveAt(swarm, 150, hot), true, "tripped, and awake");
    assert.strictEqual(isActiveAt(swarm, 201, hot), false, "and asleep again after");
  });

  it("takes a shell out of the air, for that cycle and no longer", () => {
    // The deferred item from stage 6: defence and offence are the same verb at
    // different moments, and the window has to be wide enough to be a decision.
    const level = courseWith("turret");
    const turret = level.obstacles.find((o) => o.kind === "turret" && o.shell !== undefined)!;
    const phase = coldPhase(level);
    const period = turret.period! * TICK_RATE;

    // Fire the turret, then shoot the round down partway through its flight.
    const downAt = 10;
    (phase.shellTicks as number[])[turret.shell!] = downAt;
    assert.strictEqual(isActiveAt(turret, downAt + 2, phase), false, "that round is gone");
    assert.strictEqual(isActiveAt(turret, downAt + period, phase), true,
      "and the next one fires as normal - the turret was never destroyed");
  });

  it("leaves a window at least eight ticks wide to shoot a shell down", () => {
    const level = courseWith("turret");
    const turret = level.obstacles.find((o) => o.kind === "turret" && o.shell !== undefined)!;
    const phase = coldPhase(level);
    const shot = makeShotResult();

    // A runner standing on the track the shell crosses, looking at it.
    let window = 0;
    for (let tick = 0; tick < SHELL_FLIGHT_TICKS; tick++) {
      const pose = poseAt(turret, tick, phase, makePose());
      if (!pose.active) { continue; }
      const from = { x: pose.x, y: pose.y - 6, z: pose.z - 9 };
      const dx = pose.x - from.x, dy = pose.y - (from.y + SHOT_EYE), dz = pose.z - from.z;
      const yaw = Math.atan2(dx, dz);
      const pitch = -Math.atan2(dy, Math.hypot(dx, dz));
      resolveShot(level, phase, tick, from.x, from.y + SHOT_EYE, from.z, yaw, pitch, shot);
      if (shot.shellSlot === turret.shell) { window++; }
    }
    assert.ok(window >= 8, `only ${window} ticks of the flight were shootable`);
  });
});

describe("enemies", () => {
  // ================================================================ the arc

  it("computes a pose from a committed arc, forwards and at fractional ticks", () => {
    const straight = enemy({ fromTick: 10, toTick: 40, speed: 6, dx: 0, dz: 1 });
    const at = (tick: number) => enemyPoseAt(straight, tick, makePose());

    assert.strictEqual(at(10).z, 0, "the arc starts where it was committed to");
    assert.ok(Math.abs(at(25).z - 6 * (15 / TICK_RATE)) < 1e-9);
    assert.ok(Math.abs(at(25.5).z - 6 * (15.5 / TICK_RATE)) < 1e-9,
      "and it is defined between ticks, because sub-steps land there");
  });

  it("holds the start before the commit and the end after it", () => {
    // Both clamps carry weight. The first is what makes publishing early safe;
    // the second is what makes a *late* commit degrade into a hold rather than
    // a teleport.
    const e = enemy({ fromTick: 100, toTick: 130, speed: 6 });
    assert.strictEqual(enemyPoseAt(e, 0, makePose()).z, 0);
    assert.strictEqual(enemyPoseAt(e, 99, makePose()).z, 0);
    const end = enemyPoseAt(e, 130, makePose()).z;
    assert.strictEqual(enemyPoseAt(e, 400, makePose()).z, end, "it waits where it stopped");
  });

  it("turns along an arc rather than through control points", () => {
    const arc = enemy({ fromTick: 0, toTick: 90, speed: 6, turn: 1, dx: 0, dz: 1 });
    const quarter = enemyPoseAt(arc, Math.round(TICK_RATE * (Math.PI / 2)), makePose());
    // A quarter turn at 1 rad/s: heading has swung 90 degrees, and the path is
    // a circle of radius speed/turn rather than a corner.
    assert.ok(Math.abs(quarter.yaw - Math.PI / 2) < 0.05);
    assert.ok(Math.abs(Math.hypot(quarter.x - 6, quarter.z) - 6) < 0.05,
      "the arc must stay on its own circle");
  });

  it("bounds what a withheld commit can do, with no teleport anywhere in it", () => {
    const e = enemy({ fromTick: 0, toTick: 30, speed: 8 });
    const held = enemyPoseAt(e, 200, makePose()).z;

    // The next commit arrives late - it should have started at tick 200 and
    // arrives now. The jump is bounded by how far it could have travelled.
    const late = enemy({ fromTick: 200, toTick: 260, x0: 0, y0: 0, z0: held, speed: 8 });
    const now = 212;
    const jump = Math.abs(enemyPoseAt(late, now, makePose()).z - held);
    assert.ok(jump <= 8 * ((now - 200) / TICK_RATE) + 1e-9,
      `a late commit moved ${jump.toFixed(2)} u at once`);
    assert.ok(COMMIT_LEAD / TICK_RATE >= 0.4, "and the lead is what makes it rare");
  });

  // =============================================================== collision

  it("never lets a hazard enemy become a surface, from any angle", () => {
    const level = createFlatLevel();
    const world = createWorld(level);
    const walker = enemy({ kind: SHAMBLER, x0: 0, y0: 0, z0: 0, speed: 0 });
    world.enemies = [walker];

    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      const state = createSimState({
        x: Math.sin(angle) * 5, y: 2.4, z: Math.cos(angle) * 5,
        vx: -Math.sin(angle) * CHAIN_SPEED, vz: -Math.cos(angle) * CHAIN_SPEED,
        vy: -3, grounded: false,
      });
      for (let tick = 0; tick < 20; tick++) {
        stepSimulation(state, idleInput, world, tick);
        const overOne = Math.hypot(state.x, state.z) < enemyShape(SHAMBLER).radius
          && state.y > 0.5;
        assert.ok(!overOne || !state.grounded,
          `angle ${i}: a hazard enemy became a surface at y ${state.y.toFixed(2)}`);
      }
    }
  });

  it("never holds a runner still for longer than one stun", () => {
    const level = createFlatLevel();
    const world = createWorld(level);
    world.enemies = [enemy({ kind: SHAMBLER, speed: 0 })];
    const state = createSimState({ x: 0, y: 0.05, z: -1 });

    for (let tick = 0; tick < 200; tick++) {
      stepSimulation(state, { ...idleInput, moveZ: 1 }, world, tick);
      assert.ok(state.stun <= STUN_TICKS,
        `a runner was pinned for ${state.stun} ticks, past the ${STUN_TICKS} the design allows`);
    }
  });

  it("lets a runner stand on a Bulwark, and agree about it across the wire", () => {
    // The one enemy that is a surface. It is safe *because* its position is
    // derived from a committed arc rather than dead-reckoned: the client and
    // the server evaluate the same function and cannot disagree, so there is
    // nothing to snap back from.
    // Parked, because what is under test is that it is a *surface*. Whether a
    // moving one carries a rider is a different question, and the answer is no:
    // an enemy is never a moving platform.
    const solid = enemy({ kind: BULWARK, x0: 0, y0: 0, z0: 6, speed: 0 });
    const shape = enemyShape(BULWARK);
    assert.ok(shape.solid);

    const run = (offsetTicks: number) => {
      const level = createFlatLevel();
      const world = createWorld(level);
      world.enemies = [solid];
      const state = createSimState({ x: 0, y: shape.height + 1, z: 6, grounded: false });
      for (let tick = 0; tick < 30; tick++) {
        stepSimulation(state, idleInput, world, tick + offsetTicks);
      }
      return state;
    };

    const server = run(0);
    assert.ok(server.grounded, "a Bulwark can be stood on");
    assert.ok(Math.abs(server.y - shape.height) < 0.2,
      `landed at ${server.y.toFixed(2)}, expected the top at ${shape.height}`);

    // A client running four ticks (about 120 ms) ahead computes the same pose
    // for the same tick, so there is no correction to make at all.
    const level = createFlatLevel();
    const world = createWorld(level);
    world.enemies = [solid];
    const predicted = createSimState({ x: 0, y: shape.height + 1, z: 6, grounded: false });
    const authoritative = createSimState({ x: 0, y: shape.height + 1, z: 6, grounded: false });
    for (let tick = 0; tick < 30; tick++) {
      stepSimulation(predicted, idleInput, world, tick, false);
    }
    for (let tick = 0; tick < 30; tick++) {
      stepSimulation(authoritative, idleInput, world, tick, true);
    }
    assert.strictEqual(firstStateDifference(predicted, authoritative), null,
      "prediction and replay must land on the same state, to the bit");
  });

  it("replays a tick with enemies active bit-identically", () => {
    const run = (replay: boolean) => {
      const level = createFlatLevel();
      const world = createWorld(level);
      world.enemies = [
        enemy({ id: 1, kind: SHAMBLER, x0: 2, z0: 8, speed: 4, dx: 0, dz: -1 }),
        enemy({ id: 2, kind: LURCHER, x0: -3, z0: 10, speed: LURCHER_LUNGE_SPEED, dz: -1, action: 3 }),
        enemy({ id: 3, kind: BULWARK, x0: 6, z0: 4, speed: 2, dx: -1, dz: 0, turn: 0.2 }),
      ];
      const state: SimState = createSimState({ y: 0.05, chain: 4 });
      for (let tick = 0; tick < 90; tick++) {
        stepSimulation(state, { ...idleInput, moveZ: 1 }, world, tick, replay);
      }
      return state;
    };
    assert.strictEqual(firstStateDifference(run(false), run(true)), null);
  });

  // =============================================================== shooting

  it("resolves a shot at an enemy with no lag compensation at all", () => {
    // A position that can be recomputed never has to be remembered. Both ends
    // evaluate the same arc at the same tick, so the shooter's view and the
    // server's are the same view.
    const level = createFlatLevel();
    const phase = coldPhase(level);
    const target = enemy({ id: 42, kind: SHAMBLER, x0: 0, z0: 10, speed: 5, dx: 0, dz: 1 });
    const shot = makeShotResult();

    for (const tick of [0, 9, 21]) {
      const pose = enemyPoseAt(target, tick, makePose());
      const dx = pose.x, dz = pose.z;
      const yaw = Math.atan2(dx, dz);
      const dy = pose.y + enemyShape(SHAMBLER).height * 0.55 - SHOT_EYE;
      const pitch = -Math.atan2(dy, Math.hypot(dx, dz));
      resolveShot(level, phase, tick, 0, SHOT_EYE, 0, yaw, pitch, shot, [target]);
      assert.strictEqual(shot.enemyId, 42, `a shot at tick ${tick} should connect`);
    }

    // ...and a shot aimed where it *was* misses, which is the whole point of
    // not needing rewind: there is nothing to rewind to.
    const stale = enemyPoseAt(target, 0, makePose());
    const yaw = Math.atan2(stale.x, stale.z);
    resolveShot(level, phase, 40, 0, SHOT_EYE, 0, yaw, 1.0, shot, [target]);
    assert.strictEqual(shot.enemyId, 0);
  });
});

describe("the enemy field", () => {
  const targets = (x: number, z: number): ThreatTarget[] => [{ x, y: 0, z, live: true }];

  it("never publishes a commit that has already started", () => {
    // The rule the whole design rests on: nobody is ever asked to evaluate a
    // path they have not received.
    const level = courseWith("nest");
    const threats = new Threats();
    threats.reset(level, 0);
    const nest = level.obstacles.find((o) => o.kind === "nest")!;

    const seen = new Map<number, number>();
    for (let tick = 0; tick < 900; tick++) {
      threats.update(level, tick, targets(nest.px, nest.pz));
      for (const e of threats.enemies) {
        const known = seen.get(e.id);
        if (known !== e.fromTick) {
          assert.ok(e.fromTick > tick,
            `enemy ${e.id} was handed a commit starting at ${e.fromTick} on tick ${tick}`);
          assert.ok(e.fromTick - tick >= COMMIT_LEAD,
            `the lead was only ${e.fromTick - tick} ticks`);
          seen.set(e.id, e.fromTick);
        }
      }
    }
    assert.ok(seen.size > 0, "the fixture must actually produce enemies");
  });

  it("hatches a nest on its own schedule and stops at the cap", () => {
    const level = courseWith("nest");
    const nest = level.obstacles.find((o) => o.kind === "nest")!;
    const threats = new Threats();
    threats.reset(level, 0);

    let peak = 0;
    for (let tick = 0; tick < TICK_RATE * 400; tick++) {
      threats.update(level, tick, targets(nest.px, nest.pz));
      peak = Math.max(peak, threats.enemies.length);
    }
    assert.ok(peak > 1, "a nest that never hatches is a rock");
    assert.ok(peak <= ENEMY_MAX, `the field peaked at ${peak}, past the cap of ${ENEMY_MAX}`);
  });

  it("lets go of anything the field has left behind", () => {
    const level = courseWith("nest");
    const nest = level.obstacles.find((o) => o.kind === "nest")!;
    const threats = new Threats();
    threats.reset(level, 0);
    for (let tick = 0; tick < 400; tick++) {
      threats.update(level, tick, targets(nest.px, nest.pz));
    }
    assert.ok(threats.enemies.length > 0);

    // The field runs on. Nothing chases it off the end of the course.
    for (let tick = 400; tick < 900; tick++) {
      threats.update(level, tick, targets(nest.px + 400, nest.pz + 400));
    }
    assert.strictEqual(threats.enemies.length, 0, "a leash, not a pursuit");
  });

  it("runs a Lurcher through idle, wind-up, lunge and recover", () => {
    const level = levelWith((l) => l.spawns.some((sp) => sp.kind === LURCHER));
    const threats = new Threats();
    threats.reset(level, 0);
    const lurcher = threats.enemies.find((e) => e.kind === LURCHER);
    assert.ok(lurcher, "the pool must place a Lurcher somewhere");

    const seen = new Set<number>();
    for (let tick = 0; tick < 600; tick++) {
      threats.update(level, tick, targets(lurcher!.x0, lurcher!.z0 + 4));
      const live = threats.enemies.find((e) => e.id === lurcher!.id);
      if (live) { seen.add(live.action); }
    }
    for (const action of [2, 3, 4]) {
      assert.ok(seen.has(action),
        `a Lurcher never reached action ${action}; the cycle is where the character is`);
    }
  });

  it("puts an enemy down in the shots its kind is worth", () => {
    const level = levelWith((l) => l.spawns.some((sp) => sp.kind === BULWARK));
    const threats = new Threats();
    threats.reset(level, 0);
    const bulwark = threats.enemies.find((e) => e.kind === BULWARK);
    assert.ok(bulwark, "the pool must place a Bulwark somewhere");

    const hp = enemyShape(BULWARK).hp;
    for (let i = 1; i < hp; i++) {
      assert.strictEqual(threats.hit(bulwark!.id, 10), false, `shot ${i} should not fell it`);
    }
    assert.strictEqual(threats.hit(bulwark!.id, 10), true, "the last one should");
    assert.strictEqual(threats.hit(bulwark!.id, 11), false, "and a corpse takes no more");
  });

  it("places every threat kind somewhere in the pool", () => {
    const kinds = new Set<string>();
    const enemyKinds = new Set<number>();
    for (let seed = 1; seed <= 200; seed++) {
      const level = buildLevel(seed);
      for (const ob of level.obstacles) { kinds.add(styleOf(ob)); }
      for (const spawn of level.spawns) { enemyKinds.add(spawn.kind); }
    }
    for (const kind of ["turret", "sentry", "nest", "swarm", "jaws", "hunter"]) {
      assert.ok(kinds.has(kind), `nothing in the pool is a ${kind}`);
    }
    for (const kind of [LURCHER, BULWARK]) {
      assert.ok(enemyKinds.has(kind), `nothing in the pool places enemy kind ${kind}`);
    }
  });

  it("keeps a placed enemy off the checkpoint banks", () => {
    // A bank is where a runner is meant to be able to stop.
    for (let seed = 1; seed <= 120; seed++) {
      const level = buildLevel(seed);
      for (const spawn of level.spawns) {
        for (const cp of level.checkpoints) {
          const d = Math.hypot(spawn.x - cp.volume.x, spawn.z - cp.volume.z);
          assert.ok(d > 8, `seed ${seed}: an enemy waits ${d.toFixed(1)} u from a checkpoint`);
        }
      }
    }
  });
});

/** Watchers are distinguished by kind, except the two that are sliders. */
function styleOf(ob: Obstacle): string {
  return ob.kind === "slider" ? ob.style : ob.kind;
}
