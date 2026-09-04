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
  /** Camera elevation. It is clamped in shared constants and replayed exactly. */
  pitch: t.angle().default(0),
  /** Held, not pressed - the step finds the edge so it replays identically. */
  jump: t.boolean().default(false),
  /** Primary future action: tether / fire. Kept on the wire from Stage 0. */
  action: t.boolean().default(false),
  /** Secondary future action: Impact / Carve. */
  alt: t.boolean().default(false),
  /** Context future action: lever, pickup, plate. */
  use: t.boolean().default(false),
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

  // ---- simulated: impact / chain -----------------------------------------
  chain: t.uint8().default(0),
  impactBuf: t.number().default(0),
  /** Current held state of the secondary action; edge detection lives in step. */
  heavyHeld: t.boolean().default(false),
  /** Heavy stays committed after the eight-tick hold completes. */
  heavyArmed: t.boolean().default(false),
  /** Start stamp of the current Heavy hold, or -1 when cold. */
  heavySince: t.int32().default(-1),
  /** The lander cannot be displaced through this world tick. */
  plantUntil: t.int32().default(-1),
  /** Next conversion-free tick at which one Chain point may decay. */
  chainDecayUntil: t.int32().default(-1),

  // ---- simulated: carve ---------------------------------------------------
  carving: t.boolean().default(false),
  /** Automatic carve exit stamp, or -1 when cold. */
  carveUntil: t.int32().default(-1),
  /** Re-entry lockout stamp, or -1 when cold. */
  carveCool: t.int32().default(-1),
  /** Ticks remaining after standing in which a carve hop can fire. */
  hopWindow: t.number().default(0),

  // ---- simulated: the salvo ----------------------------------------------
  /** Shots in the magazine. Class A: predicted and reconciled like position. */
  ammo: t.uint8().default(0),
  /** World tick the next shot is allowed, or -1 when cold. */
  fireCool: t.int32().default(-1),
  /** Held state of the primary action; the firing edge is found in the step. */
  actionHeld: t.boolean().default(false),
  /** Held state of the context action; the spending edge likewise. */
  useHeld: t.boolean().default(false),
  /** Slot+1 of the pickup being stood in, 0 for none. Stops re-collection. */
  pickupIn: t.uint8().default(0),
  /** Server-stamped coin spend, applied by the buyer's own deterministic step. */
  burnTick: t.int32().default(-1),
  burnAmount: t.uint8().default(0),
  /** World tick a bought Chain shield expires, or -1 when unarmed. */
  shieldUntil: t.int32().default(-1),

  // ---- simulated: the tether ----------------------------------------------
  /** Attached anchor id + 1, or 0 when detached. */
  anchorId: t.int16().default(0),
  /** Rope length, fixed at attach time. */
  ropeLen: t.number().default(0),
  /**
   * Swing tension banked so far.
   *
   * A full number, not the spec's quantised uint8. The accumulator integrates
   * per sub-step; rounding it into a byte on each one either loses the whole
   * gain or needs a scale so coarse the release stops being readable, and a
   * field the two ends can round differently is a desync, not a saving.
   */
  tension: t.number().default(0),
  /** World tick a new attach is allowed, or -1 when cold. */
  tetherCool: t.int32().default(-1),
  /** World tick the current swing is force-released, or -1 when detached. */
  tetherUntil: t.int32().default(-1),

  // ---- simulated: recall --------------------------------------------------
  /** Restores in hand: one per checkpoint segment, plus any bought with coins. */
  recallCharges: t.uint8().default(1),
  /** World tick the recall freeze ends, or -1 when not frozen. */
  recallUntil: t.int32().default(-1),
  /** Ticks the context action has been held, for the four-tick arm. */
  recallHeld: t.number().default(0),

  // ---- server-stamped, victim-simulated impulses -------------------------
  knockTick: t.int32().default(-1),
  knockX: t.number().default(0),
  knockY: t.number().default(0),
  knockZ: t.number().default(0),

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
  /**
   * Banked coins. Class D: server-owned, never predicted.
   *
   * The client may show an optimistic award and take the correction, because a
   * coin count that snaps is a cosmetic annoyance whereas a coin count the
   * client can decide is an exploit.
   */
  coins: t.uint8().default(0),
  /** Breakers this player has shot. Presentation and end-of-round interest. */
  breaks: t.uint16().default(0),

  // ---- the series ---------------------------------------------------------
  /** Points banked across the series so far. */
  seriesPoints: t.uint16().default(0),
  /**
   * Milliseconds from the start gate to each checkpoint, 0 for "not reached".
   *
   * Not predicted: a split is a fact about the past, and the one thing it must
   * never do is snap. See stage 10.2.
   */
  splits: t.array("uint32"),
  /** True for a bot. The client needs it only to mark the nameplate. */
  bot: t.boolean().default(false),
  /** Influence charges. One per race, spent only once finished or out. */
  influence: t.uint8().default(1),
  /** 1-based race position. 0 until the first ranking pass runs. */
  rank: t.uint8().default(0),
  finished: t.boolean().default(false),
  /** Finish time in ms from the start gate dropping. */
  finishMs: t.uint32().default(0),
  dnf: t.boolean().default(false),
  falls: t.uint16().default(0),
}, "Player");
export type Player = SchemaType<typeof Player>;

/**
 * One enemy, as a **committed arc** rather than a position.
 *
 * Publishing where something is going, instead of where it is, is what lets a
 * predicting client collide with it at ticks the server has not simulated yet -
 * and what lets a shot at one resolve with no lag compensation at all. The
 * fields below are exactly what `enemyPoseAt()` needs and nothing else.
 */
export const Enemy = schema({
  id: t.uint16().default(0),
  /** 0 Shambler, 1 Lurcher, 2 Bulwark. */
  kind: t.uint8().default(0),
  alive: t.boolean().default(true),
  hp: t.uint8().default(1),
  /** Tick a downed enemy is cleared away, or -1. */
  downUntil: t.int32().default(-1),
  /** 0 idle, 1 walk, 2 wind-up, 3 lunge, 4 recover. Presentation only. */
  action: t.uint8().default(0),

  /** The arc. Always published to take effect in the future - see threats.ts. */
  fromTick: t.int32().default(-1),
  toTick: t.int32().default(-1),
  x0: t.number().default(0),
  y0: t.number().default(0),
  z0: t.number().default(0),
  /** Initial heading, as a unit vector in the simulation's (sin, cos) frame. */
  dx: t.number().default(0),
  dz: t.number().default(1),
  speed: t.number().default(0),
  /** Turn rate along the arc, rad/s. An arc without control points. */
  turn: t.number().default(0),
}, "Enemy");
export type Enemy = SchemaType<typeof Enemy>;

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
  /** Per breaker slot: the tick it was shot, or -1. */
  breakerTicks: t.array("int32"),
  /** Per pickup slot: the tick it was last taken, or -1. */
  pickupTicks: t.array("int32"),
  /** Per shootable-shell slot: the tick a shell was shot out of the air. */
  shellTicks: t.array("int32"),
  /** Ticks a plate stays hot - lets clients reconstruct the swing-in ramp. */
  plateHoldTicks: t.int32().default(0),

  finishers: t.uint8().default(0),

  // ---- the series ---------------------------------------------------------
  /** 0-based round within the current series. */
  seriesRound: t.uint8().default(0),
  seriesLength: t.uint8().default(0),
  /** sessionId of the series winner, or "" while it is still live. */
  seriesWinner: t.string().default(""),

  // ---- variation ----------------------------------------------------------
  /**
   * This round's mutators, comma-separated.
   *
   * On the wire rather than derived from the seed, because a mode may force or
   * forbid part of the deck - and because one small string is a cheaper way to
   * agree than two implementations of the same draw rule.
   */
  mutators: t.string().default(""),
  /** @see RaceMode */
  mode: t.string().default("race"),
  /** Survival: the closing kill plane, as course progress. -1 when idle. */
  killLine: t.number().default(-1),
  /** Hunt: sessionId of the runner everybody else is chasing. */
  hare: t.string().default(""),
  /** Best time to each checkpoint this round, in ms. 0 until somebody gets there. */
  bestSplits: t.array("uint32"),
  /**
   * The same, from the previous round.
   *
   * A leader has nobody ahead of them to measure against, so they are measured
   * against the round before - and one array on the room says that as well as
   * one per player would, for a sixth of the fields. `Player` is within a
   * couple of entries of Colyseus' 63-field ceiling, and a split is a fact
   * about the course rather than about a person.
   */
  prevBestSplits: t.array("uint32"),

  /**
   * The live enemy field, keyed by enemy id. Capped at ENEMY_MAX.
   *
   * A map rather than an array, and not for taste: an `ArraySchema` of child
   * schemas shifts every index when an entry is removed, and a decoder that is
   * mid-patch when a nest's brood despawns drops a reference it still holds -
   * `trying to remove refId with 0 refCount` on a real client. Map keys never
   * shift, so an enemy leaving is one deletion and nothing else moves.
   */
  enemies: t.map(Enemy),

  players: t.map(Player),
}, "RaceState");
export type RaceState = SchemaType<typeof RaceState>;
