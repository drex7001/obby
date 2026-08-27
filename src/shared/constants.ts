/**
 * Every number both halves of the simulation agree on.
 *
 * The server and the predicting client run the SAME `stepPlayer()` over the same
 * fixed `dt`, so any tuning value either side reads has to live here — a constant
 * that exists on only one side is a misprediction waiting to happen.
 */

/** Input/simulation rate in Hz. One input advances exactly one step. */
export const TICK_RATE = 30;

/**
 * Physics sub-steps per input tick: collision integrates at 60 Hz while only 30
 * inputs/sec cross the wire. Keeps the per-sub-step fall distance (~0.53u at
 * terminal velocity) well under the thinnest platform (1.0u) plus the player
 * radius, so nothing tunnels through a floor.
 */
export const SUB_STEPS = 2;

export const DT = 1 / TICK_RATE;

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;

// ---------------------------------------------------------------- match timing
/** Ticks of countdown once the room has enough players. */
export const COUNTDOWN_TICKS = TICK_RATE * 5;
/** Hard cap on a race. Anyone still running when this expires is DNF. */
export const RACE_LIMIT_TICKS = TICK_RATE * 210;
/** How long the standings stay up before the next round is armed. */
export const RESULTS_TICKS = TICK_RATE * 12;
/** Once someone finishes, everyone else gets at most this long to follow. */
export const FINISH_GRACE_TICKS = TICK_RATE * 45;
/** A lone player may start a solo practice run after waiting this long. */
export const SOLO_UNLOCK_TICKS = TICK_RATE * 8;

// --------------------------------------------------------------------- player
export const PLAYER_RADIUS = 0.42;
/** Total capsule height, feet to crown. */
export const PLAYER_HEIGHT = 1.72;
/** Distance from the capsule origin (at the feet) to the centre of each cap. */
export const CAPSULE_HALF_SEGMENT = PLAYER_HEIGHT / 2 - PLAYER_RADIUS;

export const RUN_SPEED = 9.6;
export const GROUND_ACCEL = 92;
export const AIR_ACCEL = 34;
export const GROUND_FRICTION = 13;
export const AIR_DRAG = 0.35;

export const GRAVITY = 34;
export const MAX_FALL_SPEED = 32;
export const JUMP_SPEED = 12.4;
/** Extra gravity while falling — makes the arc feel snappy rather than floaty. */
export const FALL_GRAVITY_MULT = 1.35;
/** Gravity multiplier applied when the jump key is released early (variable height). */
export const JUMP_CUT_MULT = 2.2;

/** Ticks of grace after walking off a ledge during which a jump still fires. */
export const COYOTE_TICKS = 5;
/** Ticks a jump press is remembered while airborne, so early presses still land. */
export const JUMP_BUFFER_TICKS = 6;

/** Anything below this Y has fallen out of the world. */
export const KILL_Y = -18;
/** Ticks a player spends "falling" before being placed back on their checkpoint. */
export const RESPAWN_TICKS = Math.round(TICK_RATE * 0.65);
/** Ticks of reduced control after a hazard hit, so knockback actually lands. */
export const STUN_TICKS = Math.round(TICK_RATE * 0.45);
/** Control authority retained while stunned. */
export const STUN_CONTROL = 0.18;

// ------------------------------------------------------------ player-vs-player
/** Players closer than the sum of their radii get pushed apart, gently. */
export const PUSH_STRENGTH = 26;
export const PUSH_MAX_SPEED = 5.5;

// ---------------------------------------------------------------- lag/interp
/** Render delay applied to remote players, in ms. Buys smooth interpolation. */
export const REMOTE_INTERP_MS = 90;
