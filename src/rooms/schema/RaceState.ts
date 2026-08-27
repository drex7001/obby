import { schema, t, type SchemaType } from "@colyseus/schema";

/**
 * One input frame. Flat primitives only - this is what `Room.defineInput()`
 * decodes and what the client's reconciler replays, so it has to be the *whole*
 * intent of a tick. Anything the shared step reads must be on here.
 *
 * No sequence number and no timestamp: the engine's input counter is the
 * sequence, and one input advances exactly one fixed step.
 */
export const RaceInput = schema({
  /** Strafe axis, camera-relative. */
  moveX: t.int8<-1 | 0 | 1>().default(0),
  /** Forward axis, camera-relative. */
  moveZ: t.int8<-1 | 0 | 1>().default(0),
  /** Camera yaw. `t.angle()` is two bytes and wraps, and the reconciler replays
   *  the *decoded* value, so the lossy round-trip cannot desync prediction. */
  yaw: t.angle().default(0),
  /** Held, not pressed - the step finds the edge so it replays identically. */
  jump: t.boolean().default(false),
  /** Voluntary "I am stuck" reset. */
  respawn: t.boolean().default(false),
}, "RaceInput");
export type RaceInput = SchemaType<typeof RaceInput>;

export const Player = schema({
  // ---- identity ----------------------------------------------------------
  name: t.string().default(""),
  /** Index into the client's palette. */
  colour: t.uint8().default(0),
  connected: t.boolean().default(true),
  /**
   * True once the server has consumed this player's first input. Doubles as the
   * "tickBase is meaningful" flag for both sides.
   */
  active: t.boolean().default(false),

  // ---- simulated: mirrored by the client's reconciler ---------------------
  //
  // Every one of these carries an explicit default. A builder field without one
  // initialises to `undefined`, and the simulation would take that straight in
  // as a NaN it can never recover from - a schema has to describe a *valid*
  // starting player, not an empty one.
  x: t.number().default(0), y: t.number().default(0), z: t.number().default(0),
  vx: t.number().default(0), vy: t.number().default(0), vz: t.number().default(0),
  yaw: t.number().default(0),
  grounded: t.boolean().default(true),
  groundId: t.uint16().default(0),
  coyote: t.number().default(0),
  jumpBuf: t.number().default(0),
  jumpHeld: t.boolean().default(false),
  stun: t.number().default(0),
  respawn: t.number().default(0),
  checkpoint: t.int8().default(-1),
  progress: t.number().default(0),

  // ---- server-owned: never predicted -------------------------------------
  /**
   * World tick this player's input seq 0 maps to. The server derives it from
   * the first input it consumes and publishes it so the client can index
   * obstacle motion by the exact tick the server will use for the same input.
   *
   * Legitimately negative on a room whose tick counter is younger than the
   * joining client's input stream, so `active` - not the sign of this - is what
   * says whether it has been assigned.
   */
  tickBase: t.int32().default(0),
  /** 1-based race position. 0 until the first ranking pass runs. */
  rank: t.uint8().default(0),
  finished: t.boolean().default(false),
  /** Finish time in ms from the start gate dropping. */
  finishMs: t.uint32().default(0),
  dnf: t.boolean().default(false),
  falls: t.uint16().default(0),
}, "Player");
export type Player = SchemaType<typeof Player>;

export type RacePhase = "waiting" | "countdown" | "racing" | "results";

export const RaceState = schema({
  /** @see RacePhase */
  phase: t.string().default("waiting"),
  /** Server fixed-step index. Every tick-valued field below is on this clock. */
  tick: t.int32().default(0),

  /** The only thing that describes the course. Clients rebuild it from this. */
  seed: t.int32().default(0),
  round: t.uint16().default(0),

  /** Tick the start gate drops, or -1 while unarmed. */
  raceStartTick: t.int32().default(-1),
  /** Tick the countdown ends (== raceStartTick once armed). */
  countdownEndTick: t.int32().default(-1),
  /** Hard deadline: anyone still running at this tick is a DNF. */
  raceDeadlineTick: t.int32().default(-1),
  /** Tick the results screen gives way to the next round. */
  resultsEndTick: t.int32().default(-1),
  /** Tick at which a lone player may start a solo practice run. */
  soloUnlockTick: t.int32().default(-1),

  /** Per crumble slot: the tick it was first stood on, or -1. */
  crumbleTicks: t.array("int32"),
  /** Per plate: the tick its hold expires, or -1 when cold. */
  plateTicks: t.array("int32"),
  /** Per plate: the tick it most recently switched on, or -1. */
  plateSince: t.array("int32"),
  /** Ticks a plate stays hot - lets clients reconstruct the swing-in ramp. */
  plateHoldTicks: t.int32().default(0),

  finishers: t.uint8().default(0),

  players: t.map(Player),
}, "RaceState");
export type RaceState = SchemaType<typeof RaceState>;
