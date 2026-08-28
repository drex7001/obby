# Stage 7 — The Tether

**Risk** Medium-High · Ships the aerial verb, behind a prototype gate.

Design context: [GDD §3.4](../GDD.md#34--tether--horizontal--stored--vertical).

*This replaces an earlier rigid-rope grapple design. A rigid rope is a physics
problem with one correct answer; an elastic tether that stores tension is a
**timing** problem shaped like Impact — one design language across the whole kit,
so the verbs teach each other.*

---

## The verb

Aimed at a placed **anchor**. Four beats: aim, attach, swing, release.

| Beat | Behaviour |
| --- | --- |
| **Aim** | Holding `action` highlights the best anchor in range and cone. Selection is deterministic: nearest to the aim ray within the cone, ties broken by anchor id |
| **Attach** | On the press edge, if an anchor is valid. Rope length = current distance. Costs `TETHER_CHAIN_COST` |
| **Swing** | The constraint holds you at or inside the rope length while **tension accumulates** through the arc |
| **Release** | On the release edge. What the stored tension converts to depends entirely on *when* |

### The release window — the whole mechanic

| Released | Converts to |
| --- | --- |
| Rising, before the arc bottom | **Height** — `vy += stored × TETHER_HEIGHT_RATE`. Reaches geometry nothing else does |
| **Within ±5 ticks of the arc bottom** | **Speed — +6 horizontal along the swing tangent, chain +1** |
| After the bottom | Nothing. The swing and its chain cost are wasted |

The arc bottom is detectable without ambiguity: it is the sub-step where the
radial component of velocity changes sign. Both ends compute it from the same
pure function, so the window is identical on both.

---

## Tension

Tension is what makes this a conversion rather than a ride.

```
tension += max(0, tangentialSpeed - TETHER_TENSION_FLOOR) * dt
tension  = min(tension, TETHER_TENSION_MAX)
```

It accumulates while swinging and is spent on release. Entering the swing fast
produces a big release; entering slow produces a small one. **A tether cannot
create speed you did not bring** — it can only convert and amplify it, which is
what keeps it from being strictly better than running.

## The constraint

Inside `subStep()`, after gravity and **before** the collision resolve, so the
constraint can never push a player into geometry — the resolve gets the last word.

```
if attached:
    d   = position - anchor
    len = |d|
    if len > ropeLength:
        n = d / len
        position = anchor + n * ropeLength      // positional correction
        vRadial  = dot(velocity, n)
        if vRadial > 0: velocity -= n * vRadial  // remove OUTWARD velocity only
```

A hard positional correction each sub-step, not a spring. Springs need tuning that
varies with `dt` and go subtly different under sub-stepping; a constraint is
stable and deterministic. Removing only *outward* radial velocity is what makes it
feel like a rope rather than a leash.

Elasticity lives in the *tension accumulator*, not in the constraint. The geometry
stays rigid; the payoff is stored. That separation is what keeps it deterministic.

---

## Netcode — Class A throughout

- **Anchor positions are level data**, rebuilt from the seed, never transmitted.
- **Targeting is `raycastWorld()`** (stage 0), a pure function of
  `(level, phase, tick, ray)`. Same anchor on first prediction, on every rollback
  replay, and on the server.
- **The constraint and the tension accumulator** resolve inside `stepPlayer()`.
- Nothing crosses the wire but the `action` bit and four small fields.

Fully predicted, fully reconciled. A tether is closer to a jump than to a
projectile.

### The one correctness trap

**Never store the anchor as a world point if it can move.** An anchor on a moving
obstacle must be stored as `(obstacleId, local offset)` and recomputed from
`poseAt()` every sub-step. Store a point and the two ends disagree about where the
rope ends the moment the obstacle moves — and it will look like a physics bug
rather than a netcode one, which is the worst kind.

**v1: static anchors only.** That removes the entire risk class. Moving anchors
are a later feature with an explicit design and their own determinism test.

---

## State

| Field | Type |
| --- | --- |
| `anchorId` | `int16` — anchor id + 1, 0 = detached |
| `ropeLen` | `number` |
| `tension` | `uint8` — quantised, safe by the `t.angle()` precedent |
| `tetherCool` | `int32` stamp |

All four in `SimState`, the schema **with defaults**, and `SIM_FIELDS`. Four
chances to trip the three-places rule.

## Level format

```ts
interface Anchor {
  id: number;
  x: number; y: number; z: number;
  obstacleId?: number;                    // v2: moving anchors
  ox?: number; oy?: number; oz?: number;
}
```

Rendered with a distinct silhouette and an in-range indicator — usable without
explanation.

## Constants

```
TETHER_RANGE          = 18      // ~1.5 s of running
TETHER_CONE           = 0.35    // rad; assist is fine, silent auto-aim is not
TETHER_MAX_TICKS      = 60      // hard cap; nobody hangs
TETHER_COOL_TICKS     = 45      // section-scale tool, not a traversal replacement
TETHER_CHAIN_COST     = 1
TETHER_MIN_LENGTH     = 2.5
TETHER_RELEASE_WINDOW = 5       // ticks either side of the arc bottom
TETHER_SPEED_GAIN     = 6.0
TETHER_HEIGHT_RATE    = 0.5
TETHER_TENSION_FLOOR  = 8.0
TETHER_TENSION_MAX    = 255
```

## Anchor placement

| Rule | Reason |
| --- | --- |
| Anchors are explicit, visible level content — never "tether anything" | Keeps targeting Class A, keeps designer control, keeps the mechanic legible |
| v1 static only | Removes the moving-anchor risk class entirely |
| An anchor's reward must be timed against a hazard | Otherwise the tether is strictly better than running and the course collapses |
| Max 4 per section | More reads as a playground, not a course |
| Every anchor line has a non-tether answer | Modes and mutators can disable the verb |

---

## Acceptance

- [ ] Anchor selection is deterministic: same aim ray and tick ⇒ same anchor, on
      both ends and on every replay.
- [ ] A full attach → swing → release replays bit-identically.
- [ ] The constraint never pushes a player inside geometry.
- [ ] Attaching at 13.4 u/s (chain 8) produces a stable swing with no oscillation
      at 3 sub-steps.
- [ ] The arc-bottom window is ±5 ticks and identical on both ends at 200 ms.
- [ ] A release outside the window grants nothing — no partial credit.
- [ ] Tension cannot be accumulated without tangential speed, so a stationary
      hang pays nothing.
- [ ] The cooldown cannot be bypassed by rapid re-press, including under rollback.
- [ ] With the tether disabled, every course in a 1000-seed sample is still
      completable.
- [ ] A badly timed swing leaves the player *slower* than running would have.
- [ ] `npm run smoke` performs an attach, a swing and a release.

## Risks

| Risk | Severity | Note |
| --- | --- | --- |
| **Feel** | High | Rope mechanics are hard to make good, and a bad one is worse than none. This is a prototyping-hours risk, not an engineering one |
| **Balance** | High | Four levers: anchor placement, cooldown, chain cost, and tension requiring speed you already had |
| Course collapse | Medium | Every tether line needs a non-tether answer |
| Camera | Medium | A swinging third-person camera needs its own work; the existing follow rig will fight it |
| Correctness | Low | Class A, static anchors, constraint before resolve. The determinism story is genuinely clean |

## The prototype gate

Build against **one hand-authored section**, played by real people, before placing
anchors across the pool.

**If it does not feel good after a focused effort, cut it.** The fallback is
explicit and good: the kit is already complete without it, and slipstream (stage
10) plus the Watchers (stage 9) are the replacement. Do not let this become a
feature that must succeed.

## Out of scope for v1

Moving anchors, tethering other players, tethering arbitrary surfaces, rope
collision against geometry. Each is a separate decision made after v1 is played.
