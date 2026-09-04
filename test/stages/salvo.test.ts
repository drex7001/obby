/**
 * Stage 6 - the Salvo.
 *
 * The feature is Class A and Class B throughout: a shot is a pure function of
 * the level, the synchronised stamps and a fractional world tick, and every
 * consequence is either a stamp or a simulated field. So almost everything
 * here is asserted the same way stage 0 asserts determinism - run it twice and
 * demand the same answer.
 *
 * One acceptance item is deliberately absent: "every generated course is
 * completable with the gun disabled" needs the bot sweep that arrives with
 * stage 10. What *can* be checked without a runner is checked here - that
 * nothing a breaker does removes a hazard, and that everything a breaker
 * builds sits off the main line - and that is what the bot sweep will confirm.
 */

import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../../src/app.config.js";
import type { RaceState } from "../../src/rooms/schema/RaceState.js";
import { useTestServer } from "../helpers/server.js";
import {
  AMMO_MAX, ASSIST_CONE, BREAKER_DISABLE_TICKS, BURN_SPEED_PER, CRATE_AMMO,
  FIRE_COOL_TICKS, IMPACT_FUMBLE_KEEP, IMPACT_NEUTRAL_KEEP, MAX_SPEED,
  PICKUP_RESPAWN_TICKS, POD_COINS, POD_SHARE_TICKS, RUN_SPEED, SHIELD_COST,
  SHOT_EYE, TICK_RATE,
} from "../../src/shared/constants.js";
import { buildLevel, type Level, type Obstacle } from "../../src/shared/level.js";
import { isActiveAt } from "../../src/shared/obstacles.js";
import { makeShotResult, resolveShot } from "../../src/shared/salvo.js";
import type { SimInput, SimState } from "../../src/shared/movement.js";
import {
  clonePhase, createFlatLevel, createSimState, createWorld, firstStateDifference,
  idleInput, stepSimulation,
} from "../helpers/simulation.js";

// ---------------------------------------------------------------- fixtures

/** A flat arena with one breaker of each effect and a gun on the floor. */
function range(): Level {
  const level = createFlatLevel();
  level.breakers = [
    { id: 101, slot: 0, x: 0, y: SHOT_EYE, z: 20, hx: 0.75, hy: 0.75, hz: 0.75, yaw: 0, effect: "pod", style: "pod" },
    { id: 102, slot: 1, x: 6, y: SHOT_EYE, z: 20, hx: 0.7, hy: 0.7, hz: 0.7, yaw: 0, effect: "crate", style: "crate" },
    { id: 103, slot: 2, x: -6, y: SHOT_EYE, z: 20, hx: 0.8, hy: 0.8, hz: 0.8, yaw: 0, effect: "disable", style: "breaker" },
    { id: 104, slot: 3, x: 12, y: SHOT_EYE, z: 20, hx: 0.8, hy: 0.8, hz: 0.8, yaw: 0, effect: "collapse", style: "breaker" },
    { id: 105, slot: 4, x: -12, y: SHOT_EYE, z: 20, hx: 0.8, hy: 0.8, hz: 0.8, yaw: 0, effect: "seal", style: "breaker" },
  ];
  level.breakerCount = 5;
  level.pickups = [{ id: 200, slot: 0, x: 0, y: 1, z: 4, kind: "gun", ammo: AMMO_MAX }];
  level.pickupCount = 1;
  level.obstacles = [
    {
      id: 300, kind: "spinner", role: "hazard", style: "bar",
      size: { x: 10, y: 0.2, z: 1 }, px: -6, py: 0.95, pz: 20,
      speed: 1, phase: 0, knock: 10, breaker: 2,
    },
    {
      id: 301, kind: "collapse", role: "solid", style: "swingbridge",
      size: { x: 3, y: 0.8, z: 8 }, px: 12, py: -0.4, pz: 20,
      breaker: 3, dropY: 6,
    },
    {
      id: 302, kind: "seal", role: "solid", style: "gate",
      size: { x: 3, y: 2.6, z: 0.7 }, px: -12, py: 1.3, pz: 20,
      breaker: 4,
    },
  ] as Obstacle[];
  return level;
}

/** Aim at a point, in the yaw/pitch the input packet carries. */
function aimAt(fromZ: number, x: number, y: number, z: number) {
  const dx = x, dy = y - SHOT_EYE, dz = z - fromZ;
  const flat = Math.hypot(dx, dz);
  return { yaw: Math.atan2(dx, dz), pitch: -Math.atan2(dy, flat) };
}

function fire(over: Partial<SimInput> = {}): SimInput {
  return { ...idleInput, action: true, ...over };
}

/** A world that records every server-side hook the salvo fires. */
function armedWorld(level: Level) {
  const world = createWorld(level);
  const shots: number[] = [];
  const taken: number[] = [];
  const spends: number[] = [];
  world.onShot = (slot, tick) => {
    shots.push(slot);
    if ((world.phase.breakerTicks as number[])[slot] < 0) {
      (world.phase.breakerTicks as number[])[slot] = tick;
    }
  };
  world.onPickup = (slot, tick) => {
    taken.push(slot);
    (world.phase.pickupTicks as number[])[slot] = tick;
  };
  world.onSpend = (tick) => { spends.push(tick); };
  return { world, shots, taken, spends };
}

const shotResult = makeShotResult();

describe("the salvo", () => {
  // =========================================================== shot resolution

  it("hits a target inside the assist cone and misses one outside it", () => {
    const level = range();
    const { world } = armedWorld(level);
    const at = aimAt(0, 0, SHOT_EYE, 20);

    // The pod is 0.75 u across at 20 u, so its own silhouette is worth about
    // two degrees on top of the four the assist cone grants.
    const dead = resolveShot(level, world.phase, 0, 0, SHOT_EYE, 0, at.yaw, at.pitch, shotResult);
    assert.strictEqual(dead.slot, 0, "a dead-centre shot must connect");

    const inside = resolveShot(
      level, world.phase, 0, 0, SHOT_EYE, 0, at.yaw + ASSIST_CONE * 0.75, at.pitch, shotResult,
    );
    assert.strictEqual(inside.slot, 0, "three degrees off must still connect");

    // Nine degrees: past the pod's cone, and nowhere near the crate at 17.
    const outside = resolveShot(
      level, world.phase, 0, 0, SHOT_EYE, 0, at.yaw - 0.16, at.pitch, shotResult,
    );
    assert.strictEqual(outside.slot, -1, "nine degrees off is a miss, assist or not");
  });

  it("cannot shoot through the world", () => {
    const level = range();
    level.solids.push({ x: 0, y: 2, z: 10, hx: 6, hy: 4, hz: 0.5, yaw: 0, style: "wall" });
    const { world } = armedWorld(level);
    const at = aimAt(0, 0, SHOT_EYE, 20);

    const blocked = resolveShot(level, world.phase, 0, 0, SHOT_EYE, 0, at.yaw, at.pitch, shotResult);
    assert.strictEqual(blocked.slot, -1, "a wall in the way stops the shot");
    assert.ok(Math.abs(blocked.z - 9.5) < 0.2, `tracer should end at the wall, ended at ${blocked.z}`);
  });

  it("keeps a coin pod shootable for exactly the share window", () => {
    // Two players hitting one pod within five ticks both get coins, and the
    // way that is arranged is that the pod stays targetable for five ticks.
    const level = range();
    const { world } = armedWorld(level);
    (world.phase.breakerTicks as number[])[0] = 100;
    const at = aimAt(0, 0, SHOT_EYE, 20);

    for (const tick of [100, 100 + POD_SHARE_TICKS - 1]) {
      const hit = resolveShot(level, world.phase, tick, 0, SHOT_EYE, 0, at.yaw, at.pitch, shotResult);
      assert.strictEqual(hit.slot, 0, `a second shooter at tick ${tick} must still connect`);
    }
    const late = resolveShot(
      level, world.phase, 100 + POD_SHARE_TICKS, 0, SHOT_EYE, 0, at.yaw, at.pitch, shotResult,
    );
    assert.strictEqual(late.slot, -1, "the window closes on the fifth tick, not later");

    // Nothing else shares. A weak point is gone the instant it is shot.
    (world.phase.breakerTicks as number[])[2] = 100;
    const weak = aimAt(0, -6, SHOT_EYE, 20);
    const again = resolveShot(level, world.phase, 100, 0, SHOT_EYE, 0, weak.yaw, weak.pitch, shotResult);
    assert.notStrictEqual(again.slot, 2, "only pods share");
  });

  // ================================================================ the magazine

  it("fires on the press edge, one shot per cooldown, and never past empty", () => {
    const level = range();
    const { world, shots } = armedWorld(level);
    const state = createSimState({ z: 0, ammo: AMMO_MAX });
    const at = aimAt(0, 0, SHOT_EYE, 20);

    // Held down, not tapped: exactly one shot, because the edge happens once.
    for (let tick = 0; tick < 20; tick++) {
      stepSimulation(state, fire({ yaw: at.yaw, pitch: at.pitch }), world, tick);
    }
    assert.strictEqual(state.ammo, AMMO_MAX - 1, "a held trigger is one shot");

    // Tapped every other tick, which is faster than the cooldown allows.
    let tick = 20;
    for (let i = 0; i < 60; i++, tick++) {
      const cmd = fire({ yaw: at.yaw, pitch: at.pitch, action: i % 2 === 0 });
      stepSimulation(state, cmd, world, tick);
    }
    assert.strictEqual(state.ammo, 0, "the magazine empties");
    assert.strictEqual(shots.length, 1, "only the first shot found an unbroken pod");
    assert.ok(state.fireCool >= 20 + 3 * FIRE_COOL_TICKS - 1,
      "three more shots cannot be spent faster than three cooldowns");

    // Empty is empty: no amount of tapping produces a fifth shot.
    const before = state.fireCool;
    for (let i = 0; i < 40; i++, tick++) {
      stepSimulation(state, fire({ yaw: at.yaw, pitch: at.pitch, action: i % 2 === 0 }), world, tick);
    }
    assert.strictEqual(state.ammo, 0);
    assert.strictEqual(state.fireCool, before, "an empty magazine does not even start a cooldown");
  });

  it("replays a firing sequence bit-identically", () => {
    const at = aimAt(0, 0, SHOT_EYE, 20);
    const run = (replay: boolean) => {
      const level = range();
      const { world, shots } = armedWorld(level);
      const state = createSimState({ z: 0, ammo: AMMO_MAX });
      for (let tick = 0; tick < 80; tick++) {
        const cmd = fire({
          yaw: at.yaw, pitch: at.pitch, moveZ: 1,
          action: tick % 5 === 0,
        });
        stepSimulation(state, cmd, world, tick, replay);
      }
      return { state, shots, phase: clonePhase(world.phase) };
    };

    const live = run(false);
    const replayed = run(true);
    assert.strictEqual(firstStateDifference(live.state, replayed.state), null,
      "a replayed shot must land on exactly the same state as the live one");
    assert.deepStrictEqual(live.shots, replayed.shots);
    assert.deepStrictEqual(
      Array.from(live.phase.breakerTicks), Array.from(replayed.phase.breakerTicks));
    assert.ok(live.shots.length > 0, "the fixture must actually hit something");
  });

  it("refills two shots from a crate, and never past the magazine", () => {
    const level = range();
    const { world } = armedWorld(level);
    const state = createSimState({ z: 0, ammo: 1 });
    const at = aimAt(0, 6, SHOT_EYE, 20);

    stepSimulation(state, fire({ yaw: at.yaw, pitch: at.pitch }), world, 0);
    assert.strictEqual(state.ammo, CRATE_AMMO, "one shot spent, two back");

    const full = createSimState({ z: 0, ammo: AMMO_MAX });
    const fresh = armedWorld(range());
    const crate = aimAt(0, 6, SHOT_EYE, 20);
    stepSimulation(full, fire({ yaw: crate.yaw, pitch: crate.pitch }), fresh.world, 0);
    assert.strictEqual(full.ammo, AMMO_MAX, "a full magazine cannot be overfilled");
  });

  // ================================================================== pickups

  it("grants a pickup once on contact and hands it back twenty seconds later", () => {
    const level = range();
    const { world, taken } = armedWorld(level);
    const state = createSimState({ x: 0, y: 0.05, z: 3.2 });

    for (let tick = 0; tick < 30; tick++) {
      stepSimulation(state, { ...idleInput, moveZ: 1 }, world, tick);
    }
    assert.strictEqual(state.ammo, AMMO_MAX, "running through the gun arms you");
    assert.deepStrictEqual(taken, [0], "standing in it must not collect it twice");

    // Gone while it respawns...
    const at = world.phase.pickupTicks[0];
    state.ammo = 0;
    state.x = level.pickups[0].x; state.z = level.pickups[0].z;
    state.pickupIn = 0;
    stepSimulation(state, idleInput, world, at + PICKUP_RESPAWN_TICKS - 2);
    assert.strictEqual(state.ammo, 0, "a taken pickup is not there");

    // ...and back afterwards, so the runner in fifth still has one to race for.
    stepSimulation(state, idleInput, world, at + PICKUP_RESPAWN_TICKS + 1);
    assert.strictEqual(state.ammo, AMMO_MAX, "it comes back after twenty seconds");
    assert.deepStrictEqual(taken, [0, 0]);
  });

  // ============================================================ what a shot does

  it("disables a hazard for five seconds and not one tick longer", () => {
    const level = range();
    const { world } = armedWorld(level);
    const hazard = level.obstacles[0];

    assert.strictEqual(isActiveAt(hazard, 0, world.phase), true);
    (world.phase.breakerTicks as number[])[2] = 50;
    assert.strictEqual(isActiveAt(hazard, 50, world.phase), false, "inert from the shot");
    assert.strictEqual(isActiveAt(hazard, 50 + BREAKER_DISABLE_TICKS - 1, world.phase), false);
    assert.strictEqual(isActiveAt(hazard, 50 + BREAKER_DISABLE_TICKS, world.phase), true,
      "a window, never a deletion");
  });

  it("builds a bridge that was not there, and opens a seal for the round", () => {
    const level = range();
    const { world } = armedWorld(level);
    const bridge = level.obstacles[1];
    const seal = level.obstacles[2];

    assert.strictEqual(isActiveAt(bridge, 0, world.phase), false, "no gun, no bridge");
    assert.strictEqual(isActiveAt(seal, 0, world.phase), true, "the barrier starts closed");

    (world.phase.breakerTicks as number[])[3] = 30;
    (world.phase.breakerTicks as number[])[4] = 30;

    assert.strictEqual(isActiveAt(bridge, 30 + 20, world.phase), true, "the bridge lands");
    assert.strictEqual(isActiveAt(seal, 30 + 20, world.phase), false, "the route is open");
    // Permanently: a seal is a public act you may not be able to defend.
    assert.strictEqual(isActiveAt(seal, 30 + TICK_RATE * 120, world.phase), false);
    assert.strictEqual(isActiveAt(bridge, 30 + TICK_RATE * 120, world.phase), true);
  });

  it("never lets a shot delete a hazard on any generated course", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const level = buildLevel(seed);
      const phase = {
        raceStartTick: 0,
        crumbleTicks: new Array(level.crumbleCount).fill(-1),
        plateTicks: new Array(level.plates.length).fill(-1),
        plateSince: new Array(level.plates.length).fill(-1),
        breakerTicks: new Array(level.breakerCount).fill(0),
        pickupTicks: new Array(level.pickupCount).fill(-1),
        shellTicks: new Array(level.shellCount).fill(-1),
      };
      for (const ob of level.obstacles) {
        if (ob.role !== "hazard" || ob.breaker === undefined) { continue; }
        assert.strictEqual(isActiveAt(ob, BREAKER_DISABLE_TICKS, phase), true,
          `seed ${seed}: hazard ${ob.id} never comes back after being shot`);
      }
    }
  });

  it("keeps everything a breaker builds off the course's main line", () => {
    // The structural half of "completable with the gun disabled": whatever a
    // shot adds or unlocks is a route beside the one everybody runs, so a
    // player who never picks a gun up runs exactly the course they always did.
    // The other half is the stage-10 bot sweep.
    for (let seed = 1; seed <= 200; seed++) {
      const level = buildLevel(seed);
      for (const ob of level.obstacles) {
        if (ob.kind !== "collapse" && ob.kind !== "seal") { continue; }
        let nearest = Infinity;
        for (const p of level.path) {
          nearest = Math.min(nearest, Math.hypot(ob.px - p.x, ob.pz - p.z));
        }
        assert.ok(nearest > 4,
          `seed ${seed}: a ${ob.kind} sits ${nearest.toFixed(1)} u from the centre-line`);
      }
    }
  });

  // ==================================================================== coins

  it("keeps coins out of the simulation entirely", () => {
    // Coins are Class D. The step cannot read them, so an optimistic client
    // award the server later denies can never desynchronise anything - it is a
    // number on the HUD being corrected, not a prediction being rolled back.
    assert.ok(!("coins" in createSimState()),
      "the shared step must not be able to see a coin");
  });

  it("burns coins into overspeed at exactly half a unit each", () => {
    const run = (amount: number) => {
      const level = range();
      const { world } = armedWorld(level);
      const state = createSimState({
        vz: RUN_SPEED, z: 0,
        burnTick: amount > 0 ? 0 : -1, burnAmount: amount,
      });
      stepSimulation(state, idleInput, world, 0);
      return Math.hypot(state.vx, state.vz);
    };

    const plain = run(0);
    for (const coins of [1, 4, 10]) {
      const burned = run(coins);
      assert.ok(Math.abs(burned - plain - BURN_SPEED_PER * coins) < 1e-9,
        `burning ${coins} gave ${(burned - plain).toFixed(4)}, not ${BURN_SPEED_PER * coins}`);
    }
    assert.ok(run(10) > RUN_SPEED, "the frame that buys overspeed must not also decay it");
  });

  it("applies a late burn stamp as reaction lag, never as a teleport", () => {
    const trace = (stampAt: number) => {
      const level = range();
      const { world } = armedWorld(level);
      const state = createSimState({ z: 0, burnTick: stampAt, burnAmount: 8 });
      const path: { x: number; z: number }[] = [];
      let worst = 0;
      for (let tick = 0; tick < 40; tick++) {
        const before = { x: state.x, z: state.z };
        stepSimulation(state, { ...idleInput, moveZ: 1 }, world, tick);
        worst = Math.max(worst, Math.hypot(state.x - before.x, state.z - before.z));
        path.push({ x: state.x, z: state.z });
      }
      return { path, worst };
    };

    const onTime = trace(0);
    const late = trace(12);
    const step = MAX_SPEED / TICK_RATE + 1e-6;
    assert.ok(late.worst <= step, `a late stamp moved ${late.worst.toFixed(2)} u in one tick`);
    assert.ok(onTime.worst <= step);
    // Both runs end up ahead; the late one is simply later, not elsewhere.
    assert.ok(late.path[39].z > 0 && onTime.path[39].z > late.path[39].z);
  });

  it("spends a bought shield on one fumble and then is out of shields", () => {
    // A five-tick-old press is a Fumble: past the window, inside the buffer.
    const fumbling = (over: Partial<SimState>) => createSimState({
      y: 0.05, vy: -9, grounded: false, vz: RUN_SPEED, chain: 4,
      impactBuf: 2, heavyHeld: true, ...over,
    });
    const land = (state: SimState) =>
      stepSimulation(state, { ...idleInput, alt: true }, createWorld(createFlatLevel()), 10);

    const bare = fumbling({});
    land(bare);
    assert.strictEqual(bare.chain, 0, "a fumble costs the Chain");
    const fumbled = bare.vz;

    const shielded = fumbling({ shieldUntil: 10_000 });
    land(shielded);
    assert.strictEqual(shielded.chain, 4, "the shield protects the Chain");
    assert.strictEqual(shielded.shieldUntil, -1, "and spends itself doing it");
    assert.ok(shielded.vz > fumbled, "the mistake degrades to a Neutral landing");
    assert.ok(IMPACT_FUMBLE_KEEP < IMPACT_NEUTRAL_KEEP);

    // One fumble each. The second one is on you.
    shielded.chain = 4;
    shielded.impactBuf = 2;
    shielded.y = 0.05; shielded.vy = -9; shielded.grounded = false;
    shielded.heavyHeld = true;
    land(shielded);
    assert.strictEqual(shielded.chain, 0, "the shield is spent, not a subscription");
  });

  // ============================================================== level content

  it("puts a gun on every course, with slots the room can size an array from", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const level = buildLevel(seed);
      assert.ok(level.pickups.some((p) => p.kind === "gun"),
        `seed ${seed}: no gun anywhere on the course`);

      const breakers = level.breakers.map((b) => b.slot).sort((a, b) => a - b);
      assert.strictEqual(level.breakerCount, breakers.length,
        `seed ${seed}: breakerCount ${level.breakerCount} vs ${breakers.length} breakers`);
      assert.deepStrictEqual(breakers, breakers.map((_, i) => i),
        `seed ${seed}: breaker slots are not 0..n-1`);

      const pickups = level.pickups.map((p) => p.slot).sort((a, b) => a - b);
      assert.strictEqual(level.pickupCount, pickups.length);
      assert.deepStrictEqual(pickups, pickups.map((_, i) => i),
        `seed ${seed}: pickup slots are not 0..n-1`);
    }
  });

  it("arms a runner who actually touches the gun on a generated course", () => {
    // The unit above proves the mechanism on a fixture; this proves the gun the
    // generator places is genuinely standing on ground a runner can reach.
    for (let seed = 1; seed <= 60; seed++) {
      const level = buildLevel(seed);
      const gun = level.pickups.find((p) => p.kind === "gun")!;
      const world = createWorld(level);
      const state = createSimState({ x: gun.x, y: gun.y - 1.3, z: gun.z });
      stepSimulation(state, idleInput, world, 0);
      assert.strictEqual(state.ammo, AMMO_MAX,
        `seed ${seed}: standing on the gun at (${gun.x.toFixed(1)}, ${gun.z.toFixed(1)}) armed nothing`);
      assert.ok(state.grounded, `seed ${seed}: the gun is floating over a void`);
    }
  });

  it("gives most courses something to shoot for", () => {
    let withPods = 0;
    for (let seed = 1; seed <= 200; seed++) {
      if (buildLevel(seed).breakers.some((b) => b.effect === "pod")) { withPods++; }
    }
    assert.ok(withPods >= 190,
      `only ${withPods}/200 courses carry a coin pod; the currency needs a source`);
  });
});

describe("the salvo, in the room", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => { colyseus = await useTestServer(); });
  beforeEach(async () => { await colyseus.cleanup(); });

  /** A room whose course is guaranteed to carry the breaker we want to test. */
  async function roomWith(effect: string) {
    const room: any = await colyseus.createRoom<RaceState>("race", {});
    for (let seed = 1; seed <= 400; seed++) {
      if (buildLevel(seed).breakers.some((b) => b.effect === effect)) {
        room.armLevel(seed);
        return room;
      }
    }
    throw new Error(`no seed in 400 carries a ${effect}`);
  }

  it("pays both runners who hit one pod inside the share window", async () => {
    const room = await roomWith("pod");
    const a = await colyseus.connectTo(room);
    const b = await colyseus.connectTo(room);
    const level = buildLevel(room.state.seed);
    const pod = level.breakers.find((x) => x.effect === "pod")!;

    const first = room.state.players.get(a.sessionId);
    const second = room.state.players.get(b.sessionId);
    room.touchBreaker(pod.slot, 100, first);
    room.touchBreaker(pod.slot, 100 + POD_SHARE_TICKS, second);

    assert.strictEqual(first.coins, POD_COINS, "the first shooter is paid");
    assert.strictEqual(second.coins, POD_COINS,
      "so is the second, inside the window - there is no argument to have");
    assert.strictEqual(room.state.breakerTicks[pod.slot], 100,
      "the stamp belongs to the first hit and is never moved");

    // Outside it, nothing. The pod is gone and a late shot could not have hit.
    const third = room.state.players.get(a.sessionId);
    room.touchBreaker(pod.slot, 100 + POD_SHARE_TICKS + 1, third);
    assert.strictEqual(third.coins, POD_COINS, "no second payout for the same pod");
  });

  it("validates a purchase server-side and stamps it onto the buyer", async () => {
    const room = await roomWith("pod");
    const client = await colyseus.connectTo(room);
    const player = room.state.players.get(client.sessionId);
    room.beginRace(room.state.tick);

    player.coins = SHIELD_COST - 1;
    room.messages.buy({ sessionId: client.sessionId } as any, { item: "shield" });
    assert.strictEqual(player.shieldUntil, -1, "a purchase you cannot afford is refused");
    assert.strictEqual(player.coins, SHIELD_COST - 1, "and costs nothing");

    player.coins = SHIELD_COST + 2;
    room.messages.buy({ sessionId: client.sessionId } as any, { item: "shield" });
    assert.strictEqual(player.coins, 2, "one paid for");
    assert.ok(player.shieldUntil > room.state.tick, "and armed");
  });

  it("stamps a Burn rather than letting the client spend its own coins", async () => {
    const room = await roomWith("pod");
    const client = await colyseus.connectTo(room);
    const player = room.state.players.get(client.sessionId);

    room.stepping = player;
    player.coins = 7;
    room.burn(42);
    assert.strictEqual(player.burnTick, 42);
    assert.strictEqual(player.burnAmount, 7);
    assert.strictEqual(player.coins, 0, "burning spends the purse");

    // A second press before the stamp is consumed buys nothing twice.
    player.coins = 5;
    room.burn(43);
    assert.strictEqual(player.burnAmount, 7);
    assert.strictEqual(player.coins, 5);
    room.stepping = null;
  });

  it("sizes its breaker and pickup arrays from the course it armed", async () => {
    const room: any = await colyseus.createRoom<RaceState>("race", {});
    for (const seed of [3, 47, 512]) {
      room.armLevel(seed);
      const level = buildLevel(seed);
      assert.strictEqual(room.state.breakerTicks.length, level.breakerCount);
      assert.strictEqual(room.state.pickupTicks.length, level.pickupCount);
      assert.ok(Array.from(room.state.breakerTicks).every((t) => t === -1));
    }
  });
});
