# Constitution

The rules a proposed mechanic has to survive before it earns a spec. Most are
already obeyed implicitly by the codebase; writing them down is what lets a new
feature be judged in five minutes instead of five days.

---

## Article I — The determinism contract

The contract already stated in [movement.ts](../src/shared/movement.ts), made
explicit as rules:

1. **`stepPlayer()` is a pure function of `(state, input, world tick, level,
   synced integers)`.** No clocks, no `Math.random()`, no ambient state, no
   renderer.
2. **Randomness enters the world exactly once**, through `mulberry32(seed)`
   inside [buildLevel()](../src/shared/level.ts). A mechanic that needs a random
   number at runtime needs redesigning — draw its numbers at build time and
   index them by tick.
3. **Anything the simulation reads lives in [src/shared/](../src/shared/).** A
   raycast used by the simulation may not use Babylon's scene picking; it uses
   [rayBoxDistance()](../src/shared/collision.ts#L321) against the same `Level`
   both ends built. Two implementations of one query is how the `hazardHit`
   mirror bug happened, and it is how the next one will.
4. **Every tuning number both ends read lives in
   [constants.ts](../src/shared/constants.ts).** A constant on one side only is
   a misprediction waiting to happen.
5. **Sub-step honesty.** Anything sampled inside a sub-step is sampled at the
   same fractional tick on both ends. `poseAt()` takes a fractional tick for
   exactly this reason; new queries must too.

### The number-one footgun

A new simulated field must be added in **three** places or it silently desyncs:

- the `SimState` interface in [movement.ts](../src/shared/movement.ts#L31),
- the `Player` schema in [RaceState.ts](../src/rooms/schema/RaceState.ts#L26),
  **with an explicit default**,
- the `SIM_FIELDS` array in [index.ts](../src/client/index.ts#L46).

Missing the third is the worst case: prediction works, reconciliation silently
does not, and the bug only surfaces under packet loss.

---

## Article II — Prediction-safety classes

Every entity or effect belongs to exactly one class. The class determines what it
is allowed to do to a player.

### Class A — Pure function of tick

Geometry derived from `(level, tick)` alone. Both ends compute it identically at
any tick, including during a rollback replay.

- **May:** hard-collide, carry, block, knock, be stood on, be raycast against.
- **Cost:** zero bytes on the wire.
- **Examples today:** every obstacle in [obstacles.ts](../src/shared/obstacles.ts).
- **Rule:** *aim here first.* Most things that feel like they need state do not.
  A turret firing on a fixed cycle is Class A. A creature patrolling a fixed
  path is Class A. A sweeping searchlight is Class A.

### Class B — Tick-stamped world state

A small set of synchronised integers that Class A functions read: `crumbleTicks`,
`plateTicks`, `plateSince`, `raceStartTick`. The geometry is still a pure
function; only the stamp crosses the wire.

- **May:** hard-collide — *provided* the change is telegraphed.
- **The telegraph rule:** a Class B geometry change must take **longer to
  complete than the worst-case round trip**. This is not decoration; it is why
  `HINGE_SWING_TICKS` is 27 (0.9s) and `CRUMBLE_DELAY_TICKS` is 17 (0.55s). A
  bridge that snapped into place in one tick would teleport into players on every
  client that heard about it late.
- **Cost:** one `int32` per stamp, sent only when it changes.
- **Rule:** every new timed mechanic — a pickup respawning, a buff expiring, a
  trap arming, a door shot open — is a tick stamp. Never a boolean.

### Class B+ — Pure function within a published horizon

An entity whose motion is server-decided but **published ahead of time as a short
parametric path**, so that within the published window both ends compute its pose
from a pure function of tick. See [specs/stage-9-threats.md](specs/stage-9-threats.md).

- **May:** everything Class A may — hard-collide, be stood on, be raycast
  against, be predicted through a rollback — *inside a received window*.
- **The lead rule:** a commit must always be published to take effect in the
  **future**, by more than a worst-case round trip (`COMMIT_LEAD` ≈ 15 ticks).
  Nobody ever evaluates a path they have not received.
- **The cost:** reactivity is capped at the lead time. An entity in this class
  cannot change its mind faster than half a second.
- **Cost on the wire:** one small record per entity, sent only on re-commit.
- **Why it exists:** it is the only class that gives *solid* and *reactive* at the
  same time without replacing the netcode architecture.
- **Not needed for hit resolution.** Colyseus 0.18 ships lag compensation
  (`allowRewindState` / `rewind.lastSeenBy`), so shooting a moving entity is a
  configuration concern, not an architectural one. B+ exists for the problem
  rewind does *not* solve: a predicted body colliding with something the server
  has not simulated yet. Rewind reconstructs the past; prediction needs the
  future. It is a bonus that a derivable position also needs no rewind at all.
- **Rule:** prefer Class A, then C. Reach for B+ **only** when an entity has to
  react to players *and* be something you can stand on or be blocked by. A
  knock-and-stun entity is Class C and far cheaper.

### Class C — Server-owned soft forces

Entities whose position is server-authoritative and client-*interpolated*, never
predicted. The predicted body reads their current interpolated position and may
be nudged by it.

- **May:** apply bounded impulses, knockback, stun — anything self-correcting.
- **May NOT:** be a surface. Never stood on, never blocked by, never a wall.
- **Why:** the client is reading a position ~90ms old (`REMOTE_INTERP_MS`) and
  never replays it on rollback. A soft impulse mispredicts by centimetres and
  heals; a hard collision mispredicts by metres and snaps.
- **Example today:** the player-shove pass in `subStep()` step 7 — the entire
  existing precedent for player-to-player interaction.
- **Rule:** a reactive enemy that only knocks and stuns lives here — it is the
  cheapest class that reacts. A design needing a Class C entity to hard-collide
  belongs in Class B+ instead.

### Class D — Server-only facts

`rank`, `finishMs`, `dnf`, `falls`, and everything scoring-shaped. Never in
`SIM_FIELDS`, never predicted.

- **May:** be shown optimistically in the HUD, provided the HUD accepts
  correction without a visible snap.
- **Rule:** kill credit, series points, ammo counts and unlock state are all
  Class D. Combat outcomes are Class D even when the *feel* of firing is Class A.

### The decision table

| A mechanic that... | is Class | verdict |
| --- | --- | --- |
| moves on a fixed schedule | A | free, build it |
| changes when someone triggers it | B | build it, telegraph over ≥27 ticks |
| must hard-collide *and* react to players | B+ | publish a committed path with ≥15 ticks of lead |
| chases a player, and only ever nudges | C | soft forces only |
| decides who won | D | server-only, never predicted |
| must hard-collide and react *instantly* | — | not available; nothing may react faster than the lead time |

---

## Article III — Budgets

| Budget | Ceiling | Today |
| --- | --- | --- |
| Input packet | 12 bytes | ~6 (`int8`, `int8`, `angle`, 2 × `bool`) |
| Per-player simulated fields | 24 bytes/tick on the wire | ~16 changing per tick |
| Room tick-stamp integers | 64 × `int32` per round | 5 crumble + 2 plate arrays |
| Class C entities per room | 12 | 6 (the players) |
| `buildLevel()` wall time | 4 ms | well under |

**Quantise freely.** The `t.angle()` precedent in
[RaceState.ts](../src/rooms/schema/RaceState.ts#L18) establishes that a lossy
field is safe for prediction *because the reconciler replays the decoded value*.
A `uint8` chain meter scaled 0–255 costs one byte and cannot desync.

---

## Article IV — Design rules

Enforced as strictly as the netcode half.

1. **Telegraph everything ≥ 1.2 s (36 ticks).** A player must be able to see a
   threat, decide, and act. A hazard survivable only by memory is a bug in a game
   whose courses re-roll every round.
2. **Interference costs the interferer.** Any mechanic that affects another
   runner must spend something measurable — time, momentum, position, or a
   consumable. No free sabotage.
3. **The leader must always be able to respond.** Being ahead is the reward for
   playing well; a mechanic that punishes it uncontestably makes playing well
   pointless.
4. **Never remove control for longer than `STUN_TICKS` (0.45 s).** The existing
   stun is the ceiling, not a starting point.
5. **A mistake must leave a recovery option.** This is why Carve and Recall come
   *before* any interference mechanic: falling has to be playable before anything
   is allowed to push you.
6. **Every verb must be usable in the first ten seconds of a first race.** No
   tutorial, no loadout screen, no combo notation.
7. **One new verb per stage.** The game earns its identity from a small number of
   deep verbs, not a large number of shallow ones.

---

## Article V — Definition of done

A mechanic is not finished until:

- [ ] Its fields exist in all three places (Article I footgun).
- [ ] The **rollback determinism** case in `test/sim.test.ts` covers the new
      fields — an identical trajectory on replay, including the new state.
- [ ] If it introduces a collider: a **mirrored-geometry test** in the style of
      `test/course.test.ts`'s "puts a hazard's hitbox exactly where its mesh is
      drawn", which asks the collider about a point *and its mirror* so a
      symmetric sign error cannot pass.
- [ ] If it introduces a Class B stamp: a test that a stamp arriving **late**
      produces a bounded correction, not a teleport.
- [ ] `npm run smoke` passes with two real clients.
- [ ] It has a HUD affordance a new player can read without being told.
- [ ] It fits the budgets in Article III.

---

