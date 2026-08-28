# Stage 2 — Impact and the Chain

**Risk** Low-Medium · Ships the vertical slice, and the decision point for the
whole design.

**Implementation status — implemented; acceptance validation ongoing.** Perfect, Neutral, Fumble, and committed
Heavy landings are predicted in the shared step; Heavy victims receive
server-authored stamped impulses, and Heavy-only plates and crumble floors
receive the same authoritative tick stamps. The associated Chain behavior is
covered in [`impact-chain.test.ts`](../../test/stages/impact-chain.test.ts). The
landing-feel gate remains a focused manual playtest.

Design context: [GDD §3.2](../GDD.md#32--impact--the-landing-and-the-metronome)
and [§2.4](../GDD.md#24--the-chain).

Build against **one hand-authored section**, two players. No course generation, no
series, no threats, no HUD polish.

---

## Impact

Resolved at the `body.grounded && !wasGrounded` transition in `subStep()`
section 5 — the branch that already exists and already fires the `land` effect.

| Outcome | Input | Keeps | Chain | Extra |
| --- | --- | --- | --- | --- |
| **Perfect** | `alt` tapped within ±4 ticks of touchdown | 100% | **+1** | +15% of impact speed, forward |
| **Neutral** | nothing | 85% | — | — |
| **Fumble** | `alt` tapped outside the window | 65% | **breaks** | — |
| **Heavy** | `alt` *held* through the last 8 ticks of descent | 0% | resets | Shockwave, heavy plates, fragile floors, planted 6 ticks |

**Never punish inaction.** Neutral is deliberately viable: a player who ignores
the mechanic is slower, never worse off than before the stage shipped. Only an
active mistake is punished. That is the line between a mechanic and a tax, and it
is also what makes this stage non-breaking.

### The window

```
perfect = |pressTick - touchdownTick| <= IMPACT_WINDOW
```

The press is buffered exactly as `jumpBuf` already is, so an early press stays
live across the remaining descent and the window is genuinely ±4 rather than
"4 ticks late only". That reuses a pattern already proven under rollback.

### Perfect conversion

```
forward = IMPACT_CONVERT * min(|vy|, MAX_FALL_SPEED)
v += facing * forward
```

Falling further pays more, so height becomes a resource and a big drop is an
opportunity. Capped by `MAX_FALL_SPEED` so a terminal-velocity plummet is not a
free rocket.

### Heavy

Held, not tapped — the same held/pressed distinction `jump` already uses.

```
radius = clamp(HEAVY_RADIUS_BASE + |vy| * HEAVY_RADIUS_SCALE, 2, 6)
```

At touchdown: horizontal velocity to zero; every runner within `radius` takes a
stamped impulse and a chain break; heavy plates within radius fire; fragile floors
within radius break (a Class B stamp, structurally identical to `crumbleTicks`);
the lander is unshoveable for `HEAVY_PLANT_TICKS`.

**Telegraph.** Armed for its whole 8-tick hold: the avatar compresses, a ground
decal grows to the true radius, audio winds up. Being above someone and falling is
the loudest warning the game can produce, which is why Heavy is allowed to be
strong.

---

## The Chain

```
softCap = BASE_SPEED * (1 + CHAIN_SPEED_PER * chain)     // chain 0..8 → +28%
```

| Builds | |
| --- | --- |
| Perfect Impact | +1 |
| Banking a checkpoint at chain ≥ 4 | +2 |
| *(Tether release, carve hop — later stages)* | +1 each |

| Breaks entirely | |
| --- | --- |
| Fumbled Impact, hazard hit, fall, Recall | ✓ |
| Contact from another runner during a landing window | ✓ |
| 3 s without a conversion | decays 1/s |

**It breaks rather than drains.** A meter that decays gently is a number you
watch; one that snaps is a thing you protect. The break has to be an event.

---

## Netcode

### The lander — Class A

Window, conversion, velocity dump and chain all resolve inside `stepPlayer()` from
state the step already has. Fully predicted, indistinguishable from jumping.

### The victims — stamped impulses

The shockwave affects *other* players, so it needs an answer to "who resolves
this?". Establish the pattern here, because every interference mechanic in stage
10 will want it:

> **The server decides who was hit. The hit is published as a stamped impulse on
> the victim's own state. The victim's step applies it deterministically.**

```ts
// on Player — server-written, victim-simulated
knockTick : t.int32().default(-1),   // -1 = none
knockX    : t.number().default(0),
knockY    : t.number().default(0),
knockZ    : t.number().default(0),
```

The victim applies the impulse on the tick matching `knockTick`, then clears it.
Because it is a stamp rather than a live force it **replays identically**, a late
stamp applies a few ticks late (reads as reaction lag, not a teleport), and both
ends derive the same impulse from the same integer.

**Do not** resolve the shockwave per-client from interpolated positions the way
the existing shove pass does. The shove is safe there because it is tiny and
continuous; a 7 u/s impulse computed independently on six clients from six
slightly different snapshots will disagree visibly.

| Piece | Class |
| --- | --- |
| Window, conversion, chain | A |
| Shockwave hit detection | D — server decides |
| Knock on the victim | B — stamped impulse |
| Heavy plate fired, fragile floor broken | B |

---

## State

| Field | Type | Where |
| --- | --- | --- |
| `chain` | `uint8` 0–8 | `SimState` + schema + `SIM_FIELDS` |
| `impactBuf` | `number` | ” — mirrors `jumpBuf` |
| `heavyHeld` | `boolean` | ” — edge detection |
| `plantUntil` | `int32` | ” — tick stamp |
| `knockTick`, `knockX/Y/Z` | stamps | `Player` only, server-written |

~4 bytes/tick/player, plus 16 on the rare tick a knock lands. All three places for
the simulated ones — this feature has four chances to trip that.

## Constants

```
IMPACT_WINDOW        = 4      // ticks either side of touchdown
IMPACT_BUFFER_TICKS  = 6
IMPACT_PERFECT_KEEP  = 1.00
IMPACT_NEUTRAL_KEEP  = 0.85
IMPACT_FUMBLE_KEEP   = 0.65
IMPACT_CONVERT       = 0.15
HEAVY_HOLD_TICKS     = 8
HEAVY_RADIUS_BASE    = 2
HEAVY_RADIUS_SCALE   = 0.15
HEAVY_RADIUS_MAX     = 6
HEAVY_KNOCK          = 7.0
HEAVY_PLANT_TICKS    = 6
CHAIN_MAX            = 8
CHAIN_SPEED_PER      = 0.035
CHAIN_DECAY_TICKS    = 90
```

---

## Presentation

The mechanic is 60% feel. Budget for it properly.

| Outcome | Cue |
| --- | --- |
| Perfect | Bright tick, forward camera kick, dust ring, chain counter pops |
| Neutral | Soft thud, small dust |
| Fumble | Dull crunch, camera dip, **the chain counter shatters audibly** |
| Heavy arming | Compression, a ground decal growing to the true radius, rising tone |
| Heavy landing | Crack, radial dust wave, shake scaled by radius |

The chain-break sound matters more than the rest combined. If a player cannot tell
they broke their chain without looking at the HUD, the mechanic does not exist.

---

## Acceptance

- [ ] A press at ±4 ticks is Perfect; at ±5 it is a Fumble.
- [ ] An early press buffered 6 ticks before touchdown still counts as Perfect.
- [ ] Doing nothing yields exactly 85% and never breaks the chain.
- [ ] Heavy dumps horizontal velocity to zero and cannot be cancelled once armed.
- [ ] Shockwave radius matches the rendered decal within 0.1 u, and passes a
      mirrored-geometry test.
- [ ] A knocked victim applies the impulse on the stamped tick identically under
      rollback, at 0 ms and 200 ms simulated latency.
- [ ] A knock stamp arriving 10 ticks late produces a late impulse, never a
      position correction.
- [ ] Chain 8 yields exactly `BASE_SPEED × 1.28`.
- [ ] Full `SimState` equality on replay with all four outcomes exercised.
- [ ] Heavy triggers a heavy plate; a Perfect landing on the same plate does not.
- [ ] The plant window is exactly 6 ticks and is not extendable by chaining
      Heavies.

## Risks

| Risk | Mitigation |
| --- | --- |
| **The window feels like homework** | Neutral at 85% is viable. If it still grates, widen to ±6 before changing anything else |
| Heavy is oppressive in a pack | It costs *all* your horizontal speed. Being right is expensive; being wrong is fatal to your run |
| Knocks feel laggy to the victim | They are, by exactly the round trip. Honest, and far better than a snap. The telegraph covers it |
| Rhythm fights obstacle timing | The open question of the design. Build the slice section *to* the rhythm and find out |

## The gate

**Is landing fun?**

If yes, everything downstream follows. If no, the thesis is wrong — and it is far
better to know that after one section than after twelve. Stages 4, 9, 10 and 11
are valuable either way; stages 3, 7 and 8 are not.
