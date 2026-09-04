/**
 * Stage 11 - mutators and modes.
 *
 * The whole stage rests on one migration, and the first two tests here are
 * about it: a mutator may only vary numbers that live on the `Level`, because
 * anything it reads out of `constants.ts` exists twice - once on the server and
 * once compiled into the client - and changing one of those two is a desync
 * with no symptom until somebody falls through the floor.
 */

import assert from "assert";
import { readFileSync } from "node:fs";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../../src/app.config.js";
import type { RaceState } from "../../src/rooms/schema/RaceState.js";
import { useTestServer } from "../helpers/server.js";

import {
  CHAIN_DECAY_TICKS, COLLECT_TARGET, COLLECT_TOKENS, GRAVITY, GROUND_FRICTION,
  HUNT_CATCH_RADIUS, PUSH_STRENGTH, RACE_MODES, SURVIVAL_GRACE_TICKS, TICK_RATE,
} from "../../src/shared/constants.js";
import { buildLevel, buildLevelWith } from "../../src/shared/level.js";
import { baseTuning } from "../../src/shared/generator.js";
import {
  applyTuning, compatible, drawMutators, MUTATORS, mutatorById,
  sanitizeMutators, sectionCount, seriesMultiplier, withheldVerbs,
  type MutatorId,
} from "../../src/shared/mutators.js";
import { pathProgress } from "../../src/shared/progress.js";
import { sectionById } from "../../src/shared/sections/registry.js";
import { createSimState, createWorld, idleInput, stepSimulation } from "../helpers/simulation.js";

const ALL = MUTATORS.map((m) => m.id);

describe("the mutator migration", () => {
  it("keeps every tuning value a mutator varies on the level", () => {
    // The one technical trap the stage has. If the step read gravity out of
    // `constants.ts`, Low Gravity would change it on the server and not on the
    // client, and the two would disagree about where the floor is.
    const step = readFileSync("src/shared/movement.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

    for (const name of ["GRAVITY", "GROUND_FRICTION", "CHAIN_DECAY_TICKS", "PUSH_STRENGTH"]) {
      assert.ok(!new RegExp(`\\b${name}\\b`).test(step),
        `movement.ts still reads ${name} from constants.ts; a mutator cannot vary it safely`);
    }
    const tuning = buildLevel(1).tuning;
    assert.strictEqual(tuning.gravity, GRAVITY, "and the default still is the constant");
    assert.strictEqual(tuning.groundFriction, GROUND_FRICTION);
    assert.strictEqual(tuning.chainDecayTicks, CHAIN_DECAY_TICKS);
    assert.strictEqual(tuning.pushStrength, PUSH_STRENGTH);
  });

  it("changes the simulation identically wherever the level came from", () => {
    // Two "ends", each building its own level from the same inputs, then
    // stepping the same runner. This is the stage-0 argument with a deck in it.
    const run = (mutators: MutatorId[]) => {
      const level = buildLevelWith(9, { mutators });
      const world = createWorld(level);
      const state = createSimState({
        x: level.spawn.x, y: level.spawn.y + 3, z: level.spawn.z, grounded: false,
      });
      for (let tick = 0; tick < 40; tick++) {
        stepSimulation(state, { ...idleInput, moveZ: 1 }, world, tick);
      }
      return state;
    };

    for (const id of ["lowgravity", "greasy", "chainreaction", "crowded"] as MutatorId[]) {
      const a = run([id]);
      const b = run([id]);
      assert.strictEqual(a.y, b.y, `${id} is not reproducible`);
      assert.strictEqual(a.vz, b.vz);
    }
    assert.notStrictEqual(run(["lowgravity"]).y, run([]).y,
      "and low gravity has to actually do something");
  });

  it("bends only the numbers it says it does", () => {
    const base = baseTuning();
    assert.deepStrictEqual(applyTuning(baseTuning(), []), base, "a clean round is untouched");

    assert.ok(applyTuning(baseTuning(), ["lowgravity"]).gravity < base.gravity);
    assert.strictEqual(applyTuning(baseTuning(), ["greasy"]).groundFriction, base.groundFriction / 2);
    assert.strictEqual(applyTuning(baseTuning(), ["crowded"]).pushStrength, base.pushStrength * 2);

    const chain = applyTuning(baseTuning(), ["chainreaction"]);
    assert.strictEqual(chain.chainGain, 2, "builds twice as fast");
    assert.ok(chain.chainDecayTicks < base.chainDecayTicks, "and breaks twice as fast");
  });
});

describe("the mutator deck", () => {
  it("never draws a pair that cannot coexist", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const drawn = drawMutators(seed);
      assert.ok(drawn.length <= 2, `seed ${seed} drew ${drawn.length}`);
      if (drawn.length === 2) {
        assert.ok(compatible(drawn[0], drawn[1]),
          `seed ${seed} drew ${drawn.join(" + ")}, which cannot both be true`);
      }
    }
    // The specific pair the spec calls out.
    assert.ok(!compatible("fog", "rushhour"),
      "a shortened sightline and a shortened telegraph are the same cut twice");
    assert.ok(!compatible("marathon", "sprint"));
  });

  it("draws from the seed and nothing else", () => {
    for (const seed of [1, 17, 4242]) {
      assert.deepStrictEqual(drawMutators(seed), drawMutators(seed),
        "a deck rolled at runtime is a deck two clients disagree about");
    }
    const decks = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) { decks.add(drawMutators(seed).join(",")); }
    assert.ok(decks.size > 8, "the deck has to actually vary");
    assert.ok(decks.has(""), "and some rounds have to run clean");
  });

  it("throws away a clashing pair rather than trusting the wire", () => {
    assert.deepStrictEqual(sanitizeMutators(["fog", "rushhour"]), ["fog"]);
    assert.deepStrictEqual(sanitizeMutators(["nonsense", "fog"]), ["fog"]);
    assert.deepStrictEqual(sanitizeMutators(["fog", "fog"]), ["fog"]);
  });

  it("gives every mutator a name and a line for the lobby", () => {
    for (const id of ALL) {
      const def = mutatorById(id)!;
      assert.ok(def.name.length > 2 && def.note.length > 4, `${id} is not announceable`);
    }
    const level = buildLevelWith(5, { mutators: ["fog"] });
    assert.ok(level.notes.some((n) => n.includes("Fog")),
      "the HUD already shows notes; a mutator has to land in them");
  });

  it("builds the course the deck asks for", () => {
    assert.strictEqual(buildLevelWith(3, { mutators: [] }).sections.length, 7);
    assert.strictEqual(buildLevelWith(3, { mutators: ["marathon"] }).sections.length, 8);
    assert.strictEqual(buildLevelWith(3, { mutators: ["sprint"] }).sections.length, 4);
    assert.strictEqual(sectionCount([]), 7);
    assert.strictEqual(seriesMultiplier(["sprint"]), 2, "a short course is worth double");

    // No tether means the generator must not reach for a section that needs it.
    for (let seed = 1; seed <= 120; seed++) {
      const level = buildLevelWith(seed, { mutators: ["notether"] });
      assert.ok(!level.verbs.includes("tether"));
      for (const s of level.sections) {
        assert.ok(!sectionById(s.id)!.requires.includes("tether"),
          `seed ${seed}: ${s.id} needs a rope the deck took away`);
      }
    }
    assert.deepStrictEqual(withheldVerbs(["notether"]), ["tether"]);
  });

  it("mirrors a course completely, or not at all", () => {
    // A reflection is an isometry with a sign flip, so everything angular has
    // to flip with it. One missed negation leaves a door lying across the track
    // it used to lie along, and it reads as a level bug rather than a missing
    // minus sign.
    for (const seed of [2, 31, 404]) {
      const plain = buildLevelWith(seed, { mutators: [] });
      const mirror = buildLevelWith(seed, { mutators: ["mirror"] });

      assert.strictEqual(mirror.solids.length, plain.solids.length);
      for (let i = 0; i < plain.solids.length; i++) {
        assert.ok(Math.abs(mirror.solids[i].x + plain.solids[i].x) < 1e-9,
          `seed ${seed}: solid ${i} is not reflected`);
        assert.ok(Math.abs(mirror.solids[i].yaw + plain.solids[i].yaw) < 1e-9,
          `seed ${seed}: solid ${i} kept its handedness`);
        assert.strictEqual(mirror.solids[i].z, plain.solids[i].z, "and z is untouched");
      }
      for (let i = 0; i < plain.obstacles.length; i++) {
        assert.ok(Math.abs(mirror.obstacles[i].px + plain.obstacles[i].px) < 1e-9);
        const a = plain.obstacles[i], b = mirror.obstacles[i];
        if (a.speed !== undefined) {
          assert.ok(Math.abs(b.speed! + a.speed) < 1e-9, "a mirrored spin turns the other way");
        }
        if (a.baseYaw !== undefined) { assert.ok(Math.abs(b.baseYaw! + a.baseYaw) < 1e-9); }
      }
      assert.ok(Math.abs(mirror.finish.x + plain.finish.x) < 1e-9);
      assert.ok(Math.abs(mirror.checkpoints[0].spawn.x + plain.checkpoints[0].spawn.x) < 1e-9);
    }
  });

  it("speeds every moving part up together under Rush Hour", () => {
    const plain = buildLevelWith(11, { mutators: [] });
    const rush = buildLevelWith(11, { mutators: ["rushhour"] });
    let checked = 0;
    for (let i = 0; i < plain.obstacles.length; i++) {
      const a = plain.obstacles[i], b = rush.obstacles[i];
      if (a.period === undefined) { continue; }
      checked++;
      assert.ok(Math.abs(b.period! - a.period * 0.75) < 1e-9,
        `${a.kind} kept its period`);
    }
    assert.ok(checked > 3, "the fixture needs moving parts in it");
  });

  it("keeps every course structurally sound under every mutator", function () {
    this.timeout(60_000);
    // The acceptance item is "no mutator makes a generated course
    // incompletable", and the bot sweep is what will eventually sign that off.
    // What *can* be proved today is the set of structural properties that make
    // a course completable in the first place, and they are asserted here under
    // each mutator in turn rather than only on the clean deck.
    for (const id of ALL) {
      for (let seed = 1; seed <= 25; seed++) {
        const level = buildLevelWith(seed, { mutators: [id] });

        assert.ok(level.sections.length >= 4, `${id}/${seed}: too few sections`);
        assert.strictEqual(level.checkpoints.length, level.sections.length - 1,
          `${id}/${seed}: a bank per join, no more and no less`);

        // Every checkpoint further along the centre-line than the last, and the
        // finish past all of them. A course that fails this cannot be run.
        let last = -1;
        for (const cp of level.checkpoints) {
          const at = pathProgress(level, cp.spawn.x, cp.spawn.z);
          assert.ok(at > last, `${id}/${seed}: checkpoint ${cp.index} does not advance`);
          last = at;
        }
        assert.ok(pathProgress(level, level.finish.x, level.finish.z) >= last,
          `${id}/${seed}: the finish is not past the last checkpoint`);

        // And solid ground under every place a runner can be sent back to.
        for (const cp of level.checkpoints) {
          const under = level.solids.some((s) =>
            Math.abs(s.x - cp.spawn.x) <= s.hx + s.hz + 1
            && Math.abs(s.z - cp.spawn.z) <= s.hx + s.hz + 1
            && Math.abs(s.y + s.hy - cp.spawn.y) < 0.4);
          assert.ok(under, `${id}/${seed}: checkpoint ${cp.index} respawns into the void`);
        }
      }
    }
  });

  it("leaves a clean round exactly as it was before the deck existed", () => {
    for (const seed of [1, 60, 777]) {
      assert.strictEqual(
        JSON.stringify(buildLevelWith(seed, { mutators: [] })),
        JSON.stringify(buildLevel(seed)),
        "an empty deck must not be a variant of its own");
    }
  });
});

describe("modes", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => { colyseus = await useTestServer(); });
  beforeEach(async () => { await colyseus.cleanup(); });

  async function inMode(mode: string) {
    const room: any = await colyseus.createRoom<RaceState>("race", {});
    const client = await colyseus.connectTo(room);
    room.messages.mode({ sessionId: client.sessionId } as any, { mode });
    return { room, client, player: room.state.players.get(client.sessionId) };
  }

  it("only changes mode in the lobby, and only to one that exists", async () => {
    const { room, client } = await inMode("survival");
    assert.strictEqual(room.state.mode, "survival");

    room.messages.mode({ sessionId: client.sessionId } as any, { mode: "battle-royale" });
    assert.strictEqual(room.state.mode, "survival", "an unknown mode is refused");

    room.beginRace(room.state.tick);
    room.messages.mode({ sessionId: client.sessionId } as any, { mode: "race" });
    assert.strictEqual(room.state.mode, "survival",
      "a mode is a rule about who wins; it cannot change mid-answer");
  });

  it("takes contact out of Time Attack entirely", async () => {
    const { room, client } = await inMode("timeattack");
    await colyseus.connectTo(room);
    room.beginRace(room.state.tick);

    room.fillOthers(client.sessionId);
    assert.strictEqual(room.world.others.length, 0,
      "a time attack is a solo run in company");
    assert.strictEqual(room.world.hasLandingContact(0, 0, 0), false,
      "and a landing cannot be spoiled by somebody who is not there");
  });

  it("closes a kill plane behind the field in Survival", async () => {
    const { room, player } = await inMode("survival");
    room.beginRace(room.state.tick);
    const start = room.state.raceStartTick;

    room.advanceMode(start + SURVIVAL_GRACE_TICKS - 1);
    assert.strictEqual(room.state.killLine, -1, "there is a grace period first");

    player.progress = 0.02;
    room.advanceMode(start + SURVIVAL_GRACE_TICKS + TICK_RATE * 20);
    assert.ok(room.state.killLine > 0, "and then it starts closing");
    assert.strictEqual(player.dnf, true, "anyone behind it is out");
  });

  it("holds the finish line shut until you are carrying enough, in Collect", async () => {
    const { room, player } = await inMode("collect");
    room.beginRace(room.state.tick);
    const level = room.level;

    player.checkpoint = level.checkpoints.length - 1;
    player.x = level.finish.x;
    player.y = level.finish.y - level.finish.hy;
    player.z = level.finish.z;
    player.coins = COLLECT_TARGET - 1;

    room.detectFinishes(room.state.tick);
    assert.strictEqual(player.finished, false, "a line you cannot cross empty-handed");

    player.coins = COLLECT_TARGET;
    room.detectFinishes(room.state.tick);
    assert.strictEqual(player.finished, true);
  });

  it("scatters something to collect when the course is built for it", () => {
    const plain = buildLevelWith(12, { mutators: [] });
    const collect = buildLevelWith(12, { mutators: [], tokens: COLLECT_TOKENS });
    const pods = (l: typeof plain) => l.breakers.filter((b) => b.effect === "pod").length;
    assert.strictEqual(pods(collect), pods(plain) + COLLECT_TOKENS);
    assert.strictEqual(collect.breakerCount, collect.breakers.length,
      "and the room can still size its stamp array from the count");
  });

  it("scores a catch in Hunt, once, with a cooldown", async () => {
    const { room, client } = await inMode("hunt");
    const other = await colyseus.connectTo(room);
    room.beginRace(room.state.tick);

    const hunter = room.state.players.get(client.sessionId);
    const hare = room.state.players.get(other.sessionId);
    hare.progress = 0.5;
    hunter.progress = 0.4;
    hare.x = 0; hare.y = 0; hare.z = 0;
    hunter.x = 0; hunter.y = 0; hunter.z = HUNT_CATCH_RADIUS - 0.5;

    room.advanceMode(1000);
    assert.strictEqual(room.state.hare, other.sessionId, "the runner in front is the hare");
    assert.strictEqual(hunter.seriesPoints, 1, "catching them scores");

    room.advanceMode(1001);
    assert.strictEqual(hunter.seriesPoints, 1, "a catch is a catch, not a hold");
  });

  it("names every mode it is willing to run", () => {
    assert.ok(RACE_MODES.includes("race"));
    assert.strictEqual(new Set(RACE_MODES).size, RACE_MODES.length);
  });
});

describe("mutators in the room", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => { colyseus = await useTestServer(); });
  beforeEach(async () => { await colyseus.cleanup(); });

  it("publishes the deck rather than leaving a client to derive it", async () => {
    const room: any = await colyseus.createRoom<RaceState>("race", {});
    room.armLevel(19);
    const published = room.state.mutators ? room.state.mutators.split(",") : [];
    assert.deepStrictEqual(published, room.level.mutators);

    // What a client does with it, which is the only thing that matters.
    const rebuilt = buildLevelWith(room.state.seed, { mutators: published });
    assert.strictEqual(
      JSON.stringify(rebuilt.solids), JSON.stringify(room.level.solids),
      "a client that reads the deck rebuilds the room's course, not a different one");
  });

  it("announces before the countdown ends, because it is armed with the level", async () => {
    const room: any = await colyseus.createRoom<RaceState>("race", {});
    await colyseus.connectTo(room);
    await colyseus.connectTo(room);
    await room.waitForNextTimestep();
    assert.strictEqual(room.state.phase, "countdown");
    assert.strictEqual(room.state.mutators, room.level.mutators.join(","),
      "the deck is known the moment the course is, which is before the countdown");
  });

  it("ends a Sudden Death round on the first fall", async () => {
    const room: any = await colyseus.createRoom<RaceState>("race", {});
    const client = await colyseus.connectTo(room);
    room.armLevel(3);
    room.mutators = ["suddendeath"];
    room.beginRace(room.state.tick);

    const player = room.state.players.get(client.sessionId);
    room.stepping = player;
    room.world.onRespawn(false);
    assert.strictEqual(player.dnf, true, "there is no checkpoint to go back to");
    assert.strictEqual(player.falls, 1);
    room.stepping = null;
  });

  it("hands a charge to everybody under One Shot", async () => {
    const room: any = await colyseus.createRoom<RaceState>("race", {});
    const client = await colyseus.connectTo(room);
    room.armLevel(3);
    room.mutators = ["oneshot"];
    room.beginRace(room.state.tick);
    room.state.raceDeadlineTick = room.state.tick + TICK_RATE * 120;
    if (room.level.breakerCount === 0) { return; }

    const player = room.state.players.get(client.sessionId);
    assert.strictEqual(player.finished, false, "still running, on purpose");
    room.messages.influence({ sessionId: client.sessionId } as any, { slot: 0 });
    assert.strictEqual(player.influence, 0,
      "the point of One Shot is that the course is changed by people still in it");
  });
});
