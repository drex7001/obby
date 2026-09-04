/**
 * Deterministic replays.
 *
 * A race is already completely described by data the server has: the seed, each
 * player's input stream, their `tickBase` and its rebases, and the tick stamps.
 * Store those and re-run the simulation. No video, no position recording, no
 * interpolation - a hundred-second six-player race is a few hundred kilobytes
 * of inputs, and inputs compress extremely well.
 *
 * Two things are easy to forget and break everything:
 *
 * 1. **`tickBase` rebases.** The room walks a player's base a tick at a time to
 *    keep their seq->tick mapping anchored. A replay that uses only the initial
 *    base drifts exactly as a lagging client would.
 * 2. **Stamps are recorded as *writes*, not as state.** A faithful replay
 *    regenerates them - but only if it is bit-exact. Recording them lets the
 *    replayer *assert* they match, which is what turns a replay from a
 *    convenience into a determinism test. A regenerated stamp that disagrees
 *    with the recording has found a real bug.
 */

import { CRUMBLE_DELAY_TICKS, CRUMBLE_GONE_TICKS, TICK_RATE } from "../shared/constants.js";
import { buildLevelWith } from "../shared/level.js";
import type { SimInput, SimState, SimWorld } from "../shared/movement.js";
import { stepPlayer } from "../shared/movement.js";
import type { WorldPhase } from "../shared/obstacles.js";
import { makeRecallRing } from "../shared/recall.js";
import type { Verb } from "../shared/sections/types.js";
import { Threats, type ThreatTarget } from "./threats.js";

/** Which stamp array a write landed in. Numbers, because this is serialised. */
export const enum StampKind {
  Crumble = 0,
  PlateUntil = 1,
  PlateSince = 2,
  Breaker = 3,
  Pickup = 4,
  Shell = 5,
}

/** `[tick, kind, index, value]`. Flat on purpose: it is most of the file size. */
export type StampWrite = [number, StampKind, number, number];

/**
 * One input frame, with the world tick the server consumed it on **and** the
 * sequence index it was consumed at.
 *
 * Both, because they are not the same number and the difference is exactly what
 * a replay gets wrong. The tick orders the frame against the rest of the world;
 * the seq is what `tickBase + seq` resolves to, and that is what obstacle
 * motion is indexed by. Recording only the tick puts every stamp one tick out.
 */
export interface RecordedInput {
  tick: number;
  seq: number;
  frame: SimInput;
}

export interface RecordedPlayer {
  sessionId: string;
  name: string;
  colour: number;
  bot: boolean;
  tickBase: number;
  spawn: { x: number; y: number; z: number };
  inputs: RecordedInput[];
  /** `[tick, newBase]`, in the order the room applied them. */
  rebases: Array<[number, number]>;
}

export interface RaceRecording {
  version: number;
  seed: number;
  round: number;
  verbs: readonly Verb[];
  threats: boolean;
  ticks: number;
  players: RecordedPlayer[];
  stamps: StampWrite[];
  /** What the authoritative run ended on, for the replayer to compare against. */
  outcome: Array<{
    sessionId: string;
    x: number; y: number; z: number;
    progress: number; checkpoint: number; chain: number;
  }>;
}

export const REPLAY_VERSION = 1;

/**
 * Collects a recording as a race runs.
 *
 * Everything here is a push onto an array that is allocated once per race. The
 * step itself is untouched - the recorder is called from the room around it,
 * never from inside it.
 */
export class Recorder {
  private players = new Map<string, RecordedPlayer>();
  private stamps: StampWrite[] = [];
  private ticks = 0;

  constructor(
    readonly seed: number,
    readonly round: number,
    readonly verbs: readonly Verb[],
    readonly threats: boolean,
  ) {}

  join(sessionId: string, name: string, colour: number, bot: boolean,
    tickBase: number, spawn: { x: number; y: number; z: number }) {
    this.players.set(sessionId, {
      sessionId, name, colour, bot, tickBase,
      spawn: { ...spawn },
      inputs: [], rebases: [],
    });
  }

  input(sessionId: string, tick: number, seq: number, frame: SimInput) {
    this.players.get(sessionId)?.inputs.push({ tick, seq, frame: { ...frame } });
    if (tick + 1 > this.ticks) { this.ticks = tick + 1; }
  }

  rebase(sessionId: string, tick: number, base: number) {
    this.players.get(sessionId)?.rebases.push([tick, base]);
  }

  stamp(tick: number, kind: StampKind, index: number, value: number) {
    this.stamps.push([tick, kind, index, value]);
  }

  finish(outcome: RaceRecording["outcome"]): RaceRecording {
    return {
      version: REPLAY_VERSION,
      seed: this.seed,
      round: this.round,
      verbs: this.verbs,
      threats: this.threats,
      ticks: this.ticks,
      players: [...this.players.values()],
      stamps: this.stamps,
      outcome,
    };
  }
}

export interface ReplayResult {
  ok: boolean;
  /** Human-readable account of the first thing that did not match. */
  divergence: string | null;
  /** Stamp writes the replay regenerated. */
  stamps: number;
  ticks: number;
}

const ctx = {
  dt: 1 / TICK_RATE, tick: 0, subSteps: 3, subDt: 1 / (TICK_RATE * 3), isReplay: false,
};

/**
 * Re-run a recording and check that it comes out the same.
 *
 * Every stamp the replay generates is compared against the one the recording
 * says the authoritative run generated, in order. A mismatch is not a replay
 * bug - it is a determinism bug, and finding it is the whole point.
 */
export function replayRecording(rec: RaceRecording): ReplayResult {
  if (rec.version !== REPLAY_VERSION) {
    return { ok: false, divergence: `recording is version ${rec.version}`, stamps: 0, ticks: 0 };
  }

  const level = buildLevelWith(rec.seed, { verbs: rec.verbs });
  const threats = rec.threats ? new Threats() : null;
  threats?.reset(level, 0);

  const phase: WorldPhase = {
    raceStartTick: 0,
    crumbleTicks: new Array<number>(level.crumbleCount).fill(-1),
    plateTicks: new Array<number>(level.plates.length).fill(-1),
    plateSince: new Array<number>(level.plates.length).fill(-1),
    breakerTicks: new Array<number>(level.breakerCount).fill(-1),
    pickupTicks: new Array<number>(level.pickupCount).fill(-1),
    shellTicks: new Array<number>(level.shellCount).fill(-1),
  };

  let divergence: string | null = null;
  let index = 0;
  let now = 0;

  /**
   * Regenerate a stamp, and hold it against what the recording remembers.
   *
   * `stampedAt` is the hook's own tick, which is a *sub-step* tick floored - not
   * the loop tick. Comparing against the loop tick instead is off by one on any
   * stamp raised in the last third of a tick.
   */
  const write = (kind: StampKind, stampedAt: number, at: number, value: number, into: number[]) => {
    into[at] = value;
    const expected = rec.stamps[index++];
    if (divergence) { return; }
    if (!expected) {
      divergence = `tick ${now}: replay produced an extra stamp (${kind}, ${at}, ${value})`;
      return;
    }
    if (expected[0] !== stampedAt || expected[1] !== kind
      || expected[2] !== at || expected[3] !== value) {
      divergence = `tick ${now}: stamp ${index - 1} regenerated as `
        + `[${stampedAt}, ${kind}, ${at}, ${value}] but was recorded as [${expected.join(", ")}]`;
    }
  };

  const states = new Map<string, SimState>();
  const worlds = new Map<string, SimWorld>();
  const bases = new Map<string, number>();
  const cursors = new Map<string, number>();
  const rebaseAt = new Map<string, number>();

  for (const p of rec.players) {
    const state = freshState(p.spawn);
    states.set(p.sessionId, state);
    bases.set(p.sessionId, p.tickBase);
    cursors.set(p.sessionId, 0);
    rebaseAt.set(p.sessionId, 0);
    worlds.set(p.sessionId, {
      level, phase, tickBase: p.tickBase, others: [],
      enemies: threats ? threats.enemies : [],
      history: makeRecallRing(),
      onCrumble: (slot, tick) => {
        if (phase.crumbleTicks[slot] < 0) {
          write(StampKind.Crumble, tick, slot, tick, phase.crumbleTicks as number[]);
        }
      },
      onPlate: (plate, tick) => {
        if (phase.plateTicks[plate] < 0) {
          write(StampKind.PlateSince, tick, plate, tick, phase.plateSince as number[]);
        }
        write(StampKind.PlateUntil, tick, plate,
          tick + level.plates[plate].holdTicks, phase.plateTicks as number[]);
      },
      onShot: (slot, tick) => {
        if (phase.breakerTicks[slot] < 0) {
          write(StampKind.Breaker, tick, slot, tick, phase.breakerTicks as number[]);
        }
      },
      onPickup: (slot, tick) => {
        write(StampKind.Pickup, tick, slot, tick, phase.pickupTicks as number[]);
      },
      onShell: (slot, tick) => {
        write(StampKind.Shell, tick, slot, tick, phase.shellTicks as number[]);
      },
      onEnemyHit: (id, tick) => { threats?.hit(id, tick); },
    });
    worlds.get(p.sessionId)!.onHeavyPlate = worlds.get(p.sessionId)!.onPlate;
  }

  for (let tick = 0; tick < rec.ticks && !divergence; tick++) {
    now = tick;
    retire(phase, tick);
    if (threats) {
      const targets: ThreatTarget[] = [];
      for (const p of rec.players) {
        const s = states.get(p.sessionId)!;
        targets.push({ x: s.x, y: s.y, z: s.z, live: s.respawn <= 0 });
      }
      threats.update(level, tick, targets);
    }

    for (const p of rec.players) {
      const state = states.get(p.sessionId)!;
      const world = worlds.get(p.sessionId)!;
      let cursor = cursors.get(p.sessionId)!;
      while (cursor < p.inputs.length && p.inputs[cursor].tick === tick) {
        world.tickBase = bases.get(p.sessionId)!;
        ctx.tick = p.inputs[cursor].seq;
        stepPlayer(ctx, state, p.inputs[cursor].frame, world);
        cursor++;
      }
      cursors.set(p.sessionId, cursor);

      // Rebases move the seq->tick mapping. A replay that skips them drifts
      // exactly as the client it is replaying would have.
      let at = rebaseAt.get(p.sessionId)!;
      while (at < p.rebases.length && p.rebases[at][0] <= tick) {
        bases.set(p.sessionId, p.rebases[at][1]);
        at++;
      }
      rebaseAt.set(p.sessionId, at);
    }
  }

  if (!divergence && index < rec.stamps.length) {
    divergence = `replay produced ${index} stamps, the recording has ${rec.stamps.length}`;
  }

  if (!divergence) {
    for (const want of rec.outcome) {
      const got = states.get(want.sessionId);
      if (!got) { divergence = `${want.sessionId} never appeared in the replay`; break; }
      for (const key of ["x", "y", "z", "progress", "checkpoint", "chain"] as const) {
        if (!Object.is(got[key], want[key])) {
          divergence = `${want.sessionId}.${key}: replayed ${got[key]}, recorded ${want[key]}`;
          break;
        }
      }
      if (divergence) { break; }
    }
  }

  return { ok: divergence === null, divergence, stamps: index, ticks: rec.ticks };
}

function retire(phase: WorldPhase, tick: number) {
  const crumbles = phase.crumbleTicks as number[];
  for (let i = 0; i < crumbles.length; i++) {
    if (crumbles[i] >= 0 && tick > crumbles[i] + CRUMBLE_DELAY_TICKS + CRUMBLE_GONE_TICKS) {
      crumbles[i] = -1;
    }
  }
  const until = phase.plateTicks as number[];
  const since = phase.plateSince as number[];
  for (let i = 0; i < until.length; i++) {
    if (until[i] >= 0 && tick > until[i]) { until[i] = -1; since[i] = -1; }
  }
}

export function freshState(spawn: { x: number; y: number; z: number }): SimState {
  return {
    x: spawn.x, y: spawn.y, z: spawn.z,
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
