/**
 * Stage 10 - the race around the race.
 *
 * Six features, none of which touches the simulation. That is the whole reason
 * they ship together, and it is also what most of these tests are really
 * checking: that a bot goes through the same step a human does, that a
 * spectator's influence is a stamp rather than a special case, and that a
 * slipstream is a soft server-side force rather than a prediction.
 *
 * The bot sweep and the replay verifier are tools rather than features, and the
 * two tests that pin them are deliberately floors rather than targets - they
 * exist to catch a regression, not to assert that either is finished.
 */

import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../../src/app.config.js";
import type { RaceState } from "../../src/rooms/schema/RaceState.js";
import { useTestServer } from "../helpers/server.js";

import {
  DRAFT_MAX, DRAFT_MIN, DRAFT_TICKS, INFLUENCE_LOCKOUT_TICKS,
  INFLUENCE_TELEGRAPH_TICKS, PLATE_CONTEST_TICKS, RUN_SPEED,
  SERIES_FINAL_MULTIPLIER, SERIES_LENGTH, SERIES_POINTS, TICK_RATE,
} from "../../src/shared/constants.js";
import { DEFAULT_VERBS } from "../../src/shared/level.js";
import { BOT_PROFILES, BotChannel, blankInput } from "../../src/rooms/bot.js";
import { recordCourse, runCourse, sweep } from "../../src/rooms/sweep.js";
import { replayRecording } from "../../src/rooms/replay.js";

/**
 * A room on a known course with no deck on it.
 *
 * Rooms draw a mutator deck now, and half of these tests are about scoring
 * rules a mutator is allowed to bend - Sprint doubles series points, One Shot
 * hands an influence charge to everyone. Pinning the deck is the difference
 * between a test that checks the rule and a test that checks the rule most of
 * the time.
 */
async function cleanRoom(colyseus: ColyseusTestServer<typeof appConfig>) {
  const room: any = await colyseus.createRoom<RaceState>("race", {});
  room.armLevel(room.state.seed, []);
  return room;
}

describe("the series", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => { colyseus = await useTestServer(); });
  beforeEach(async () => { await colyseus.cleanup(); });

  /**
   * Put the field on the results screen with a known finishing order.
   *
   * Ranks are assigned by session id rather than by position in the player map:
   * the two happen to agree today and there is nothing that says they must.
   */
  async function finished(room: any, byId: Record<string, number>) {
    room.beginRace(room.state.tick);
    for (const [id, rank] of Object.entries(byId)) {
      const player = room.state.players.get(id);
      player.rank = rank;
      player.finished = rank > 0;
      player.dnf = rank === 0;
    }
    room.awardSeries();
  }

  it("pays five, three, two, one, and nothing for a DNF", async () => {
    const room = await cleanRoom(colyseus);
    const clients = [];
    for (let i = 0; i < 4; i++) { clients.push(await colyseus.connectTo(room)); }

    await finished(room, Object.fromEntries(
      clients.map((c, i) => [c.sessionId, [1, 2, 3, 0][i]])));
    const points = clients.map((c) => room.state.players.get(c.sessionId).seriesPoints);
    assert.deepStrictEqual(points, [SERIES_POINTS[0], SERIES_POINTS[1], SERIES_POINTS[2], 0],
      "a DNF is worth nothing; the points are a comeback mechanic, not a turnout one");
  });

  it("doubles the final round", async () => {
    const room = await cleanRoom(colyseus);
    const client = await colyseus.connectTo(room);
    await colyseus.connectTo(room);

    room.state.seriesRound = SERIES_LENGTH - 1;
    await finished(room, { [client.sessionId]: 1 });
    assert.strictEqual(
      room.state.players.get(client.sessionId).seriesPoints,
      SERIES_POINTS[0] * SERIES_FINAL_MULTIPLIER,
      "the last round is what keeps a session alive when somebody is two down");
  });

  it("seeds a mid-series joiner at the current last place", async () => {
    const room = await cleanRoom(colyseus);
    const first = await colyseus.connectTo(room);
    const second = await colyseus.connectTo(room);
    room.state.players.get(first.sessionId).seriesPoints = 11;
    room.state.players.get(second.sessionId).seriesPoints = 4;

    const late = await colyseus.connectTo(room);
    assert.strictEqual(room.state.players.get(late.sessionId).seriesPoints, 4,
      "zero would make a newcomer mathematically eliminated on arrival");
  });

  it("crowns a winner and starts a fresh series", async () => {
    const room = await cleanRoom(colyseus);
    const winner = await colyseus.connectTo(room);
    await colyseus.connectTo(room);

    room.state.seriesRound = SERIES_LENGTH - 1;
    await finished(room, { [winner.sessionId]: 1 });
    assert.strictEqual(room.state.seriesWinner, winner.sessionId);

    room.advanceSeries();
    assert.strictEqual(room.state.seriesRound, 0, "the next series starts over");
    assert.strictEqual(room.state.seriesWinner, "");
    assert.strictEqual(room.state.players.get(winner.sessionId).seriesPoints, 0);
  });

  it("leaves a tie at the top undecided rather than picking one", async () => {
    const room = await cleanRoom(colyseus);
    await colyseus.connectTo(room);
    await colyseus.connectTo(room);
    room.state.seriesRound = SERIES_LENGTH - 1;
    await finished(room, {});
    assert.strictEqual(room.state.seriesWinner, "", "nobody scored, so nobody won");
  });
});

describe("splits", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => { colyseus = await useTestServer(); });
  beforeEach(async () => { await colyseus.cleanup(); });

  it("stamps a split the tick a checkpoint is banked, and keeps the best", async () => {
    const room: any = await colyseus.createRoom<RaceState>("race", {});
    const a = await colyseus.connectTo(room);
    const b = await colyseus.connectTo(room);
    room.beginRace(room.state.tick);
    const start = room.state.raceStartTick;

    const first = room.state.players.get(a.sessionId);
    const second = room.state.players.get(b.sessionId);
    first.checkpoint = 0;
    room.recordSplits(start + 90);
    second.checkpoint = 0;
    room.recordSplits(start + 150);

    assert.strictEqual(first.splits[0], Math.round(90 * (1000 / TICK_RATE)));
    assert.strictEqual(second.splits[0], Math.round(150 * (1000 / TICK_RATE)));
    assert.strictEqual(room.state.bestSplits[0], first.splits[0],
      "the best to a checkpoint is what everyone else is measured against");

    // A split is written once and never revised.
    room.recordSplits(start + 300);
    assert.strictEqual(first.splits[0], Math.round(90 * (1000 / TICK_RATE)));
  });

  it("keeps last round's bests as the reference a leader is measured on", async () => {
    const room: any = await colyseus.createRoom<RaceState>("race", {});
    await colyseus.connectTo(room);
    room.beginRace(room.state.tick);
    room.state.bestSplits[0] = 4242;
    room.armLevel(77);
    assert.strictEqual(room.state.prevBestSplits[0], 4242,
      "a leader has nobody ahead of them, so they run against the round before");
    assert.strictEqual(room.state.bestSplits[0], 0, "and this round starts clean");
  });
});

describe("bots", () => {
  it("cannot press anything a human could not", () => {
    // Not defensive programming: the guarantee. A bot fills an input channel,
    // and that channel coerces every field exactly as the wire does.
    const channel = new BotChannel();
    channel.push({
      ...blankInput(),
      moveX: 500 as any, moveZ: -9 as any,
      yaw: Number.NaN, pitch: 99,
      jump: 1 as any,
    });
    const [frame] = [...channel];
    assert.strictEqual(frame.moveX, 1, "an axis is coerced, not trusted");
    assert.strictEqual(frame.moveZ, -1);
    assert.strictEqual(frame.yaw, 0, "a NaN yaw would poison the step forever");
    assert.ok(frame.pitch <= 1.03, "pitch is clamped to what a camera can do");
    assert.strictEqual(frame.jump, true);
  });

  it("hands its inputs over one at a time, with a sequence the room can read", () => {
    const channel = new BotChannel();
    for (let i = 0; i < 3; i++) { channel.push({ ...blankInput(), moveZ: 1 }); }
    let seen = 0;
    for (const _ of channel) { seen++; assert.strictEqual(channel.consumedCount, seen); }
    assert.strictEqual(seen, 3);
    assert.deepStrictEqual([...channel], [], "and the buffer empties as it goes");
  });

  it("leaves no trace of itself anywhere in the shared simulation", async () => {
    // The structural claim of the whole feature. If `src/shared` knows what a
    // bot is, a bot can be given something a human cannot have.
    const { readFileSync, readdirSync } = await import("node:fs");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]);

    for (const file of walk("src/shared")) {
      const text = readFileSync(file, "utf8");
      assert.ok(!/\bbot\b/i.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "")),
        `${file} mentions a bot; the simulation must not know one exists`);
    }
  });

  it("runs the course through the same step, and gets somewhere", () => {
    const result = runCourse(3, BOT_PROFILES.hard, { verbs: DEFAULT_VERBS, limit: 900 });
    assert.ok(result.progress > 0.08,
      `a bot should be well down the course by thirty seconds, got ${result.progress}`);
    assert.ok(result.cleared.length > 0, "and through at least one section");
  });

  it("is deterministic, so the sweep means something", () => {
    const a = runCourse(21, BOT_PROFILES.fair, { verbs: DEFAULT_VERBS, limit: 600 });
    const b = runCourse(21, BOT_PROFILES.fair, { verbs: DEFAULT_VERBS, limit: 600 });
    assert.strictEqual(a.progress, b.progress);
    assert.deepStrictEqual(a.cleared, b.cleared);
  });
});

describe("the bot sweep", () => {
  /**
   * A floor, not a target.
   *
   * The spec asks for 95% at hard and the bot is a long way short of that; what
   * this test is for is catching a *regression* in either the bot or the pool,
   * and giving the per-section rates somewhere to be asserted. The honest
   * numbers live in the stage-10 notes.
   */
  it("completes courses, and says which sections it cannot", function () {
    this.timeout(60_000);
    const report = sweep(30, BOT_PROFILES.hard, { verbs: DEFAULT_VERBS });

    assert.ok(report.rate >= 0.35,
      `completion fell to ${(report.rate * 100).toFixed(0)}%, which is a regression`);
    assert.ok(report.sections.length > 6, "the report has to name sections to be useful");

    for (const s of report.sections) {
      assert.ok(s.rate >= 0 && s.rate <= 1);
      assert.ok(s.cleared <= s.reached, "a section cannot be cleared more often than reached");
    }

    // The sections a bot walks straight through must stay that way.
    const easy = report.sections.filter((s) => ["straightaway", "climb"].includes(s.id));
    for (const s of easy) {
      assert.ok(s.rate >= 0.95, `${s.id} dropped to ${(s.rate * 100).toFixed(0)}%`);
    }
  });
});

describe("replays", () => {
  it("re-runs a recorded race to bit-identical positions and stamps", function () {
    this.timeout(30_000);
    let stamps = 0;
    for (const seed of [1, 2, 3, 4, 5]) {
      const { recording } = recordCourse(seed, BOT_PROFILES.fair, {
        verbs: DEFAULT_VERBS, threats: true,
      });
      const result = replayRecording(recording);
      assert.strictEqual(result.divergence, null, `seed ${seed}: ${result.divergence}`);
      stamps += result.stamps;
    }
    // Not every course puts a crumble or a plate on the line a bot takes, so
    // the count is asserted across the set rather than per seed.
    assert.ok(stamps > 0, "the fixture must actually regenerate some stamps");
  });

  it("catches a deliberately introduced divergence", function () {
    this.timeout(30_000);
    // Testing the test. A replay that cannot fail proves nothing at all.
    const { recording } = recordCourse(4, BOT_PROFILES.fair, {
      verbs: DEFAULT_VERBS, threats: true,
    });
    assert.ok(recording.stamps.length > 0);

    const tampered = JSON.parse(JSON.stringify(recording));
    tampered.stamps[0][3] += 1;
    assert.ok(replayRecording(tampered).divergence,
      "a stamp one tick out has to be caught, or the replay is decoration");

    const shifted = JSON.parse(JSON.stringify(recording));
    const half = Math.floor(shifted.players[0].inputs.length / 2);
    for (let i = half; i < half + 30; i++) { shifted.players[0].inputs[i].frame.moveZ = -1; }
    assert.ok(replayRecording(shifted).divergence,
      "and so does a second of input nobody ever pressed");
  });

  it("records inputs rather than positions, and stays small", function () {
    this.timeout(30_000);
    const { recording } = recordCourse(4, BOT_PROFILES.fair, {
      verbs: DEFAULT_VERBS,
    });
    const bytes = JSON.stringify(recording).length;
    assert.ok(bytes < 1_500_000, `an eighty-second race recorded to ${bytes} bytes`);
    assert.strictEqual(recording.players[0].inputs.length, recording.ticks,
      "one frame per tick, and nothing else about where anybody was");
    // The seq is carried separately from the tick, which is the thing a naive
    // recording gets wrong: `tickBase + seq` is what obstacle motion is on.
    assert.ok(recording.players[0].inputs.every((i) => typeof i.seq === "number"));
  });
});

describe("interference", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => { colyseus = await useTestServer(); });
  beforeEach(async () => { await colyseus.cleanup(); });

  it("moves a Chain level from a leader to whoever is drafting them", async () => {
    const room: any = await colyseus.createRoom<RaceState>("race", {});
    const leadClient = await colyseus.connectTo(room);
    const draftClient = await colyseus.connectTo(room);
    room.beginRace(room.state.tick);

    const lead = room.state.players.get(leadClient.sessionId);
    const drafter = room.state.players.get(draftClient.sessionId);
    lead.chain = 5;
    drafter.chain = 0;
    lead.x = 0; lead.y = 0; lead.z = 3;
    drafter.x = 0; drafter.y = 0; drafter.z = 0;
    drafter.vx = 0; drafter.vz = RUN_SPEED;

    for (let i = 0; i < DRAFT_TICKS; i++) { room.applyDraft(room.state.tick); }
    assert.strictEqual(drafter.chain, 1, "two seconds of clean drafting is one level");
    assert.strictEqual(lead.chain, 4, "and it came off the runner in front");
  });

  it("pays only the nearest drafter, so a pack cannot stack on one leader", async () => {
    const room: any = await colyseus.createRoom<RaceState>("race", {});
    const ids = [];
    for (let i = 0; i < 3; i++) { ids.push((await colyseus.connectTo(room)).sessionId); }
    room.beginRace(room.state.tick);

    const [lead, near, far] = ids.map((id: string) => room.state.players.get(id));
    lead.chain = 6; lead.x = 0; lead.z = 6;
    near.chain = 0; near.x = 0; near.z = 3; near.vz = RUN_SPEED;
    far.chain = 0; far.x = 0; far.z = 1.5; far.vz = RUN_SPEED;

    for (let i = 0; i < DRAFT_TICKS; i++) { room.applyDraft(room.state.tick); }
    assert.strictEqual(near.chain, 1);
    assert.strictEqual(far.chain, 0, "drafting is one-on-one, or a pack never breaks up");
  });

  it("will not draft off somebody beside you, or too far, or too close", async () => {
    const room: any = await colyseus.createRoom<RaceState>("race", {});
    const leadId = (await colyseus.connectTo(room)).sessionId;
    const meId = (await colyseus.connectTo(room)).sessionId;
    room.beginRace(room.state.tick);
    const lead = room.state.players.get(leadId);
    const me = room.state.players.get(meId);

    const attempt = (lx: number, lz: number) => {
      lead.chain = 5; me.chain = 0;
      me.x = 0; me.z = 0; me.vx = 0; me.vz = RUN_SPEED;
      lead.x = lx; lead.z = lz;
      for (let i = 0; i < DRAFT_TICKS + 2; i++) { room.applyDraft(room.state.tick); }
      return me.chain;
    };

    assert.strictEqual(attempt(0, DRAFT_MAX + 2), 0, "too far back to be in the wake");
    assert.strictEqual(attempt(0, DRAFT_MIN - 0.5), 0, "and inside it you are just colliding");
    assert.strictEqual(attempt(4, 3), 0, "abreast is not behind");
    assert.strictEqual(attempt(0, 3), 1, "the fixture has to be able to succeed");
  });

  it("makes the bridge plate a held plate once there is a field to contest it", async () => {
    const room: any = await colyseus.createRoom<RaceState>("race", {});
    await colyseus.connectTo(room);
    await colyseus.connectTo(room);

    // The room's own course, not one rebuilt from the seed: a round has a deck
    // on it now, and a course built without one has different plates.
    const level = room.level;
    if (level.plates.length === 0) { return; }

    room.touchPlate(0, 100);
    const duo = room.state.plateTicks[0] - 100;
    assert.strictEqual(duo, level.plates[0].holdTicks,
      "under three runners it stays the long hold, or a duo is simply stuck");

    await colyseus.connectTo(room);
    room.plateTicks[0] = -1;
    room.touchPlate(0, 200);
    assert.strictEqual(room.state.plateTicks[0] - 200, PLATE_CONTEST_TICKS,
      "with a field to spare, whoever opens the bridge cannot also cross it");
  });
});

describe("finished-runner influence", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => { colyseus = await useTestServer(); });
  beforeEach(async () => { await colyseus.cleanup(); });

  async function racing() {
    const room = await cleanRoom(colyseus);
    const client = await colyseus.connectTo(room);
    room.beginRace(room.state.tick);
    room.state.raceDeadlineTick = room.state.tick + TICK_RATE * 120;
    return { room, client, player: room.state.players.get(client.sessionId) };
  }

  it("refuses a runner who is still in the race", async () => {
    const { room, client, player } = await racing();
    room.messages.influence({ sessionId: client.sessionId } as any, { slot: 0 });
    assert.strictEqual(player.influence, 1, "you do not get to reach into a race you are in");
  });

  it("telegraphs by name and moves nothing until the telegraph is up", async () => {
    const { room, client, player } = await racing();
    if (room.level.breakerCount === 0) { return; }
    player.finished = true;

    const at = room.state.tick + INFLUENCE_TELEGRAPH_TICKS;
    room.messages.influence({ sessionId: client.sessionId } as any, { slot: 0 });
    assert.strictEqual(player.influence, 0, "one charge, spent");

    room.applyInfluence(at - 1);
    assert.strictEqual(room.state.breakerTicks[0], -1, "nothing moves before the telegraph is up");
    room.applyInfluence(at);
    assert.strictEqual(room.state.breakerTicks[0], at, "and then it does, for everyone");
  });

  it("is one charge, and none at all near the finish", async () => {
    const { room, client, player } = await racing();
    if (room.level.breakerCount < 2) { return; }
    player.finished = true;

    room.messages.influence({ sessionId: client.sessionId } as any, { slot: 0 });
    room.messages.influence({ sessionId: client.sessionId } as any, { slot: 1 });
    assert.strictEqual(room.pending.length, 1, "one charge per player per race");

    player.influence = 1;
    room.state.raceDeadlineTick = room.state.tick + INFLUENCE_LOCKOUT_TICKS - 1;
    room.messages.influence({ sessionId: client.sessionId } as any, { slot: 1 });
    assert.strictEqual(player.influence, 1, "and it cannot decide a photo finish");
  });
});
