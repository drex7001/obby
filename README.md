# Gauntlet Run

A small 3D multiplayer obstacle race. Two to six runners spawn together in a
lobby, a countdown drops the start gate, and everyone races one course of
sweeping bars, moving platforms, collapsing stepping stones, swinging pendulums,
spinning discs, timed doors and a plate-operated swing bridge. Fall off and you
respawn at your last checkpoint. First one through the finish gate takes the
round; then the course re-rolls and the next one starts.

Built on **Colyseus 0.18** for the multiplayer layer and **Babylon.js** for
rendering.

```bash
npm install
npm run dev          # client + server on one Vite server, http://localhost:5173
```

Open the page in two tabs (or on two machines — the dev server binds to the LAN)
and the match starts on its own. Alone, wait a few seconds and press `Enter` for
a solo practice run.

**Controls** — `WASD` move · `Space` jump (hold for height) · mouse look ·
`R` respawn if you get stuck · click to capture the pointer.

| Command | What it does |
| --- | --- |
| `npm run dev` | Client and server together, with hot reload |
| `npm test` | 31 tests: simulation, match flow, determinism |
| `npm run typecheck` | `tsc --noEmit` over everything |
| `npm run build` | Builds `dist/client` and `dist/server` |
| `npm run smoke` | Drives two real Chrome clients through a match |

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

`state.seed` is one integer. [`buildLevel(seed)`](src/shared/level.ts) turns it
into the whole course — geometry, obstacle phases, and the per-round variant
(which way the bars sweep, whether the pendulums move as a wave or a wall, how
the collapsing stones are laid out, whether the swing-bridge shortcut is armed at
all). Every client rebuilds it identically. Nothing about the level crosses the
wire, and a new round is a new integer.

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
    level.ts         the course, built from a seed
    progress.ts      race position by arc length along the centre-line
  rooms/
    RaceRoom.ts      authoritative simulation + match flow
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

Six sections, four checkpoints, about 300 units end to end and 60–110 seconds for
a run that goes well.

1. **The Gauntlet** — three sweeping push bars over an open track. Jump them.
2. **The Drift** — two platforms sliding across a void, then five stepping
   stones that collapse under you a beat after you land.
3. **Pendulum Pass** — a bridge three metres wide with four swinging heads.
4. **The Carousel** — three spinning platforms with shifting gaps, then a pair of
   scissoring walls that shove you off the landing pad.
5. **The Fork** — two routes. Left runs three doors on a timed cycle; right needs
   somebody to hit a pressure plate, which swings a bridge across a gap for eight
   seconds — for everyone, including whoever is chasing you.
6. **The Climb** — a ramp under sweeping hazards up to the finish gate.

Runners collide with each other and shove gently, enough to spoil a landing but
not enough to be the reason you lost.

## Race position

Position is scored by arc length along the course's centre-line, floored by the
checkpoint you have banked — not by distance to the finish line. On a course that
forks and doubles back, straight-line distance ranks a player who has fallen into
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

Two read-only debug handles are exposed on `window` for that harness:
`__gauntlet()` returns a state snapshot and `__ui` is the HUD. Both are local to
the tab and cannot influence the server.
