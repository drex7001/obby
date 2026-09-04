/**
 * The headless bot sweep.
 *
 * This is the course generator's test suite as much as it is a bot harness: a
 * thousand seeds run with no renderer and no network, each one asking the only
 * question the generator cannot answer about itself - *is this course actually
 * completable?* Section pass rates come out the other end, which is what turns
 * "bot navigability" from an aspiration into a constraint the pool is held to.
 *
 * It drives the same `stepPlayer()` the server does, through the same input
 * shape a client sends, against a world assembled exactly as `RaceRoom` does.
 * Nothing here is a simulation of the game; it *is* the game, without the
 * parts that need a socket.
 */

import {
  CRUMBLE_DELAY_TICKS, CRUMBLE_GONE_TICKS, RACE_LIMIT_TICKS, TICK_RATE,
} from "../shared/constants.js";
import { inVolume } from "../shared/collision.js";
import { buildLevelWith, type Level } from "../shared/level.js";
import type { SimInput, SimState, SimWorld } from "../shared/movement.js";
import { stepPlayer } from "../shared/movement.js";
import type { WorldPhase } from "../shared/obstacles.js";
import { makeRecallRing } from "../shared/recall.js";
import type { Verb } from "../shared/sections/types.js";
import { blankInput, BotController, type BotProfile } from "./bot.js";
import { Recorder, StampKind, type RaceRecording } from "./replay.js";
import { Threats } from "./threats.js";

export interface SweepOptions {
  verbs?: readonly Verb[];
  /** Tick budget. Defaults to the room's own race limit. */
  limit?: number;
  /** Run the enemy field too. Off makes a course-only sweep cheaper. */
  threats?: boolean;
  /** Collect a replayable recording of the run. */
  record?: Recorder;
}

export interface SweepResult {
  seed: number;
  finished: boolean;
  ticks: number;
  progress: number;
  checkpoint: number;
  falls: number;
  /** Id of the section the runner was in when it ran out of course or clock. */
  stuckIn: string | null;
  /** Every section the runner got all the way through. */
  cleared: string[];
  /** Where the runner ended up, for a replay to compare against. */
  finalState: SimState;
}

/** A fresh, cold world for one course - the same shape `armLevel()` builds. */
function makeWorld(level: Level, threats: Threats | null, record?: Recorder) {
  const phase: WorldPhase = {
    raceStartTick: 0,
    crumbleTicks: new Array<number>(level.crumbleCount).fill(-1),
    plateTicks: new Array<number>(level.plates.length).fill(-1),
    plateSince: new Array<number>(level.plates.length).fill(-1),
    breakerTicks: new Array<number>(level.breakerCount).fill(-1),
    pickupTicks: new Array<number>(level.pickupCount).fill(-1),
    shellTicks: new Array<number>(level.shellCount).fill(-1),
  };
  let falls = 0;

  const world: SimWorld = {
    level,
    phase,
    tickBase: 0,
    others: [],
    enemies: threats ? threats.enemies : [],
    history: makeRecallRing(),
    onCrumble: (slot, tick) => {
      if (phase.crumbleTicks[slot] < 0) {
        (phase.crumbleTicks as number[])[slot] = tick;
        record?.stamp(tick, StampKind.Crumble, slot, tick);
      }
    },
    onPlate: (plate, tick) => {
      if (phase.plateTicks[plate] < 0) {
        (phase.plateSince as number[])[plate] = tick;
        record?.stamp(tick, StampKind.PlateSince, plate, tick);
      }
      const until = tick + level.plates[plate].holdTicks;
      (phase.plateTicks as number[])[plate] = until;
      record?.stamp(tick, StampKind.PlateUntil, plate, until);
    },
    onShot: (slot, tick) => {
      if (phase.breakerTicks[slot] < 0) {
        (phase.breakerTicks as number[])[slot] = tick;
        record?.stamp(tick, StampKind.Breaker, slot, tick);
      }
    },
    onPickup: (slot, tick) => {
      (phase.pickupTicks as number[])[slot] = tick;
      record?.stamp(tick, StampKind.Pickup, slot, tick);
    },
    onShell: (slot, tick) => {
      (phase.shellTicks as number[])[slot] = tick;
      record?.stamp(tick, StampKind.Shell, slot, tick);
    },
    onEnemyHit: (id, tick) => { threats?.hit(id, tick); },
    onRespawn: (voluntary) => { if (!voluntary) { falls += 1; } },
  };
  world.onHeavyPlate = world.onPlate;

  return { world, phase, falls: () => falls };
}

/** Retire crumble platforms and cool plates, exactly as the room does. */
function advanceObstacles(phase: WorldPhase, tick: number) {
  const crumbles = phase.crumbleTicks as number[];
  for (let i = 0; i < crumbles.length; i++) {
    const trig = crumbles[i];
    if (trig >= 0 && tick > trig + CRUMBLE_DELAY_TICKS + CRUMBLE_GONE_TICKS) { crumbles[i] = -1; }
  }
  const until = phase.plateTicks as number[];
  const since = phase.plateSince as number[];
  for (let i = 0; i < until.length; i++) {
    if (until[i] >= 0 && tick > until[i]) { until[i] = -1; since[i] = -1; }
  }
}

/**
 * Which section a fraction of the way along the course falls in.
 *
 * Measured in the section table's own units rather than the path's: a spine
 * wanders inside its section, so arc length along the centre-line is a few per
 * cent longer than the lengths the sections declare, and mixing the two puts
 * every late failure in the last section.
 */
function sectionAt(level: Level, progress: number): string | null {
  const along = progress * level.courseLength;
  for (const s of level.sections) {
    if (along >= s.at && along <= s.at + s.length) { return s.id; }
  }
  return level.sections[level.sections.length - 1]?.id ?? null;
}

function spawnState(level: Level): SimState {
  return {
    x: level.spawn.x, y: level.spawn.y, z: level.spawn.z,
    vx: 0, vy: 0, vz: 0, yaw: 0,
    grounded: true, groundId: 0, coyote: 0, jumpBuf: 0, jumpHeld: false,
    stun: 0, respawn: 0, checkpoint: -1, progress: 0,
    chain: 0, impactBuf: 0, heavyHeld: false, heavyArmed: false, heavySince: -1,
    plantUntil: -1, chainDecayUntil: -1,
    carving: false, carveUntil: -1, carveCool: -1, hopWindow: 0,
    knockTick: -1, knockX: 0, knockY: 0, knockZ: 0,
    ammo: 0, fireCool: -1, actionHeld: false, useHeld: false, pickupIn: 0,
    burnTick: -1, burnAmount: 0, shieldUntil: -1,
    anchorId: 0, ropeLen: 0, tension: 0, tetherCool: -1, tetherUntil: -1,
    recallCharges: 1, recallUntil: -1, recallHeld: 0,
  };
}

const ctx = {
  dt: 1 / TICK_RATE,
  tick: 0,
  subSteps: 3,
  subDt: 1 / (TICK_RATE * 3),
  isReplay: false,
};

/** Run one bot through one course and report what happened. */
export function runCourse(
  seed: number, profile: BotProfile, options: SweepOptions = {},
): SweepResult {
  const level = buildLevelWith(seed, { verbs: options.verbs });
  const threats = options.threats ? new Threats() : null;
  threats?.reset(level, 0);

  const record = options.record;
  const { world, phase, falls } = makeWorld(level, threats, record);
  const bot = new BotController(profile, seed * 7919 + 13);
  const state = spawnState(level);
  const input: SimInput = blankInput();
  const limit = options.limit ?? RACE_LIMIT_TICKS;
  record?.join("bot-0", profile.name, 0, true, 0, level.spawn);

  const cleared = new Set<string>();
  let last = -1;

  for (let tick = 0; tick < limit; tick++) {
    advanceObstacles(phase, tick);
    if (threats) {
      threats.update(level, tick, [{ x: state.x, y: state.y, z: state.z, live: state.respawn <= 0 }]);
    }

    bot.think(state, level, phase, tick, input);
    record?.input("bot-0", tick, tick, input);
    ctx.tick = tick;
    stepPlayer(ctx, state, input, world);

    if (state.checkpoint > last) {
      last = state.checkpoint;
      // A banked checkpoint means the section behind it is done with.
      const done = level.sections[state.checkpoint];
      if (done) { cleared.add(done.id); }
    }

    if (state.checkpoint >= level.checkpoints.length - 1
      && inVolume(state.x, state.y, state.z, level.finish)) {
      for (const s of level.sections) { cleared.add(s.id); }
      return {
        seed, finished: true, ticks: tick, progress: 1,
        checkpoint: state.checkpoint, falls: falls(),
        stuckIn: null, cleared: [...cleared], finalState: state,
      };
    }
  }

  return {
    seed, finished: false, ticks: limit, progress: state.progress,
    checkpoint: state.checkpoint, falls: falls(),
    stuckIn: sectionAt(level, state.progress), cleared: [...cleared],
    finalState: state,
  };
}

/** Run one bot race and hand back a recording of it. */
export function recordCourse(
  seed: number, profile: BotProfile, options: SweepOptions = {},
): { result: SweepResult; recording: RaceRecording } {
  const recorder = new Recorder(
    seed, 0, options.verbs ?? [], options.threats === true);
  const result = runCourse(seed, profile, { ...options, record: recorder });
  const recording = recorder.finish([{
    sessionId: "bot-0",
    x: result.finalState.x, y: result.finalState.y, z: result.finalState.z,
    progress: result.finalState.progress,
    checkpoint: result.finalState.checkpoint,
    chain: result.finalState.chain,
  }]);
  return { result, recording };
}

export interface SweepReport {
  seeds: number;
  finished: number;
  rate: number;
  medianTicks: number;
  /** Per section: how often a run that reached it also got through it. */
  sections: Array<{ id: string; reached: number; cleared: number; rate: number }>;
  worst: SweepResult[];
}

/** Run a whole sweep and summarise it. */
export function sweep(
  seeds: number, profile: BotProfile, options: SweepOptions = {},
): SweepReport {
  const results: SweepResult[] = [];
  const reached = new Map<string, number>();
  const cleared = new Map<string, number>();

  for (let seed = 1; seed <= seeds; seed++) {
    const result = runCourse(seed, profile, options);
    results.push(result);

    const level = buildLevelWith(seed, { verbs: options.verbs });
    const along = result.progress * level.courseLength;
    for (const s of level.sections) {
      if (along < s.at) { continue; }
      reached.set(s.id, (reached.get(s.id) ?? 0) + 1);
      if (result.cleared.includes(s.id)) {
        cleared.set(s.id, (cleared.get(s.id) ?? 0) + 1);
      }
    }
  }

  const times = results.filter((r) => r.finished).map((r) => r.ticks).sort((a, b) => a - b);
  const sections = [...reached.keys()].map((id) => {
    const saw = reached.get(id) ?? 0;
    const got = cleared.get(id) ?? 0;
    return { id, reached: saw, cleared: got, rate: saw > 0 ? got / saw : 0 };
  }).sort((a, b) => a.rate - b.rate);

  const finished = results.filter((r) => r.finished).length;
  return {
    seeds,
    finished,
    rate: finished / seeds,
    medianTicks: times.length > 0 ? times[Math.floor(times.length / 2)] : -1,
    sections,
    worst: results.filter((r) => !r.finished).slice(0, 8),
  };
}
