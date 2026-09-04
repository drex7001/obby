import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { useTestServer } from "./helpers/server.js";
import type { RaceInput, RaceState } from "../src/rooms/schema/RaceState.js";
import { buildLevel, buildLevelWith } from "../src/shared/level.js";

/**
 * The course the room is actually running.
 *
 * A round's mutators are published rather than derived, so rebuilding from the
 * seed alone is rebuilding a different course - which is exactly the mistake a
 * client would make, and exactly why the mutators are on the wire.
 */
const courseOf = (room: any) =>
  buildLevelWith(room.state.seed, {
    mutators: room.state.mutators ? String(room.state.mutators).split(",") : [],
  });
import { pathProgress } from "../src/shared/progress.js";
import { makePose, poseAt, type WorldPhase } from "../src/shared/obstacles.js";
import { RUN_SPEED, TICK_RATE } from "../src/shared/constants.js";

const idlePhase: WorldPhase = {
  raceStartTick: -1,
  crumbleTicks: new Array(32).fill(-1),
  plateTicks: new Array(8).fill(-1),
  plateSince: new Array(8).fill(-1),
  breakerTicks: new Array(16).fill(-1),
  pickupTicks: new Array(8).fill(-1),
  shellTicks: new Array(8).fill(-1),
};

describe("course determinism", () => {
  it("rebuilds an identical level from the same seed", () => {
    const a = buildLevel(1234);
    const b = buildLevel(1234);
    assert.deepStrictEqual(JSON.stringify(a.solids), JSON.stringify(b.solids));
    assert.deepStrictEqual(JSON.stringify(a.obstacles), JSON.stringify(b.obstacles));
    assert.deepStrictEqual(a.notes, b.notes);
  });

  it("produces a different course for a different seed", () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      seen.add(JSON.stringify(buildLevel(seed).obstacles));
    }
    assert.ok(seen.size > 1, "the per-round variant should actually vary");
  });

  it("evaluates obstacle poses as a pure function of the tick", () => {
    const level = buildLevel(99);
    const spinner = level.obstacles.find((o) => o.kind === "spinner")!;
    const p1 = poseAt(spinner, 123.5, idlePhase, makePose());
    const p2 = poseAt(spinner, 123.5, idlePhase, makePose());
    assert.strictEqual(p1.yaw, p2.yaw);
    assert.notStrictEqual(poseAt(spinner, 200, idlePhase, makePose()).yaw, p1.yaw);
  });

  it("keeps every checkpoint reachable along the progress path", () => {
    // A course turns now, so "further along" is arc length on the centre-line,
    // not a larger Z. Progress is what the race actually ranks on.
    for (const seed of [7, 71, 713]) {
      const level = buildLevel(seed);
      let last = -1;
      for (const cp of level.checkpoints) {
        const at = pathProgress(level, cp.spawn.x, cp.spawn.z);
        assert.ok(at > last,
          `seed ${seed}: checkpoint ${cp.index} (${at}) must advance past ${last}`);
        last = at;
      }
      assert.ok(pathProgress(level, level.finish.x, level.finish.z) >= last,
        `seed ${seed}: the finish is past the last checkpoint`);
    }
  });
});

describe("RaceRoom", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => { colyseus = await useTestServer(); });
  beforeEach(async () => { await colyseus.cleanup(); });

  it("spawns a player in the lobby and holds the match in waiting", async () => {
    const room = await colyseus.createRoom<RaceState>("race", {});
    const client = await colyseus.connectTo(room);

    const player = room.state.players.get(client.sessionId);
    assert.ok(player, "a Player is created on join");
    assert.strictEqual(room.state.phase, "waiting");
    assert.strictEqual(player.checkpoint, -1);
    assert.strictEqual(player.active, false, "no input consumed yet");
  });

  it("advances a player from its buffered input and assigns a tick base", async () => {
    const room = await colyseus.createRoom<RaceState>("race", {});
    const client = await colyseus.connectTo(room);
    const player = room.state.players.get(client.sessionId);
    const startZ = player.z;

    const input = client.input<RaceInput>({ mode: "reliable" });
    for (let i = 0; i < 20; i++) {
      input.data.moveZ = 1;
      input.data.yaw = 0;
      input.send();
    }

    await room.waitForNextMessage();
    for (let i = 0; i < 6; i++) { await room.waitForNextTimestep(); }

    assert.ok(player.active, "the first consumed input marks the player active");
    assert.ok(Number.isFinite(player.x) && Number.isFinite(player.y) && Number.isFinite(player.z),
      `position must stay finite, got (${player.x}, ${player.y}, ${player.z})`);
    assert.ok(player.z > startZ, `expected forward motion, got ${player.z} from ${startZ}`);
    assert.ok(player.z - startZ < RUN_SPEED * (25 / TICK_RATE),
      `travelled ${player.z - startZ}, further than the run speed allows`);
  });

  it("clamps a modified client's movement axes", async () => {
    const room = await colyseus.createRoom<RaceState>("race", {});
    const client = await colyseus.connectTo(room);
    const player = room.state.players.get(client.sessionId);
    const startZ = player.z;

    const input = client.input<RaceInput>({ mode: "reliable" });
    for (let i = 0; i < 20; i++) {
      input.data.moveZ = 500 as any;
      input.data.yaw = 0;
      input.send();
    }

    await room.waitForNextMessage();
    for (let i = 0; i < 6; i++) { await room.waitForNextTimestep(); }

    assert.ok(player.z - startZ < RUN_SPEED * (25 / TICK_RATE),
      "sanitize should clamp moveZ to 1 regardless of what was sent");
  });

  it("starts a countdown once two players are present", async () => {
    const room = await colyseus.createRoom<RaceState>("race", {});
    await colyseus.connectTo(room);
    await colyseus.connectTo(room);

    await room.waitForNextTimestep();
    await room.waitForNextTimestep();

    assert.strictEqual(room.state.phase, "countdown");
    assert.ok(room.state.countdownEndTick > room.state.tick);
  });

  it("holds the start gate solid until the race begins", async () => {
    const room = await colyseus.createRoom<RaceState>("race", {});
    await colyseus.connectTo(room);
    await room.waitForNextTimestep();

    const level = courseOf(room);
    const gate = level.obstacles.find((o) => o.kind === "startgate")!;
    const before = poseAt(gate, 0, { ...idlePhase, raceStartTick: -1 }, makePose());
    const after = poseAt(gate, 100, { ...idlePhase, raceStartTick: 50 }, makePose());

    assert.strictEqual(before.active, true, "gate blocks the lobby before the start");
    assert.strictEqual(after.active, false, "gate is gone once the race is underway");
  });

  /**
   * Reaching into the room to start the race directly. The alternative is
   * waiting out a real five-second countdown in every one of these tests, which
   * buys nothing: what is under test is what happens once the race IS running.
   */
  async function startRacing(room: any) {
    room.beginRace(room.state.tick);
    await room.waitForNextTimestep();
  }

  function placeAtFinish(room: any, sessionId: string, checkpoint: number) {
    const level = courseOf(room);
    const player = room.state.players.get(sessionId);
    player.checkpoint = checkpoint;
    player.x = level.finish.x;
    player.y = level.finish.y - level.finish.hy;
    player.z = level.finish.z;
    return player;
  }

  it("records a finish only once every checkpoint is banked", async () => {
    const room = await colyseus.createRoom<RaceState>("race", {});
    const c1 = await colyseus.connectTo(room);
    const c2 = await colyseus.connectTo(room);
    await startRacing(room);

    const level = courseOf(room);
    const last = level.checkpoints.length - 1;

    // Standing on the finish line having skipped the course is not a finish.
    const skipper = placeAtFinish(room as any, c1.sessionId, last - 1);
    await room.waitForNextTimestep();
    assert.strictEqual(skipper.finished, false, "a skipped checkpoint must block the finish");

    const legit = placeAtFinish(room as any, c2.sessionId, last);
    await room.waitForNextTimestep();
    assert.strictEqual(legit.finished, true, "a full run should register");
    assert.strictEqual(legit.rank, 1, "first one home takes first place");
    assert.ok(legit.finishMs >= 0, "a finish time is recorded");
  });

  it("ranks finishers ahead of runners, and runners by progress", async () => {
    const room = await colyseus.createRoom<RaceState>("race", {});
    const c1 = await colyseus.connectTo(room);
    const c2 = await colyseus.connectTo(room);
    const c3 = await colyseus.connectTo(room);
    await startRacing(room);

    const level = courseOf(room);
    const home = placeAtFinish(room as any, c3.sessionId, level.checkpoints.length - 1);
    await room.waitForNextTimestep();

    const behind = room.state.players.get(c1.sessionId);
    const ahead = room.state.players.get(c2.sessionId);
    behind.progress = 0.2;
    ahead.progress = 0.75;
    await room.waitForNextTimestep();

    assert.strictEqual(home.rank, 1, "the finisher holds first");
    assert.strictEqual(ahead.rank, 2, "further along the course ranks higher");
    assert.strictEqual(behind.rank, 3);
  });

  it("ends the match once everyone is home, then starts a fresh round", async () => {
    const room = await colyseus.createRoom<RaceState>("race", {});
    const c1 = await colyseus.connectTo(room);
    const c2 = await colyseus.connectTo(room);
    await startRacing(room);

    const level = courseOf(room);
    const last = level.checkpoints.length - 1;
    placeAtFinish(room as any, c1.sessionId, last);
    placeAtFinish(room as any, c2.sessionId, last);
    await room.waitForNextTimestep();
    await room.waitForNextTimestep();

    assert.strictEqual(room.state.phase, "results", "everyone home ends the race");
    assert.ok(room.state.resultsEndTick > room.state.tick, "results linger before the reset");

    const seedBefore = room.state.seed;
    const roundBefore = room.state.round;

    // Jump the clock to the end of the results screen.
    (room as any).resetRound(room.state.tick);
    await room.waitForNextTimestep();

    assert.notStrictEqual(room.state.seed, seedBefore, "a new round means a new course");
    assert.strictEqual(room.state.round, roundBefore + 1);
    for (const [, player] of room.state.players) {
      assert.strictEqual(player.finished, false, "runners are reset for the new round");
      assert.strictEqual(player.checkpoint, -1);
      assert.strictEqual(player.progress, 0);
      assert.ok(player.z < 0, "and put back in the lobby");
    }
  });

  it("ends immediately when a human wins a bots-only field", async () => {
    const room = await colyseus.createRoom<RaceState>("race", {});
    const human = await colyseus.connectTo(room);
    (room as any).addBot(room.state.tick);
    (room as any).addBot(room.state.tick);
    await startRacing(room);

    placeAtFinish(room as any, human.sessionId, courseOf(room).checkpoints.length - 1);
    await room.waitForNextTimestep();

    assert.strictEqual(room.state.phase, "results",
      "the human winner should not wait for bot opponents to finish");
    assert.strictEqual(room.state.players.get(human.sessionId).finished, true);
    for (const [, player] of room.state.players) {
      if (player.bot) { assert.strictEqual(player.dnf, true, "bots are retired with the round"); }
    }
  });

  it("marks anyone still running as a DNF when the race is called", async () => {
    const room = await colyseus.createRoom<RaceState>("race", {});
    const c1 = await colyseus.connectTo(room);
    await colyseus.connectTo(room);
    await startRacing(room);

    placeAtFinish(room as any, c1.sessionId, courseOf(room).checkpoints.length - 1);
    await room.waitForNextTimestep();
    (room as any).endRace(room.state.tick);
    await room.waitForNextTimestep();

    const finisher = room.state.players.get(c1.sessionId);
    assert.strictEqual(finisher.finished, true);
    let dnfs = 0;
    for (const [, player] of room.state.players) { if (player.dnf) { dnfs++; } }
    assert.strictEqual(dnfs, 1, "the runner who never made it is a DNF");
  });

  it("refuses a solo start before the unlock timer", async () => {
    const room = await colyseus.createRoom<RaceState>("race", {});
    const client = await colyseus.connectTo(room);
    await room.waitForNextTimestep();

    client.send("solo", {});
    await room.waitForNextMessage();
    await room.waitForNextTimestep();

    assert.strictEqual(room.state.phase, "waiting", "solo is gated behind the wait");
  });
});
