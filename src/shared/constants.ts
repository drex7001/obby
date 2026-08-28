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
 * Physics sub-steps per input tick: collision integrates at 90 Hz while only 30
 * inputs/sec cross the wire. Keeps the per-sub-step fall distance (~0.53u at
 * terminal velocity) well under the thinnest platform (1.0u) plus the player
 * radius, so nothing tunnels through a floor.
 */
export const SUB_STEPS = 3;

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

/** Camera pitch is simulation input even though it is presentation-only today. */
export const PITCH_MIN = -0.42;
export const PITCH_MAX = 1.02;

/** The speed every player has before a Chain conversion raises their soft cap. */
export const RUN_SPEED = 10.5;
/** Collision-safe horizontal hard cap. Raising it past ~45 needs another sub-step. */
export const MAX_SPEED = 30;
export const GROUND_ACCEL = 34;
export const ACCEL_FALLOFF = 0.6;
export const AIR_ACCEL = 38;
/** Extra aerial acceleration at Chain 8; speed rewards should retain precision. */
export const CHAIN_AIR_ACCEL_BONUS = 10;
export const GROUND_FRICTION = 5.5;
export const AIR_DRAG = 0.18;
export const STRAFE_SCALE = 0.82;
export const BACK_SCALE = 0.65;
export const SLOPE_ACCEL_SCALE = 0.55;
export const OVERSPEED_DECAY = 4.5;

export const GRAVITY = 30;
export const MAX_FALL_SPEED = 32;
export const JUMP_SPEED = 13.2;
/** Extra gravity while falling — makes the arc feel snappy rather than floaty. */
export const FALL_GRAVITY_MULT = 1.5;
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

// -------------------------------------------------------------- impact/chain
export const IMPACT_WINDOW = 4;
export const IMPACT_BUFFER_TICKS = 6;
export const IMPACT_PERFECT_KEEP = 1;
export const IMPACT_NEUTRAL_KEEP = 0.85;
export const IMPACT_FUMBLE_KEEP = 0.65;
export const IMPACT_CONVERT = 0.15;
export const HEAVY_HOLD_TICKS = 8;
export const HEAVY_RADIUS_BASE = 2;
export const HEAVY_RADIUS_SCALE = 0.15;
export const HEAVY_RADIUS_MAX = 6;
export const HEAVY_KNOCK = 7;
export const HEAVY_PLANT_TICKS = 6;
export const CHAIN_MAX = 8;
export const CHAIN_SPEED_PER = 0.035;
export const CHAIN_DECAY_TICKS = 90;

// --------------------------------------------------------------------- carve
export const CARVE_HEIGHT_SCALE = 0.5;
export const CARVE_ENTRY_SPEED = 0.60;
export const CARVE_EXIT_SPEED = 0.45;
export const CARVE_TURN_SCALE = 0.25;
export const CARVE_FRICTION = 0.25;
export const CARVE_MAX_TICKS = 36;
export const CARVE_COOL_TICKS = 12;
export const HOP_WINDOW_TICKS = 8;
export const HOP_SPEED_BONUS = 0.10;
export const LAUNCH_WINDOW = 6;
export const LAUNCH_CHAIN = 2;

// ------------------------------------------------------------ player-vs-player
/** Players closer than the sum of their radii get pushed apart, gently. */
export const PUSH_STRENGTH = 26;
export const PUSH_MAX_SPEED = 5.5;

// ---------------------------------------------------------------- lag/interp
/** Render delay applied to remote players, in ms. Buys smooth interpolation. */
export const REMOTE_INTERP_MS = 90;
