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

/**
 * Camera pitch limits, in radians. Negative is looking up.
 *
 * `PITCH_MIN` was -0.42 - twenty-four degrees - which is barely above the
 * horizon, and it made the tether unusable: every anchor in the Chasm sits at
 * thirty-eight to forty degrees above a runner standing at the lip, so the aim
 * ray could not be pointed at one at all. Attaching only worked because the
 * twenty-degree assist cone happened to stretch past the limit by six degrees,
 * which is not a mechanic, it is a coincidence.
 *
 * Fifty-four degrees is an ordinary third-person look-up range, and the course
 * is full of things worth looking up at: anchors, gantries, the Spiral, and
 * turret shells arriving overhead.
 */
export const PITCH_MIN = -0.95;
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

// ------------------------------------------------------------------ the course
/**
 * Timing the course shares with the room. These live here rather than beside
 * the geometry because the section builders need them and the level module is
 * the *type* module the sections compile against - a value import back into it
 * would close a cycle.
 */
/** Ticks between "someone stood on it" and "it drops". */
export const CRUMBLE_DELAY_TICKS = 17;   // ~0.55s
/** Ticks the gap stays open before the platform snaps back. */
export const CRUMBLE_GONE_TICKS = 135;   // ~4.5s
/** Seconds a pressure plate stays hot after the last player steps off it. */
export const PLATE_HOLD_SECONDS = 8;
/** The same hold, in ticks - what `Plate.holdTicks` is built from. */
export const PLATE_HOLD_TICKS = Math.round(PLATE_HOLD_SECONDS * TICK_RATE);

export const START_GATE_STYLE = "gate";

// ---------------------------------------------------------------- the salvo
/**
 * Shooting is a converter, not a second game.
 *
 * The numbers here are chosen so that aiming costs tempo and nothing else: a
 * generous cone, a big forgiving range, and a cooldown long enough that a
 * magazine cannot be emptied inside one Impact window.
 */
/** Shots a gun pickup grants, and the hard cap on carried ammo. */
export const AMMO_MAX = 4;
/** Shots a crate refills. */
export const CRATE_AMMO = 2;
/** Ticks between shots. Four shots take just over a second to spend. */
export const FIRE_COOL_TICKS = 8;
/** How far a shot carries. Past this the ray simply misses. */
export const SHOT_RANGE = 70;
/**
 * Aim assist half-angle, in radians (4 degrees).
 *
 * Generous on purpose: nothing here is ever aimed at a player, so assist is a
 * usability feature rather than a fairness argument. See stage 6, Risk 2.
 */
export const ASSIST_CONE = 4 * Math.PI / 180;
/** Height of the muzzle above the feet. */
export const SHOT_EYE = 1.45;

/** Ticks a `disable` breaker holds its hazard inert. Five seconds. */
export const BREAKER_DISABLE_TICKS = TICK_RATE * 5;
/** Ticks a `collapse` breaker takes to swing its slab into place. */
export const BREAKER_DROP_TICKS = 12;
/** Coins a pod drops. */
export const POD_COINS = 3;
/**
 * Two players hitting one pod inside this window both get paid.
 *
 * Anti-frustration beats strict arbitration when the stake is three coins:
 * "I hit it first" is the only fairness dispute this feature can generate, and
 * this dissolves it.
 */
export const POD_SHARE_TICKS = 5;
/** Hoarding is not a strategy. The decision is always "spend now on what?". */
export const COIN_MAX = 30;
/** Overspeed bought per coin burned. */
export const BURN_SPEED_PER = 0.5;
/** Coins for a Chain shield, and how long one stays armed. */
export const SHIELD_COST = 8;
export const SHIELD_TICKS = TICK_RATE * 20;
/** Coins for a seal key: opens a locked shortcut without spending a shot. */
export const SEAL_KEY_COST = 15;

/** How close a runner must be to sweep up a floating pickup. */
export const PICKUP_RADIUS = 1.7;
/** Ticks a taken pickup stays gone. Twenty seconds. */
export const PICKUP_RESPAWN_TICKS = TICK_RATE * 20;

// ---------------------------------------------------------------- the tether
/**
 * An elastic tether that stores tension, not a rigid rope.
 *
 * A rigid rope is a physics problem with one correct answer; a tether whose
 * payoff depends on *when* you let go is a timing problem shaped exactly like
 * Impact. One design language across the kit, so the verbs teach each other.
 */
/** Attach range. About a second and a half of running. */
export const TETHER_RANGE = 18;
/** Targeting half-angle, in radians. Assist is fine; silent auto-aim is not. */
export const TETHER_CONE = 0.35;
/** Hard cap on one swing. Nobody hangs. */
export const TETHER_MAX_TICKS = 60;
/** Re-attach lockout. A section-scale tool, not a replacement for running. */
export const TETHER_COOL_TICKS = 45;
/** Chain points attaching costs. The verb has to be able to punish. */
export const TETHER_CHAIN_COST = 1;
export const TETHER_MIN_LENGTH = 2.5;
/** Ticks either side of the arc bottom in which a release converts to speed. */
export const TETHER_RELEASE_WINDOW = 5;
export const TETHER_SPEED_GAIN = 6.0;
export const TETHER_HEIGHT_RATE = 0.5;
/**
 * Tangential speed below which a swing stores nothing.
 *
 * This is what stops a tether creating speed you did not bring: a stationary
 * hang pays exactly zero, however long you hold it.
 */
export const TETHER_TENSION_FLOOR = 8.0;
/**
 * Tension ceiling, in raw units of (u/s . s).
 *
 * The spec called this 255 because it planned to quantise tension into a uint8;
 * as built the field is a full number (see the stage-7 notes), so the ceiling
 * is a physical bound rather than a storage one. At 13 u/s tangential a swing
 * stores 5 a second, and the 2 s cap means a great swing is worth about 10.
 */
export const TETHER_TENSION_MAX = 24;
/** Height above the feet the rope is anchored to on the runner. */
export const TETHER_HAND = 1.2;

// ------------------------------------------------------------------- recall
/**
 * The recovery verb. The world does not rewind - only you do.
 *
 * The freeze is not flavour: it is the window the server needs to confirm its
 * own restore, so the correction lands while the player is standing still and
 * can never snap. The design cost and the technical requirement are the same
 * two thirds of a second.
 */
/** How far back a restore reaches. */
export const RECALL_TICKS = 45;
/** The freeze, which is also the confirmation window. 3x a 200 ms round trip. */
export const RECALL_FREEZE_TICKS = 20;
/** Ticks the context action is held before Recall fires. */
export const RECALL_ARM_TICKS = 4;
/** Ring size. Must exceed RECALL_TICKS, with room for a rollback replay. */
export const RECALL_HISTORY = 60;
/** No recall within this many ticks of running from the finish. */
export const RECALL_FINISH_LOCK = 20;
/** Charges a runner can hold. One per checkpoint segment, plus one bought. */
export const RECALL_MAX_CHARGES = 2;
/** Coins for a recall recharge - stage 6's third sink, now that it has one. */
export const RECALL_COST = 12;
/**
 * Distance from the finish inside which Recall is refused.
 *
 * The spec says "within 20 ticks of the finish", which cannot be evaluated
 * without knowing the future; twenty ticks of running is the same statement,
 * made about a distance the level already knows.
 */
export const RECALL_FINISH_GUARD = RUN_SPEED * RECALL_FINISH_LOCK / TICK_RATE;

// ---------------------------------------------------------------- watchers
/**
 * Watchers are new obstacle kinds that read as alive but are pure functions of
 * tick. They cost zero bytes on the wire and carry no netcode risk at all - the
 * only genuinely new work in the whole of part 1 is a projectile hitbox.
 */
/**
 * Ticks a turret shell is in the air before it is spent.
 *
 * 1.2 s, which is the readability floor every Watcher is held to: a runner at
 * chain-8 speed covers sixteen units in that time, so a shell launched now is
 * on screen for a whole approach before it matters.
 */
export const SHELL_FLIGHT_TICKS = 36;
/** Gravity on a shell. Lighter than a runner's, so the arc reads from further. */
export const SHELL_GRAVITY = 16;
/** A shell shot down stays down for the rest of its own firing cycle. */
export const SENTRY_STUN_TICKS = Math.round(TICK_RATE * 0.6);

// ---------------------------------------------------------------- enemies
/**
 * Enemies move on **committed paths**: the server publishes an arc that takes
 * effect `COMMIT_LEAD` ticks in the future, and both ends compute the pose from
 * it with the same pure function. Nobody ever evaluates a path they have not
 * received, and nothing about an enemy has to be remembered - which is what
 * lets a client predict its own body against one, and lets a shot resolve
 * without any lag compensation at all.
 */
/** Ticks between publishing a commit and it taking effect. Half a second. */
export const COMMIT_LEAD = 15;
/** Ticks one commit covers. Re-issued as it runs out. */
export const COMMIT_SPAN = 30;
/** Hard cap on live enemies in a room. The oldest goes when it is reached. */
export const ENEMY_MAX = 16;
/** Ticks a downed enemy stays down before it is cleared away. */
export const ENEMY_DOWN_TICKS = TICK_RATE * 6;
/** Knockback an enemy imparts. Below a hazard's, because there are more of them. */
export const ENEMY_KNOCK = 9;
/** How far behind the field an enemy may fall before it is despawned. */
export const ENEMY_LEASH = 90;

export const SHAMBLER_SPEED = 4.2;
export const LURCHER_WAKE_RADIUS = 15;
export const LURCHER_WINDUP_TICKS = 15;
export const LURCHER_LUNGE_SPEED = 17;
export const LURCHER_LUNGE_TICKS = 12;
export const LURCHER_RECOVER_TICKS = 24;
export const BULWARK_SPEED = 2.6;
/** Ticks a nest waits between broods. */
export const NEST_PERIOD_TICKS = TICK_RATE * 9;

// ------------------------------------------------------------------ series
/**
 * Rounds group into a best-of-five.
 *
 * The cheapest comeback mechanic available: losing one round stops meaning
 * losing the session, so a runner who fell at the Drift still has something to
 * play for. A mid-series joiner enters at the current last-place score rather
 * than zero, so nobody is mathematically eliminated by the time they arrive.
 */
export const SERIES_LENGTH = 5;
/** Points by finishing position. Anything past fourth, and any DNF, scores 0. */
export const SERIES_POINTS = [5, 3, 2, 1] as const;
/** The final round is worth double, which is what keeps a session alive. */
export const SERIES_FINAL_MULTIPLIER = 2;
/** A series also ends the moment somebody is out of reach. */
export const SERIES_TARGET = 15;

// ---------------------------------------------------------------- the field
/** Bots fill a thin lobby up to this, and never join a full one. */
export const BOT_FILL = [0, 3, 4, 4, 0, 0, 0] as const;

// ----------------------------------------------------------- interference
/**
 * Slipstream.
 *
 * Running close behind another runner siphons a Chain level from them. Class C
 * by construction: a soft, bounded, self-correcting effect computed from
 * positions the server already has. The cost is purely positional - drafting
 * means giving up route freedom, which is a real price in a currency the game
 * already has - and only the nearest drafter benefits, so a pack cannot stack.
 */
export const DRAFT_MIN = 1.5;
export const DRAFT_MAX = 5;
/** Half-angle of the draft cone behind a runner, in radians. 12 degrees. */
export const DRAFT_CONE = 0.21;
/** Ticks of clean drafting that move one Chain level. */
export const DRAFT_TICKS = TICK_RATE * 2;

/**
 * A contested plate is *held*, not touched.
 *
 * Whoever opens the Works' bridge cannot cross it, which turns the game's
 * oldest mechanic into a social problem. Under three connected runners it
 * reverts to the eight-second touch-and-hold, so a duo is never stuck.
 */
export const PLATE_CONTEST_MIN_PLAYERS = 3;
export const PLATE_CONTEST_TICKS = 12;

/**
 * Finished-runner influence.
 *
 * One charge, spent on a *section* rather than on a runner - that is what stops
 * it being griefing and what stops it being collusion - announced by name and
 * telegraphed well before anything moves.
 */
export const INFLUENCE_TELEGRAPH_TICKS = 36;
/** No influence this close to the end of the race. No deciding a photo finish. */
export const INFLUENCE_LOCKOUT_TICKS = TICK_RATE * 10;

// -------------------------------------------------------------------- modes
/**
 * The same courses, different definitions of winning.
 *
 * Every one of these is a rule about scoring or about who is still in, applied
 * in the room. None of them touches the shared step, which is why they can be
 * switched between rounds without any of the determinism story changing.
 */
export type RaceMode = "race" | "timeattack" | "collect" | "survival" | "hunt";
export const RACE_MODES: readonly RaceMode[] =
  ["race", "timeattack", "collect", "survival", "hunt"];

/** Tokens a runner must be holding to be allowed to finish, in Collect. */
export const COLLECT_TARGET = 12;
/** Extra pods the generator scatters when a course is built for Collect. */
export const COLLECT_TOKENS = 10;
/** How fast the kill plane closes, as a fraction of the course per second. */
export const SURVIVAL_CLOSE_RATE = 0.004;
/** Grace before it starts moving at all. */
export const SURVIVAL_GRACE_TICKS = TICK_RATE * 12;
/** How close counts as catching the hare. */
export const HUNT_CATCH_RADIUS = 2.4;
/** Ticks before the same hunter can score again. */
export const HUNT_COOL_TICKS = TICK_RATE * 5;

// ------------------------------------------------------------ player-vs-player
/** Players closer than the sum of their radii get pushed apart, gently. */
export const PUSH_STRENGTH = 26;
export const PUSH_MAX_SPEED = 5.5;

// ---------------------------------------------------------------- lag/interp
/** Render delay applied to remote players, in ms. Buys smooth interpolation. */
export const REMOTE_INTERP_MS = 90;
