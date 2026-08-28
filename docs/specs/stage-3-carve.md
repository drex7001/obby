# Stage 3 — Carve, air control, launch start

**Risk** Medium — the collision refactor · Ships the second verb.

Design context: [GDD §3.3](../GDD.md#33--carve--horizontal--distance).

---

## Carve

`alt` held while grounded and moving. Additive: Impact resolves identically
whether you arrived carving or not.

| Property | Value |
| --- | --- |
| Entry | grounded, horizontal speed ≥ 60% of soft cap |
| Capsule height | `PLAYER_HEIGHT × 0.5` (0.86) |
| Turn rate | ~25% of normal — the commitment |
| Friction | ~25% of `GROUND_FRICTION` |
| Exit | speed < 45% of soft cap, `alt` released, or 1.2 s |
| Cooldown | 0.4 s, tick stamp |
| **Carve hop** | jump within 8 ticks of standing up: **+10% speed, chain +1** |
| Dive (airborne) | forward impulse, air control halved, lands into a carve |

The carve hop is the advanced tech — what a great player has that a good one has
not found yet. Make it discoverable: the window is generous, the payoff audible.

### Against the course

- **The Gauntlet.** Raising the bar pivots from `py: 0.62` to **0.95** makes a
  carving capsule (0.86) fit and a running one not. This is the section that
  teaches the verb.
- **The Climb.** Sweepers at y 2.25 / 4.05 / 5.15 sit above head height on the
  ramp in places — carving does nothing there, correctly. Not every hazard needs
  two answers.
- **The Carousel.** Pushers are 3.2 tall from `py: 1.6`, base on the floor — no
  carve answer, correctly.

One section gains a second solution; the rest do not. That mix is already right.

### The risk, stated precisely

`PLAYER_HEIGHT` is a module constant read directly throughout
[collision.ts](../../src/shared/collision.ts) — at least lines 87, 153, 240, 303.
A variable-height capsule means:

1. Adding `height` to the `Body` interface.
2. Auditing **every** read site and threading the body's height through.
3. A **stand-up check** — cast upward on exit and stay carving if a ceiling is
   within the full height. Without it, un-carving inside a door pushes the player
   through the floor.
4. Re-checking `inVolume()`, which uses `PLAYER_HEIGHT` for checkpoint and finish
   triggers. A carving player must still bank a checkpoint.

The most delicate refactor in the plan. Do it with the stage-0 harness already
green.

## Air control scaling

`AIR_ACCEL` scales with chain: 38 at chain 0 to ~48 at chain 8. A fast player
should also be a precise one, or the reward for building chain is also a
punishment for having it.

## Launch start

Press jump within ±6 ticks of the start gate dropping and begin the race at
**chain 2**.

Evaluated against `raceStartTick` — already a synced stamp both ends agree on — on
the player's own world tick, so a player at 200 ms gets the same window as one at
20 ms. No penalty for missing it; an early jump already costs position.

This makes the countdown a skill moment and, more importantly, **teaches the chain
in the first second of a first race** without a tutorial.

---

## State

| Field | Type |
| --- | --- |
| `carving` | `boolean` |
| `carveUntil` | `int32` stamp |
| `carveCool` | `int32` stamp |
| `hopWindow` | `number` — ticks left to hop out |
| `height` | on `Body` only, never on the wire — derived from `carving` |

Four synced fields, ~8 bytes.

## Constants

```
CARVE_HEIGHT_SCALE  = 0.5
CARVE_ENTRY_SPEED   = 0.60    // fraction of soft cap
CARVE_EXIT_SPEED    = 0.45
CARVE_TURN_SCALE    = 0.25
CARVE_FRICTION      = 0.25    // fraction of GROUND_FRICTION
CARVE_MAX_TICKS     = 36
CARVE_COOL_TICKS    = 12
HOP_WINDOW_TICKS    = 8
HOP_SPEED_BONUS     = 0.10
LAUNCH_WINDOW       = 6
LAUNCH_CHAIN        = 2
```

## Acceptance

- [ ] A carving player passes under a raised push bar; a running one does not.
- [ ] **A capsule is never inside geometry** — carve into every low gap across a
      large seed sample and assert no overlap.
- [ ] Standing up under a ceiling keeps the player carving instead of ejecting
      them.
- [ ] A carving player still banks checkpoints and triggers plates.
- [ ] A hop 8 ticks after standing grants the bonus; 9 ticks does not.
- [ ] Carve state replays bit-identically, including across a sub-step boundary.
- [ ] Sub-stepping still prevents tunnelling at the reduced height — re-verify the
      `SUB_STEPS` reasoning in `constants.ts` for a 0.86 capsule.
- [ ] Air control at chain 0 is unchanged from stage 1.
- [ ] The launch window is symmetric and latency-independent.
- [ ] `npm run smoke` performs a carve and a carve hop.
