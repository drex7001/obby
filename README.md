# Gauntlet Run

A small 3D multiplayer obstacle race. Two to six runners spawn together in a
lobby, a countdown drops the start gate, and everyone races one course of
sweeping bars, moving platforms, collapsing stepping stones, swinging pendulums,
spinning discs, timed doors, turret fire and things that walk toward you. Fall
off and you respawn at your last checkpoint. First one through the finish gate
takes the round; then the course re-rolls and the next one starts, with a
different deck of modifiers on it.

Built on **Colyseus 0.18** for the multiplayer layer and **Babylon.js** for
rendering.

```bash
npm install
npm run dev          # client + server on one Vite server, http://localhost:5173
```

Open the page in two tabs (or on two machines — the dev server binds to the LAN)
and the match starts on its own. Alone, wait a few seconds and press `Enter` for
a solo practice run.

**Controls** — `WASD` move · `Space` jump (hold for height) · `Shift` Impact
while airborne / Carve while grounded · `F` tether to the anchor you are looking
at, or fire if there is none · `E` tap to burn your coins into speed, hold to
Recall · `1` buy a Chain shield · `2` buy a seal key · `3` buy a Recall · mouse
look · `R` respawn if you get stuck · click to capture the mouse.

`Esc` releases the mouse, and so does Alt+Tab. The race carries on without you,
so a prompt appears and clicking it takes control back — browsers refuse to
re-capture the pointer without a fresh gesture, and Chrome additionally ignores
the request for about a second after `Esc`, which the prompt retries through.
While the mouse is released you stand still rather than running blind.

| Command | What it does |
| --- | --- |
| `npm run dev` | Client and server together, with hot reload |
| `npm test` | Simulation, match-flow, rendering, rollback, and stage-mechanic suites |
| `npm run typecheck` | `tsc --noEmit` over everything |
| `npm run build` | Builds `dist/client` and `dist/server` |
| `npm run smoke` | Drives two real Chrome clients through a match |
| `npm run smoke:lock` | Checks pointer-lock recovery and the render clock |
| `npm run sweep` | Runs bots through generated courses headlessly and reports per-section completion |
| `npm run replay` | Records bot races, replays them, and fails on any divergence |

---

## How the multiplayer works

The short version: **the server is authoritative and simulates everything, the
client predicts its own runner, and the course is never sent over the network.**

### One step function, both ends of the wire

[`src/shared/movement.ts`](src/shared/movement.ts) holds `stepPlayer()` — the
entire character simulation, written as a pure function of `(state, input, world
tick)`. The server runs it once per input it receives. The client runs it the
moment you press a key, and Colyseus' reconciler replays every unacknowledged
input on top of server truth whenever a patch lands.

Because both ends run the same code over the same fixed timestep, local movement
has *no* latency while the server stays the only authority on where you actually
are. In practice the predicted and authoritative positions agree to within a
fraction of a millimetre.

### The course is a seed, not a payload

`state.seed` is one integer. [`buildLevel(seed)`](src/shared/generator.ts) turns
it into the whole course — which seven sections are drawn from the pool of
fourteen, which way each one bends, the geometry, the obstacle phases, and the
per-round variant inside each section (which way the bars sweep, whether the
pendulums move as a wave or a wall, how the collapsing stones are laid out).
Every client rebuilds it identically. Nothing about the level crosses the wire,
and a new round is a new integer.

The generator assembles sections at a **cursor** that carries a heading as well
as a position, so a course turns. A section is authored in its own local space —
+Z forward, entry gate at the origin — and bent onto an arc when it is placed,
which is why a section file contains course design and no coordinates that
depend on where it ends up.

### Moving obstacles, and why prediction can collide with them

This is the part that makes an obstacle course harder than a shooter. If the
client guesses where a moving platform is, prediction desynchronises the instant
you stand on one.

So every moving part is a **pure function of a world tick**
([`src/shared/obstacles.ts`](src/shared/obstacles.ts)). Give the server and a
rolling-back client the same tick and they compute the same geometry, exactly.
The handful of obstacles with genuine state — collapsing platforms, the pressure
plate, the start gate — are represented as *synchronised tick stamps* rather than
booleans, so both sides still derive their geometry from a pure function.

Each player's input sequence is mapped to that world tick through a `tickBase`
the server assigns from their first input and publishes. That mapping only has to
*agree* between the two ends, so ordinary latency needs no correction — but a
client that quietly sends slightly fewer than 30 inputs a second would walk its
own world-tick into the past, so the server smooths the observed offset and
corrects it a tick at a time.

### One rotation convention, checked across the seam

The renderer and the simulation each rotate a box by yaw, in separate code.
Babylon's `rotation.y` maps a box's local +Z to `(sin y, cos y)`; the collision
code's `toLocal`/`toWorld` map it to `(-sin y, cos y)`. Hence `meshYaw()` — one
negation, in one place.

That seam is exactly where a bug can hide in plain sight, because both sides
look self-consistent. `hazardHit` originally inverted with `cos(-yaw)` while
every solid inverted with `cos(yaw)` — the same formula at the opposite angle,
which put a push bar's hitbox at the *mirror image* of the bar being drawn. The
two coincided twice per revolution; the rest of the time an invisible
counter-sweeping bar knocked players over.

`test/course.test.ts` now closes that seam directly: it takes a point from a
mesh's own world matrix and asks the collider whether it is inside, then asks
the same of the mirrored point so a symmetric bug cannot pass.

### What is predicted and what is not

| | How it is handled |
| --- | --- |
| Your own runner | Predicted locally, reconciled against the server |
| Other runners | Interpolated from the server stream, never predicted |
| Obstacle motion | Derived on both ends from the shared world tick |
| Checkpoints, respawns | In the shared step, so they reconcile |
| Rank, finish times, match phase | Server only |

### Never trusting the wire

The client sends two axes, a camera yaw and two booleans — nothing else, and
certainly not a position. The room's `sanitize` **coerces** every field to a
finite value rather than merely clamping it, because a client that omits a field
decodes it as `undefined`, and a single `Math.hypot(undefined, 1)` inside the
step would turn a player's position into `NaN` for the rest of the match.

Checkpoints must be banked in order, and the finish only counts with every
checkpoint held, so no amount of clever routing skips a section.

---

## Layout

```
src/
  shared/          the simulation - imported unchanged by BOTH server and client
    movement.ts      stepPlayer(): the one deterministic step function
    collision.ts     kinematic capsule controller (no physics engine)
    obstacles.ts     obstacle kinematics as a function of world tick
    level.ts         the shapes a course is made of
    mutators.ts      the deck, and the numbers it is allowed to bend
    salvo.ts         shot resolution: a pure function of tick and aim
    tether.ts        anchor targeting, the swing constraint, the release
    recall.ts        the per-player history ring, indexed by world tick
    enemies.ts       committed arcs: an enemy publishes where it is going
    generator.ts     buildLevel(): picks seven sections and assembles them
    sections/        the pool of fourteen, one file per taught verb
    progress.ts      race position by arc length along the centre-line
  rooms/
    RaceRoom.ts      authoritative simulation + match flow
    threats.ts       the enemy field and the AI that commits its paths
    bot.ts           a bot is an object that fills an input channel
    sweep.ts         the headless harness: is this course actually completable?
    replay.ts        record a race as inputs, re-run it, prove it matches
    schema/          synchronised state and the input packet
  client/
    index.ts         prediction wiring and the render loop
    camera.ts        third-person follow rig
    render/          Babylon scene, course meshes, avatars, effects
```

`src/shared` is imported by both halves *as source*. There is no duplicated
physics and no "client version" of anything — that is what makes the determinism
contract enforceable rather than aspirational.

## The course

Seven sections drawn from a pool of fourteen, six checkpoints, 280–340 units end
to end and 60–110 seconds for a run that goes well. An easy opener, four middles,
a rest beat after the hardest run, and the Climb last, every time; which sections
fill those slots, and which way the course bends, is the seed's business.

| | Section | Teaches |
| --- | --- | --- |
| 1 | **The Gauntlet** — sweeping push bars low enough that carving is the fast answer, over a 26-wide track whose outer lane the arms never reach | Carve |
| 2 | **The Drift** — platforms sliding across a void, then five stepping stones that collapse a beat after you land | Impact |
| 3 | **Pendulum Pass** — a deck three metres wide with four swinging heads, and an anchor above each one | Tether |
| 4 | **The Carousel** — spinning platforms round a 90° corner, then scissoring walls that shove you off the landing pad | The jump |
| 5 | **The Works** — three timed doors, then a gap crossed by a bridge somebody has to hold a plate to swing out | Impact |
| 6 | **The Climb** — a ramp under sweeping hazards to the finish gate, the last one at carve height | The jump |
| 7 | **The Spiral** — an ascending helix round a column, 8 units up and 180° round | The jump |
| 8 | **The Sieve** — a forest of pistons on offset cycles, with no fixed safe line through it | Impact |
| 9 | **The Gallery** — a gun off the fast line, and weak points on the walls that hold the bar ahead inert for five seconds | Salvo |
| 10 | **The Chasm** — thirty units of nothing, three anchors, one clean line | Tether |
| 11 | **The Watchtower** — beams at carve height across the inside of a corner; the flank is safe and longer | Carve |
| 12 | **The Cascade** — a waterfall of collapsing platforms, the one section where falling on purpose is the fast line | Impact |
| 13 | **The Turnstile** — rotating panels with a gap you vault and a gap you carve, a quarter turn apart | Carve |
| 14 | **The Straightaway** — an open run and a narrowing. Every course needs one breath | — |

The Gallery and the Chasm are the only two that hard-require a verb, so they stay
out of the pool until the Salvo and the Tether ship. Everything else is
completable with every optional verb disabled.

Runners collide with each other and shove gently, enough to spoil a landing but
not enough to be the reason you lost.

## Shooting, and why it is generous

One gun on the course, four shots, no reload. Nothing is ever aimed at a person:
every shot goes into a **breaker**, a prop class kept deliberately separate from
the hazards themselves. A weak point holds its bar inert for five seconds, a
support drops a second plank across the Works' gap, a seal opens a catwalk past
the Sieve, a pod drops three coins and a crate gives two shots back.

Two properties fall out of that, and both are the point:

- **Shooting is generous.** You cannot clear a path only for yourself. Disabling
  a hazard helps whoever is in the section, including the runner right behind
  you, and a seal you open is a route you may not be able to defend. Deciding
  whether your pursuer benefits more than you do is the actual read.
- **Nothing is ever removed.** Every effect is a window or a route, never "the
  obstacle is gone", so the course a player with no gun runs is exactly the
  course everyone else does. Aiming already costs you your line — the camera is
  the movement frame — so a player at 19 u/s in a chain cannot afford to look
  sideways, and a player who just fumbled can.

Coins are stored energy, and the only thing worth doing with them is turning
them back into speed: **Burn** converts the purse to overspeed at half a unit per
coin, instantly. A Chain shield costs eight and absorbs one fumbled landing; a
seal key costs fifteen and opens the next locked route without spending a shot.
The purse caps at thirty, so hoarding is not a strategy — the question is always
"spend now on what?".

## The tether, and why it is a timing problem

Anchors are placed level content, drawn as glowing cubes that swell when your aim
is on one. Press `F` and the rope attaches at whatever distance you were at; it
hangs slack until it catches, and then holds you rigidly while **tension**
accumulates from the tangential speed you brought into the arc.

What you get back depends entirely on when you let go:

| Released | Converts to |
| --- | --- |
| Within five ticks either side of the arc bottom | **Speed** — six units along the swing tangent, and a Chain point |
| Climbing out of the arc | **Height** — the banked tension, at half a unit each |
| Anywhere else | Nothing at all |

Anchors hang six to eight units up — inside the camera's look-up range, which
matters more than it sounds: with the original range you physically could not
point at one, and the verb read as broken.

Attaching costs a Chain point up front, so a swing you mistime leaves you slower
than simply running would have. And tension only accumulates above a speed floor,
so a tether can amplify speed you already had but never invent any — which is
what stops it being strictly better than running.

## Recall, and the half of it people skip

Hold `E` and you are restored to where you were a second and a half ago —
position, velocity and footing. **The world does not rewind. Only you do.**

The platform you were standing on has moved on. The stone you were about to
touch has already collapsed. The runner who shoved you is somewhere else
entirely. A ghost shows you the destination while you arm it, and reading what
that place will look like when you arrive is the whole skill; without it Recall
would be a free undo.

It costs your entire Chain and two thirds of a second frozen, and you get one per
checkpoint segment. That freeze is not flavour: it is exactly the window the
server needs to confirm its own restore, so the correction lands while you are
standing still and can never snap. The design cost and the netcode requirement
turned out to be the same 0.66 seconds.

## The session, and the race within it

Rounds group into a **best of five**: 5/3/2/1 points, nothing for a DNF, and the
final round doubled. Losing one round stops meaning losing the session, and
somebody joining mid-series enters on the current last-place score rather than
zero. Banking a checkpoint stamps a **split** against the best time to it this
round — or against last round's best, if the best time is your own — and the HUD
names the runner immediately ahead and behind with the gap in seconds.

Running within twelve degrees and a couple of body-lengths behind somebody
**slipstreams** a Chain level off them every two seconds. Only the nearest
drafter benefits, so a pack cannot all draft one leader, and the cost is purely
positional: drafting means giving up route freedom. Once there are three runners
the Works' bridge plate becomes a *held* plate, so whoever opens it cannot cross
it. And a runner who has finished gets one charge to change a section for
everyone still out there — announced by name, over a second before anything
moves.

Bots fill a thin lobby once the solo timer has run, and they are a bot in name
only as far as the simulation is concerned: a bot is an object that fills an
input channel, presses the same nine fields a human does, and goes through the
same sanitiser. `npm run sweep` runs them headlessly across a thousand seeds and
reports which sections they cannot get through, which is how course
navigability stays an actual constraint rather than a hope.

## Mutators and modes

Each round draws one or two modifiers from a deck of twelve — low gravity, rush
hour, sudden death, greasy, chain reaction, no tether, fog, marathon, sprint,
mirror, crowded, one shot — announced in the lobby before the countdown ends. A
third of rounds run clean, because variety needs a baseline to vary from.

Two rules keep that safe, and both are structural. **Nothing is rolled at
runtime**: the deck comes out of the seed and is published on the room state, so
both ends build the same course from the same list. And **anything a mutator
varies lives on the `Level`** — gravity, friction, chain timing, shove strength
— because a value read from `constants.ts` exists twice, once on the server and
once compiled into the client, and changing one of them is a desync with no
symptom until somebody falls through the floor. A test greps the step for those
constant names and fails if any comes back.

The same courses also support four other definitions of winning: **time attack**
(no contact of any kind), **Collect** (the finish stays shut until you are
carrying enough tokens), **Survival** (a kill plane closes behind the field), and
**Hunt** (the runner in front is the hare, and proximity scores).

## Race position

Position is scored by arc length along the course's centre-line, floored by the
checkpoint you have banked — not by distance to the finish line. On a course that
turns and doubles back, straight-line distance ranks a player who has fallen into
the void below the finish ahead of one who is legitimately halfway. Falling costs
you the ground you had gained past your last checkpoint, so diving off a shortcut
can never bank a lead.

## Match flow

`waiting → countdown → racing → results → waiting`

The room fills to six and starts a five-second countdown as soon as two runners
are present. A race ends when everyone is home, 45 seconds after the first
finisher, or at the 210-second cap — whichever comes first; anyone still running
is a DNF. Standings show for twelve seconds, then the course re-rolls and the
next round begins. Finished runners keep control of their character and can watch
the rest of the field come in. Someone who joins mid-race runs unranked and is
folded into the field on the next round.

## Testing

`npm test` covers the simulation directly — platform riding, collapsing
platforms, the plate-driven bridge, checkpoint ordering, respawn behaviour,
hazard knockback, player shoving — plus match flow through a real Colyseus test
server, and the rollback determinism contract the netcode depends on.

`npm run smoke` drives two real Chrome clients through a match via the system
browser, which is what catches renderer exceptions and prediction drift.

`npm run replay` is the strongest check of the three. A race is completely
described by the seed, the input streams and the tick stamps, so it can be
re-run — and the replayer *regenerates* every stamp and asserts it matches what
was recorded. That turns determinism from something the code relies on into
something it proves; a regenerated stamp that disagrees has found a real bug,
and the first run of it did.

Two read-only debug handles are exposed on `window` for that harness:
`__gauntlet()` returns a state snapshot and `__ui` is the HUD. Both are local to
the tab and cannot influence the server.
