# Stage 0 — Foundations

**Risk** Low · Ships an identical game, now provable.

**Implementation status — implemented; acceptance validation ongoing.** The delivered safety net is covered by
[`foundations.test.ts`](../../test/stages/foundations.test.ts): seeded full-state
snapshot/replay fuzzing plus static and dynamic shared-raycast checks. The input
packet and sanitiser now carry `pitch`, `action`, `alt`, and `use` with safe
defaults. The reusable packet normalizer is
[`src/shared/input.ts`](../../src/shared/input.ts).

Four pieces of plumbing. Nothing is player-visible; if a change here shows up in a
race, it is a bug. Design context: [GDD](../GDD.md). Rules:
[engineering.md](../engineering.md).

---

## 0.1 Determinism fuzz harness

Turn the single rollback case in `test/sim.test.ts` into a property test over
**every** field of `SimState`, not just position.

```
for each of N seeded input streams:
    run forward T ticks, snapshotting every k ticks
    for each snapshot:
        restore, replay to T
        assert deep equality of the FULL SimState
```

Streams are generated from `mulberry32`, so a failure reproduces from one
integer.

**Why first.** Every stage after this adds simulated fields. The current test
asserts a trajectory; a new field can diverge without moving the body on the tick
you happen to sample, and that failure is invisible until a real match under
packet loss.

- [ ] Fails loudly if any `SimState` field diverges on replay.
- [ ] Covers respawn, stun, checkpoint banking, platform riding, hazard hits.
- [ ] Runs under 5 s so it stays in `npm test`.
- [ ] A failure prints the seed and the first diverging field.
- [ ] A deliberately introduced `Math.random()` in the step is caught.

## 0.2 Extended input packet

```
pitch  : t.angle()      // 2 bytes, wraps; the decoded value is what replays
action : t.boolean()    // primary   — tether / fire
alt    : t.boolean()    // secondary — carve / Impact
use    : t.boolean()    // context   — lever, pickup, plate
```

Settle the wire once so no later stage touches it.

**Three rules:**

1. **Held, not pressed.** Like `jump`, the wire carries held state and the step
   finds the edge. A "pressed" bit computed client-side cannot survive a rollback.
2. **Pitch becomes simulation input.** It is presentation-only today
   ([input.ts](../../src/client/input.ts#L26)). Move `PITCH_MIN`/`PITCH_MAX` into
   [constants.ts](../../src/shared/constants.ts) so both ends clamp identically.
3. **Coerce, don't clamp, in `sanitize`.** An omitted field decodes as
   `undefined`, and one `NaN` poisons a player's position for the rest of the
   match — the reason the existing sanitiser coerces every field.

Cost: +3 bytes/tick/player ≈ 90 B/s, taking the packet to ~9 of a 12-byte budget.

- [ ] A client sending no pitch is simulated at 0, not `NaN`.
- [ ] Pitch 50 is simulated at `PITCH_MAX` on both ends.
- [ ] The fuzz harness passes with the new fields exercised.

## 0.3 Tick-stamp convention

Generalise the proven `plateTicks` / `plateSince` pattern into per-player stamps.
Every timed mechanic from here — carve cooldown, tether hold, Recall lockout,
coin shield — is the same shape.

```
<name>Until : int32   // -1 when cold
<name>Since : int32   // paired only where a ramp needs a start
```

- Two stamps where a ramp is involved. One stamp restarts the ramp on every touch
  — the swing-bridge comment in `obstacles.ts` explains exactly why.
- `-1` when cold. **Never `0`** — tick 0 is a real tick.
- Compared against the player's **world tick** (`world.tickBase + ctx.tick`),
  never against `state.tick`.
- Simulated stamps go in all three places: `SimState`, the schema *with a
  default*, and `SIM_FIELDS`.

## 0.4 Shared world raycast

One deterministic ray query, in shared code, against the same geometry the
simulation collides with.

```ts
export interface RayHit {
  dist: number;                        // -1 on miss
  kind: "solid" | "obstacle" | "ramp" | "anchor" | "breaker";
  obstacleId: number;                  // 0 for statics
  x: number; y: number; z: number;     // world hit point
  nx: number; ny: number; nz: number;  // surface normal
}

export function raycastWorld(
  level: Level, phase: WorldPhase, tick: number,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxDist: number, out: RayHit,
): RayHit;
```

- Built on the existing [rayBoxDistance()](../../src/shared/collision.ts#L321),
  already a correct slab test and already used by the camera boom.
- Dynamic obstacles are tested at `poseAt(ob, tick, phase)` — **the same
  fractional tick the caller's sub-step is using**, or a replay disagrees.
- Broad-phase early-out modelled on `nearStatic()`, or this is O(solids) per call
  and it will be called several times per sub-step.
- Allocation-free: fills a caller-provided `out`, like `hazardHit`.
- **Never Babylon scene picking.** Two implementations of one geometry query is
  how the `hazardHit` mirror bug happened.

Consumers: tether targeting (stage 7), shooting (stage 6), bot hazard awareness
(stage 10), and eventually the camera boom, which should migrate onto it so there
is exactly one implementation.

- [ ] Given a mesh's own world matrix, a point on its surface hits and the
      mirrored point does not — the seam test that caught the original bug.
- [ ] Identical results at the same `(tick, ray)` across repeated calls and across
      a rollback replay.
- [ ] No allocation in the hot path.
