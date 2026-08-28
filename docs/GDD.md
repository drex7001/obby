# Gauntlet Run — Game Design Document

---

# 1 · Identity

> **A momentum-based movement-mastery race.** Two to six runners, one line
> through a hostile course, and the whole game is how well you carry speed
> through it.

## 1.1 The core idea

**Energy conversion.** Speed is not a stat you have — it is energy you keep
moving between forms, and it leaks at every handoff you fumble.

You arrive at a gap carrying 14 units of speed. You can spend it upward (vault),
forward and low (carve), or store it (tether). Then you land — and the landing is
itself a conversion with a timing window. Nail it and you keep everything and
gain a little. Miss it and you eat the impact.

Every verb in the game is a converter with a window. The skill is chaining them.

## 1.2 The three pillars

| Pillar | The question it answers |
| --- | --- |
| **Momentum economy** | *How fast am I?* Speed above baseline is earned by clean conversion and spent on risk. |
| **Execution economy** | *How well did I run that?* One line, many ways to take it — which verb, which weight, spend or bank. |
| **Interference economy** | *Why do I care that you exist?* You can act on other runners, but only by committing something they can see. |

## 1.3 What the design is fixing

Four properties of the game as it stands today, and what replaces each.

| Today | Becomes |
| --- | --- |
| Top speed is a shared constant; acceleration reaches it in 0.1 s, friction stops you in 0.06 s. Stopping and turning are free, so movement has no state worth managing | Real momentum, a soft cap you can exceed, and a chain that raises it |
| One failure state: you fall, twice a race, expensive | Two: chain breaks (often, cheap, your fault) and falls (rare, expensive) |
| Six runners never meaningfully touch — the shove is deliberately too weak to matter | Contact breaks chains, which costs seconds |
| The course is six fixed rooms with jittered parameters; every round plays the same | A section registry with a real pool, assembled by seed |

## 1.4 The single-line rule

**The course does not branch.** One line through every section, for everyone.

This is a deliberate narrowing and it is what keeps the identity clean.
Route-choice games ask *which way*; this one asks *how well*. Decisions come from
execution, not navigation:

- Which verb clears this — vault, carve, or tether?
- Land light for speed, or heavy for power?
- Shoot the breaker, or run past it?
- Spend the coins now, or bank them for the climb?
- Commit to the fast line beside the hazard, or give it a metre?

That is five decisions per section on a single line, all of them about *how*.
It also removes a whole class of work: no route graph, no multi-branch progress
scoring, no per-branch validity testing. The existing centre-line progress model
stands unchanged.

## 1.5 What this game is not

- Not a shooter with obstacles. Shooting serves the run.
- Not a damage race. No player health; every hostile effect costs seconds.
- Not a maze. One line, mastered.

---

# 2 · The Player

## 2.1 The body

A kinematic capsule, no physics engine. Radius 0.42, height 1.72 (0.86 while
carving). Collision resolves against yaw-rotated boxes and ramps.

## 2.2 Momentum

The foundation everything else sits on. Today the character has none: it is
either stopped or at top speed, with nothing in between.

**Asymmetric acceleration.** Snappy from standstill, laborious near the cap:

```
accel = GROUND_ACCEL × (1 − ACCEL_FALLOFF × speed / softCap)
```

At rest you keep near-current responsiveness — vital in a course demanding fine
adjustments near hazards. At 90% of cap you are pushing against a wall, so the
last tenth of your speed must be *held*, not merely requested. That single curve
is what turns "press forward" into "protect your line".

**Lower friction.** Releasing input coasts about a metre instead of stopping
dead, which is what makes momentum legible — you can feel that you have
something.

**Directional speed.** Forward 1.00, strafe 0.82, backward 0.65. Camera control
becomes a skill, and the `yaw` field — already simulated, already on the wire —
gets a real job.

**Air and slope preservation.** A jump entered fast stays fast. Ramps apply the
gravity component along the slope, so downhill pays and uphill charges. The
Climb becomes a genuine climb.

## 2.3 The soft cap and overspeed

The keystone of the whole design.

```
softCap = BASE_SPEED × (1 + 0.035 × chain)     // what INPUT can reach
if (speed > softCap) speed −= OVERSPEED_DECAY   // decay, never clamp
```

Input accelerates you to the soft cap and no further. **External sources push you
above it, and you are never clamped back — you decay.**

Without this, every other speed mechanic in the game is silently deleted: a
perfect tether release, a downhill, a draft, a launch start would each produce
speed thrown away on the next tick. With it, they all pay into one currency.

**Overspeed is the resource the game is about.** You earn it by taking risk and
spend it before it bleeds.

| Overspeed source | Typical gain |
| --- | --- |
| Downhill slope | +1 to +3 while descending |
| Tether released at the arc bottom | +6, decaying |
| Perfect Impact | +15% of impact speed |
| Carve hop | +10% |
| Launch start | +2 for ~2 s |
| Slipstream | +0.8 while drafting |
| Burning coins | +0.5 each |
| A pusher wall taken from behind | +3 |

That last one is not designed — it falls out of removing the clamp. Existing
hazards become speed sources when taken correctly. Expect more of these to
emerge, and treat them as features.

## 2.4 The Chain

The meta-resource. Built by *executing conversions*, not by merely not stopping.

| Builds | |
| --- | --- |
| Perfect Impact | +1 |
| Tether released at the arc bottom | +1 |
| Carve hop | +1 |
| Banking a checkpoint at chain ≥ 4 | +2 |

| Breaks entirely | |
| --- | --- |
| Fumbled Impact | ✓ |
| Hazard hit, enemy hit | ✓ |
| Fall | ✓ |
| Recall | ✓ |
| Contact from another runner during a landing window | ✓ |
| 3 seconds without a conversion | decays 1/s |

Chain runs 0–8 and raises the soft cap by up to **+28%**.

**It breaks rather than drains.** A meter that decays gently is a number you
watch; one that snaps is a thing you protect. The break must be loud and audible
or nobody will feel it.

Chain is visible on other runners. That is not decoration — it is the targeting
information the multiplayer layer runs on.

## 2.5 Tuning

| Constant | Today | Design |
| --- | --- | --- |
| `SUB_STEPS` | 2 | **3** — headroom for 30 u/s, costs CPU only |
| `MAX_SPEED` | — | **30** — a collision limit, not a taste one |
| `BASE_SPEED` | 9.6 | **10.5** |
| `GROUND_ACCEL` | 92 | **34** on a falloff curve |
| `ACCEL_FALLOFF` | — | **0.6** |
| `GROUND_FRICTION` | 13 | **5.5** |
| `AIR_DRAG` | 0.35 | **0.18** |
| `AIR_ACCEL` | 34 | **38** |
| `GRAVITY` | 34 | **30** |
| `JUMP_SPEED` | 12.4 | **13.2** |
| `FALL_GRAVITY_MULT` | 1.35 | **1.5** |
| `OVERSPEED_DECAY` | — | **4.5 u/s²** |
| `IMPACT_WINDOW` | — | **±4 ticks** (133 ms) |
| `CHAIN_MAX` / per-level bonus | — | **8** / **0.035** |

**Protect the 0.8-second airtime.** Apex 2.9 u at 0.44 s up, 0.36 s down. That is
a landing beat every 0.8 seconds — about 75 BPM — and it sets the tempo of the
entire game. Every other constant is tuned around keeping it.

---

# 3 · Mechanics — the five verbs

Each converts between horizontal, vertical and stored energy. Each has a timing
window. Each has a defined failure.

## 3.1 Vault — horizontal → vertical

```
vy = JUMP_SPEED + speed × 0.12
```

Jump height scales with speed. At 20 u/s that is 2.4 units higher than at base —
enough to clear geometry a slow player cannot.

Speed stops being a lap-time statistic and becomes a **key**. Vertical geometry
is gated on arriving fast, which means the decision that cleared it was made
three seconds and two conversions earlier.

*Failure: none.* Vault is the safe verb. Every kit needs one.

## 3.2 Impact — the landing, and the metronome

The signature verb. Landing is currently free; here it is the most frequent skill
check in the game, roughly one every 0.8 seconds.

| Outcome | Input | Keeps | Chain | Extra |
| --- | --- | --- | --- | --- |
| **Perfect** | tap within ±4 ticks of touchdown | 100% | **+1** | +15% of impact speed forward |
| **Neutral** | nothing | 85% | — | — |
| **Fumble** | tap outside the window | 65% | **breaks** | — |
| **Heavy** | *hold* through the last 8 ticks of descent | 0% | resets | Shockwave; heavy plates; fragile floors; planted 6 ticks |

**Never punish inaction.** Neutral is deliberately viable — a player who ignores
the mechanic is slower, never worse off than today. Only an active mistake is
punished. That is the line between a mechanic and a tax.

**Heavy is where weight lives.** You do not *become* heavy; you *land* heavy.
Priced per action, so there is no persistent state to optimise — one loadout
decision per race becomes forty micro-decisions, each with a genuinely variable
answer that depends on what is under you and who is beside you.

Shockwave radius scales with fall speed, 2 u to 6 u. It knocks nearby runners,
breaks fragile floors, and triggers heavy plates. It is telegraphed for its whole
8-tick arming: the avatar compresses, a ground decal grows to the true radius,
audio winds up.

*Failure: a fumble costs a quarter of your speed and your chain.* The most common
way to lose a race, and entirely your fault — which is what makes it good.

## 3.3 Carve — horizontal → distance

Keep your speed, lose your steering, halve your height.

- Turn rate drops to ~25%. Carving is a **commitment**: you have chosen your line
  and cannot un-choose it.
- Passes under low hazards. Raising the Gauntlet's bar pivots to 0.95 makes that
  section teach the verb — a carving capsule fits, a running one does not.
- **Carve hop:** jump within 8 ticks of standing up for +10% speed and chain +1.
  The advanced tech — what a great player has that a good one has not found.
- Airborne it is a Dive: forward impulse, air control halved, lands into a carve.

*Failure: a carve into a wall dumps everything.*

## 3.4 Tether — horizontal ↔ stored ↔ vertical

Aimed at a placed **anchor**. Elastic, not rigid: the tether stores tension as
you swing, and release timing decides the conversion.

| Release | Converts to |
| --- | --- |
| Early, rising | Height |
| **Arc bottom** | **Speed — +6 horizontal, chain +1** |
| Late | Nothing. The swing and its chain cost are wasted |

A rigid rope is a physics problem with one correct answer. A storing tether is a
timing problem shaped like Impact — one design language across the whole kit, so
the verbs teach each other.

Priced by anchor placement, a cooldown, and a chain cost, so it is a section-scale
tool rather than a traversal replacement.

*Failure: a mistimed release leaves you slower than running.*

## 3.5 Recall — the recovery verb

Restore your position and velocity from 1.5 seconds ago.

**The world does not rewind. Only you do.** The platform has moved on, the stone
has crumbled, the runner who shoved you is elsewhere. Recall is a recovery *with
a read attached* — you have to know what the world will look like when you get
back there.

| | |
| --- | --- |
| Cost | Your entire chain, and 0.66 s frozen |
| Availability | Once per checkpoint segment |
| Restores | Position, velocity, grounded state |
| Does not restore | The world, the obstacles, other players, the clock |

The freeze is not flavour — it is the window the server needs to confirm the
authoritative snapshot, so the correction lands inside it and never snaps. The
design cost and the technical requirement are the same 0.66 seconds.

## 3.6 How they chain

```
vault ──► tether ──► release at arc bottom ──► dive ──► carve ──► hop ──► perfect Impact ──► vault
   +0        −chain            +6, +1           commit   +10%, +1      +15%, +1
```

The loop is the game. A great player is not making better individual decisions —
they are making the same decisions in an order that compounds.

---

# 4 · The Map

## 4.1 The rule: one line

**No branching. No alternate routes. No survivable fall layer.** One line through
every section, and one meaning to falling: you are out, freeze, respawn at your
checkpoint.

What this buys:

- The identity stays clean. This is a race about mastery, not navigation.
- Every runner is directly comparable at every moment — a real race, not parallel
  time trials.
- The progress model needs no change. The existing centre-line arc-length scoring
  stands.
- No route graph, no branch validity testing, no per-branch balance.

What replaces route choice: **execution choice** (§1.4). The line is fixed; how
you take it is not.

## 4.2 Audit of the map that exists

| Axis | Range |
| --- | --- |
| Z | −24.5 → 303.5 (328 u); race proper 0 → 289 |
| X | −13.5 → 13.5 |
| Y | 0 → 4.5 — the only elevation change is the final ramp |

Three things wrong with it:

**It never turns.** The progress path is nineteen points and every one has
`x: 0`. Three hundred units of straight line means the camera never reveals
anything and no section is ever seen from an angle that makes it look like a
place.

**Sections are addressed by hardcoded Z.** `[12, 24, 36].forEach(...)`,
`floor(0, 128, 3.6, 46)`. Sections cannot be reordered, resized, repeated or
omitted — which is the mechanical reason the "procedural" course is parameter
jitter over a fixed skeleton.

**No landmarks.** Nothing is visible from a distance, and the four checkpoint
pads are the same 16 × 10 rectangle. A player cannot say where they are except
by number.

What it gets right and must not lose: **width as difficulty** (22 u for the bars,
3.6 u for the pendulum bridge — the best pacing tool already in the map),
**checkpoint pads as punctuation**, and **escalation within a section** (bar
speeds 0.9 → 1.25 → 1.6; every section ramps).

## 4.3 Design language

**M1 — The course turns.** The build cursor becomes a position *and a heading*,
not a Z coordinate. Sections declare the turn they impose. This is the highest-
value map change available: it makes the course a place and gives the camera
something to reveal. Only `Ramp` needs a new field; every other primitive already
carries a yaw.

**M2 — Elevation is terrain, not a safety net.** Climbs, drops and vertical
sections are encouraged. A fall is still a fall.

**M3 — Every section states its verb.** A section is built around one of vault,
carve, tether or Impact, with the others available. That is what makes the pool
feel varied rather than reshuffled.

**M4 — Telegraph ≥ 36 ticks (1.2 s)** at the speed a player actually arrives.
At 20 u/s that is 24 units of clear sightline. A section that turns places its
first hazard at least that far past the turn.

**M5 — Every section has a landmark** tall enough to be seen from the previous
one. This is what makes a course read as a journey.

**M6 — Checkpoint pads are banks.** 16–24 u wide, flat, hazard-free for 6 u in
every direction, always at a section boundary, always the respawn point for what
follows. The rest beat in the pacing curve. Never two hard sections without one
between them.

**M7 — The line has width.** No branching does not mean a corridor one metre
wide. A 22-unit track with a hazard on one side is a *lane* choice inside one
line — that is execution, not navigation, and it is encouraged.

**M8 — Entry/exit contract.** Every section declares the width, elevation and
heading it starts and ends at. The generator may only place a section whose entry
matches the previous exit. This is what makes arbitrary ordering safe.

## 4.4 Composition and pacing

| Rule | Value |
| --- | --- |
| Sections per course | 6 (5 short, 8 long) |
| Section length | 36–60 u |
| Total race | 280–340 u |
| Checkpoints | one per section boundary |
| Target time | 70–110 s |
| No section repeats within a course | enforced |
| No two hard sections adjacent | enforced by difficulty tag |
| First section difficulty ≤ 2 | the field is still packed |
| Last section is a climb | a finish should be uphill and visible |

```
difficulty
 4 |                    ####          ####
 3 |           ####     ####    ####  ####
 2 |    ####   ####     ####    ####  ####
 1 | ####  ####  ####   ####    ####  ####
    ──────────────────────────────────────
      1     2     3       4       5     6
     easy  med   hard    rest    hard  climb
```

## 4.5 The six existing sections, revised

Each keeps its identity, gains a verb to teach, and loses nothing to the
single-line rule.

**1 · The Gauntlet** — three sweeping bars over a wide track. Raise the pivots
from 0.62 to 0.95 so a carving capsule passes under and a running one does not:
this is the section that teaches Carve. Widen to 26 u so the outer lane is a real
lane choice against a railless edge. *Landmark: a gantry arch over the third bar.*

**2 · The Drift** — sliders then crumble stones. The stones become a pure Impact
test: five landings in sequence, each one a window, chain +5 for a clean run.
*Landmark: lit slider rails extending past the play space.*

**3 · Pendulum Pass** — a 3.6 u deck with four swinging heads. Anchors on the
pivot housings make it the Tether section: swing the deck entirely, timed against
the heads. Keep the deck narrow; keep the void. *Landmark: the pivot gantry, the
tallest structure in the course.*

**4 · The Carousel** — three rotators then scissoring pushers. Rotators carry
momentum; take a pusher from behind and it pays you speed. *Landmark: a central
column through all three rotators.*

**5 · The Works** — *(was The Fork)*. The two parallel lanes become one lane in
sequence: timed doors, then a gap, then a plate-and-bridge segment. The plate
must be **held**, so in a field of three or more somebody arrives last by opening
it — the social moment survives the single-line rule intact. Solo and duo lobbies
get the old touch-and-hold behaviour so nobody is stuck. *Landmark: the swing
bridge, silhouetted.*

**6 · The Climb** — a ramp under sweepers to the finish. Genuinely uphill now, so
arriving with overspeed is worth seconds and the whole preceding section matters.
Raise the last sweeper so it is a carve rather than a vault, mixing verbs at the
climax. Widen the run-out so the field can watch the leader finish. *Landmark:
the finish gate, visible from three sections back.*

## 4.6 New sections

Difficulty 1–4; the verb each is built around.

| Section | Diff | Verb | Shape |
| --- | --- | --- | --- |
| **The Spiral** | 2 | Vault | An ascending helix wrapping a column, turning 180° while climbing 8 u. Cut the corners or follow the turn |
| **The Sieve** | 3 | Impact | A field of vertical pistons on offset cycles. No fixed safe path — the line you can take depends on the phase you arrive at |
| **The Gallery** | 2 | Salvo | A long straight with breakers on the walls. Shoot to clear the hazard ahead, or run it as it stands |
| **The Chasm** | 4 | Tether | A 30 u gap with three anchors and one clean line. Nothing catches you |
| **The Watchtower** | 3 | Carve | Sentries sweeping stun beams and a turret on a fixed cycle over an open approach |
| **The Cascade** | 3 | Impact | A descending waterfall of crumble platforms. Each drop is a landing window, and the drops pay overspeed |
| **The Turnstile** | 3 | Carve/Vault | Rotating walls with timed openings at two heights — one you run through, one you carve under |
| **The Straightaway** | 1 | — | 36 u of open run. Every course needs one breath, and it is where slipstream and the chain do their most visible work |

## 4.7 Readability

Not decoration — the difference between a hard course and an unfair one.

| Element | Rule |
| --- | --- |
| Hazard colour | One reserved hue, used for nothing else, ever |
| Solid vs hazard | Never ambiguous at 15 u. Driven automatically by the existing `role` field, never by hand |
| Moving vs static | Anything that moves gets an edge treatment static geometry never has |
| Breakers | A distinct silhouette, readable at range, unmistakable for a hazard |
| Landmarks | Lit from below, silhouetted against the sky, visible from ≥ 60 u |
| Checkpoint banks | One consistent look. A player must never wonder whether they banked |
| Section identity | Each section gets a palette accent. Six greys is why the current course has no sense of place |

---

# 5 · Shooting — the Salvo

## 5.1 The loop

```
run through a floating gun ──► 4 shots
        │
        ▼
shoot a breaker ahead ──► it clears, opens, or drops loot
        │
        ▼
    coins ──► stored energy
        │
        ▼
spend mid-race ──► speed, a shield, a Recall charge
        │
        └────────────────────► back into the chain
```

## 5.2 Why it belongs

**Coins are stored energy.** That is what makes shooting part of this game rather
than beside it. Every verb moves energy between forms; a coin is speed you banked
by spending tempo on a shot, held until you convert it back. Shooting is another
converter.

**Aiming already costs your line, for free.** Input is camera-relative, so turning
to look at a target turns your run. No firing penalty is needed — the control
scheme prices it automatically.

**It is a self-balancing rubber band.** A player at 19 u/s mid-chain cannot afford
to aim. A player who just fumbled can. Shooting becomes the recovering player's
tool and dodging stays the fast player's, with neither dominant.

## 5.3 The gun

Always the same weapon. **4 shots per pickup, no reload**, crates refill 2. The
pickup is placed on the line but off the *fast* line, so taking it costs tempo.
It respawns 20 s after being taken.

Ammo is bad as a tax and good as a resource: a finite magazine is what makes
"spend my last shot here, or save it for the seal ahead?" a real question.

Aim assist can be **generous** — a 4° cone — precisely because nothing is ever
aimed at a player. There is no fairness argument to have, so assist is pure
usability. Require *decision*, not precision.

## 5.4 Breakers

A distinct prop class, deliberately **not** the hazards themselves.

| Breaker | Effect |
| --- | --- |
| **Coin pod** | Drops 3 coins |
| **Weak point** | Disables one hazard for 5 s |
| **Support** | Collapses a gantry into a ramp |
| **Seal** | Opens a blocked segment for the round |
| **Crate** | Refills 2 shots |
| **Incoming projectile** | A turret shell, shot down mid-flight — a timing window, same language as Impact |

**Three rules stop shooting from deleting the obstacle course:**

1. Breakers are a separate prop class. A pendulum is not shootable; its housing
   might be.
2. Every effect is temporary or positional, never "the obstacle is gone."
3. **Every section must be completable with no gun at all** — enforced by the bot
   sweep across a large seed sample.

## 5.5 Shooting other runners

Not in the design. Not for technical reasons — the framework provides lag
compensation and it would be days of work — but because the leader cannot look
backwards while running a hazard course, so a shot from behind has no counterplay.

Three changes would make it viable, recorded in [decisions.md](decisions.md) so
the option stays open rather than lost.

---

# 6 · Threats

## 6.1 Obstacles

The existing eight kinds — spinners, sliders, pendulums, rotators, crumbles,
doors, hinges, the start gate — all pure functions of a world tick. They stay
exactly as they are, and every new hazard should try to be one of these before
being anything more expensive.

## 6.2 The Watchers

Threats that *read* as alive but are still pure functions of tick, so they cost
nothing on the wire.

| Watcher | Behaviour |
| --- | --- |
| **Turret** | Fires on a fixed cycle; the shell is a parabola you can dodge or shoot down |
| **Sentry** | Sweeps a stun beam on a fixed period — it slows rather than launches |
| **Jaws** | Two solids closing on a period; the classic timing gate |
| **Hunter** | A hazard on a fixed patrol with a searching animation |

Build these before enemies. Players do not experience "is this reactive?" — they
experience "is this dangerous and readable?". The Watchers may make enemies
unnecessary, and finding that out is cheap.

## 6.3 Enemies

Two tiers.

**Tier 1 — hazard enemies.** They chase, knock and stun, and are never a surface
you can stand on or be blocked by. A Shambler lurching into your line is 90% of
the fantasy for about twenty lines of netcode.

**Tier 2 — solid enemies.** Enemies you can be blocked by. The server publishes a
short committed path ahead of time so both ends can compute the creature's
position as a pure function — the future is *told*, not guessed. The half-second
lead this requires reads on screen as something heavy that telegraphs and follows
through, which is exactly what a good threat should do anyway.

**Three rules, and they are not negotiable:**

1. **They cost tempo, never HP-to-zero.** No enemy may stop a runner. The moment
   one can hold you until you kill it, the race is a damage race.
2. **They pressure space, not health.** An enemy occupies your line and moves
   toward it. That is the one thing no obstacle does — a spinner does not care
   where you are.
3. **They commit visibly.** Wind-up, commit, follow through, recover.

---

# 7 · Rewards and economy

## 7.1 Three currencies, one substance

Everything the player accumulates is **energy in a different form**, and each
converts into the others.

```
        ┌──────────────────────────────────────────┐
        │                                          │
   OVERSPEED ◄──── burn ──── COINS ◄──── shoot ────┤
        │                      ▲                   │
        │                      │                   │
        └──► raises ──► CHAIN ─┘ (chain ≥4 at a bank pays coins)
                         │
                         └──► raises the soft cap ──► overspeed
```

| Currency | Earned by | Lost by | Converts to |
| --- | --- | --- | --- |
| **Overspeed** | Every conversion, slopes, tethers, burning coins | Time (it decays), hits, falls | Distance — the only thing that actually wins races |
| **Chain** | Executing conversions cleanly | Any mistake, instantly | A higher soft cap |
| **Coins** | Shooting breakers, banking at high chain | Spending | Overspeed, shields, Recall charges |

That closed loop is the reward system. There is no separate score to chase and no
currency that only goes up.

## 7.2 Coin sinks

All in-race. A between-rounds sink needs persistence the project does not have,
and worse, it moves the decision out of the moment where it is interesting.

| Sink | Cost |
| --- | --- |
| **Burn** — convert to overspeed, +0.5 u/s each | any |
| **Chain shield** — absorbs one fumbled Impact | 8 |
| **Recall recharge** | 12 |
| **Seal key** — opens a blocked segment without shooting it | 15 |

Purse caps at 30 so hoarding is not a strategy, and the question is always
"spend on what?" rather than "save for when?".

**Build Burn first.** It closes the loop with one number and proves the currency
is fun before the rest exists.

## 7.3 Race scoring

Position is scored by arc length along the course centre-line, floored by the
checkpoint banked. Falling costs the ground gained past your last checkpoint, so
a mistake can never bank a lead. The finish counts only with every checkpoint
held.

Unchanged from today, and correct.

## 7.4 The series

Rounds group into a best-of-five with points: 5 / 3 / 2 / 1, DNF 0, **final round
double**.

This is the cheapest comeback mechanic available. Losing one round no longer
means losing the session, so a runner who fell at The Drift still has something
to play for. A player joining mid-series enters at the current last-place score
rather than zero.

## 7.5 Splits and rivals

Per-checkpoint split against the current leader (`−0.8 s at Pendulum Pass`), and
a marker naming the runner immediately ahead and behind with the gap in seconds.

Today a player in third has no idea whether they are one second or twenty behind,
so there is nothing to fight for. This is the whole fix.

## 7.6 Progression

Cosmetic only — trails, colours, avatar shapes. **Nothing that changes movement or
capability**, ever; a new player must never be slower for being new. It needs the
project's first persistence layer, so it waits until the loop has proven itself.

---

# 8 · Multiplayer

## 8.1 What each runner sees

Everyone runs the same course from the same seed. Your own runner responds
instantly; other runners are smoothed from the server stream. The course is never
transmitted — one integer describes it, and both ends build it identically.

## 8.2 Interference: you break chains, not players

No damage. No health. One idea:

> **The way to hurt another runner is to break their chain.**

| Tool | How | What it costs you |
| --- | --- | --- |
| **Heavy Impact shockwave** | Land heavy near someone mid-air or mid-landing and their window is gone | All your horizontal speed |
| **Body check** | Contact during their landing window fumbles it | Contact is symmetric — you lose speed too |
| **Draft steal** | Sit in their slipstream and siphon a chain level every 2 s | You must hold the line directly behind, giving up your own |
| **Contested plate** | The Works' bridge needs someone to hold the plate | Whoever opens it arrives last |

Every one costs the aggressor something measurable, is visible before it lands,
and never removes control. A Heavy Impact requires being *above* someone and
falling — the loudest telegraph the game can produce, which is why it is allowed
to be strong.

The moment this produces: two runners neck and neck at 18 u/s, one vaults, and
the other has half a second to decide whether to eat the shockwave or break their
own chain dodging it.

## 8.3 The leader breaks trail

A rubber band with no artificial speed boost in it.

The leader triggers everything first — crumble stones, plate timers, door cycles,
enemy commits, turret shots. Everyone behind gets to *watch* those fire and read
a section the leader had to guess at. Being in front is still better; it is just
not free.

Emergent, contestable, invisible as a system, and it costs nothing to build — it
already happens. It only needs the course designed so that the information is
worth having.

## 8.4 Finished runners

A player who has finished or is out gets a free camera and **one charge** to
influence the live course — drop a hazard, open a segment — announced loudly and
attributed by name.

Rules: it affects the *section*, never a chosen runner; one charge per race; ≥ 36
ticks of telegraph before anything moves; and it is locked out in the final ten
seconds so it cannot decide a photo finish.

This converts up to 57 seconds of dead time per cycle into the most social part
of the loop.

## 8.5 Bots

Server-side runners driven by an input stream, stepped by the same simulation as
everyone else — so they cannot cheat by construction and are subject to identical
physics. Difficulty is reaction delay and error rate, never special powers.

They solve the cold-start problem for a 2–6 player game, and they are the course
generator's test suite: a thousand seeds run headless, asking "is this course
actually completable?"

---

# 9 · Failure and recovery

Two failure states, and the new one is far more common.

| Failure | Frequency | Cost | Reads as |
| --- | --- | --- | --- |
| **Chain break** | Several times a race | 1–3 s, compounding | *You* made a mistake |
| **Fall** | Once or twice a race | 4–8 s | The course got you |

Most of the tension moves from *"will I fall?"* to *"will I keep the chain?"* —
continuous, playable and self-inflicted, where falling is binary, rare and
punitive.

**Recovery ladder**, cheapest first:

1. **Absorb it.** Neutral-land instead of fumbling. Costs 15% of your speed.
2. **Shield it.** 8 coins absorbs one fumble outright.
3. **Recall it.** Restore 1.5 s of position — but the world moved on.
4. **Respawn.** The checkpoint. Costs the ground you had gained past it.

Falling is fatal to the round's momentum, and that is deliberate: there is no
lower band, no safety net, and no free save. The recovery verbs are *skills*, not
cushions.

---

# 10 · Variation and modes

## 10.1 Section pool

The course is assembled from a registry by seed: pick six sections in a valid
order subject to the pacing rules, each rolling its own variant. Fourteen sections
in the pool, with structural variants rather than parameter jitter.

## 10.2 Mutators

Each round draws one or two, announced in the lobby. The display already exists —
the HUD reads the level's notes today.

Low gravity · Rush hour (all periods ×0.75) · Sudden death (no checkpoints) ·
Greasy (half friction) · Chain reaction (the chain builds and breaks twice as fast) ·
No tether · Fog · Marathon (8 sections) · Sprint (4 sections, double points) ·
Mirror · Crowded (double shove)

The one trap: a mutator that changes a constant the client reads directly will
desync. Any tuning value a mutator varies must move onto the level so both ends
read the same number from the same place.

## 10.3 Modes

| Mode | Rules |
| --- | --- |
| **Race** | The default. First home wins |
| **Time attack** | Solo against ghosts, no contact |
| **Collect** | Gather N tokens placed beside hazards, then finish — a risk/reward decision per section |
| **Survival** | The course closes behind you; last runner standing |
| **Hunt** | One runner starts ahead as the hare; catching them by proximity scores |

---

# 11 · Constraints that shape the design

The engineering rules are in [engineering.md](engineering.md). Four of them have
enough design consequence to state here:

**Anything that hard-collides must be predictable.** A moving platform works
because its position is a pure function of time. Anything that reacts to players
*and* blocks them must publish its intent half a second ahead — which is why
enemies telegraph, and why that reads as good design rather than a limitation.

**Anything that changes the world must be telegraphed longer than a round trip.**
A bridge takes 0.9 s to swing; a crumble stone shivers for 0.55 s before it goes.
Not decoration — it is what stops geometry teleporting into someone who heard
about it late. Every new triggered thing inherits this.

**The course is a seed, not a payload.** One integer describes the whole course.
That is what makes rounds cheap and variation free, and nothing may be added that
has to be transmitted instead of derived.

**Randomness happens once, at course build.** Nothing rolls dice at runtime. A
mechanic that wants a random number wants a number drawn from the seed and indexed
by time instead.

---

*Staged delivery plan: [stages.md](stages.md). Decision history:
[decisions.md](decisions.md). Implementation specs: [specs/](specs/).*
