# Stage 8 — Recall

**Risk** Medium · Ships the recovery verb, completing the kit.

Design context: [GDD §3.5](../GDD.md#35--recall--the-recovery-verb).

---

## The verb

Restore your position and velocity from 45 ticks (1.5 s) ago. **The world does not
rewind — only you do.**

| | |
| --- | --- |
| Input | `use`, held for 4 ticks so it cannot be fired by accident |
| Restores | position, velocity, grounded state, `groundId` |
| Does **not** restore | the world, obstacle poses, other players, the clock, your chain |
| Cost | the entire chain, and `RECALL_FREEZE_TICKS` frozen |
| Availability | once per checkpoint segment; recharges on banking a checkpoint |
| Blocked while | already frozen, respawning, or within 20 ticks of the finish |

The platform you were standing on has moved on. The crumble stone you were about
to touch has already collapsed. The runner who shoved you is elsewhere. Recall is
a recovery **with a read attached** — you have to know what the world will look
like when you get back there, which is what stops it being a free undo.

---

## Why it is cheap here

The simulation is deterministic and the server already steps every player from an
input stream. Everything Recall needs already exists:

| Needed | Where it is |
| --- | --- |
| Past states | A ring of `SimState`, ~60 bytes × 60 ticks ≈ **3.6 KB per player** |
| Client-side history | The reconciler already keeps an identical buffer for rollback |
| A confirmation window | The freeze — see below |

## The freeze is the netcode window

This is the part worth getting right, and it is where the design cost and the
technical requirement turn out to be the same 0.66 seconds.

1. The client presses. It **predicts** the restore from its own history and starts
   an anticipation animation — the character braces, the world dims, a ghost of
   the destination shows.
2. The server validates (charge available, not frozen, not near the finish) and
   restores from **its** ring, which is authoritative.
3. The correction arrives within the freeze. The player is not moving, so a
   position difference of a few centimetres is invisible.
4. The freeze ends and control returns at the authoritative position.

Without the freeze, a client whose predicted history differed from the server's —
possible after a misprediction — would snap visibly at the worst moment. With it,
the round trip is hidden inside an animation the design wanted anyway.

**Do not let the freeze fall below the worst-case round trip.** 20 ticks (0.66 s)
at 200 ms leaves a 3× margin.

---

## State

| Field | Type | Where |
| --- | --- | --- |
| `recallCharges` | `uint8` | `SimState` + schema + `SIM_FIELDS` |
| `recallUntil` | `int32` stamp | ” — the freeze |
| `recallHeld` | `number` | ” — the 4-tick arm |
| history ring | — | server-side only, outside the schema, like `crumbleTicks` |

The ring is never synced. The *result* of a restore is ordinary simulated state
that the reconciler already handles.

## Constants

```
RECALL_TICKS         = 45     // how far back
RECALL_FREEZE_TICKS  = 20     // 0.66 s — also the confirmation window
RECALL_ARM_TICKS     = 4      // held before it fires
RECALL_HISTORY       = 60     // ring size; must exceed RECALL_TICKS
RECALL_FINISH_LOCK   = 20     // no recall this close to the finish
```

## Presentation

- **Arming:** the world desaturates, a ghost appears at the destination, a rising
  reversed tone.
- **Firing:** a fast pull-back, motion trail along the path, the ghost snapping
  shut.
- **Landing:** control returns hard, and the chain counter is visibly **empty** —
  the player must feel what they spent.

The ghost is not decoration: it is how the player makes the read. It must show the
destination *and* be honest that the world around it will have moved.

---

## Acceptance

- [ ] A restore returns exactly the state from 45 ticks earlier, bit-identical
      under rollback replay at 0 ms and 200 ms simulated latency.
- [ ] The world is **not** restored — a platform that moved stays moved, a
      crumbled stone stays crumbled.
- [ ] Recalling onto a space now occupied by geometry resolves through the normal
      collision pass and never leaves the capsule inside a solid.
- [ ] Recalling into the void immediately begins a normal respawn — no special
      case.
- [ ] The chain is zero after a recall, always.
- [ ] A second recall in the same checkpoint segment is refused.
- [ ] The server's restore wins; a client that mispredicted corrects inside the
      freeze with no visible snap.
- [ ] A recall fired 10 ticks before the finish is refused.
- [ ] History is capped and never grows without bound across a long race.

## Risks

| Risk | Mitigation |
| --- | --- |
| **It trivialises falling** | The world does not rewind, it costs the whole chain, once per segment. If still too strong, make it once per race |
| Frustrating when the world moved | That is the mechanic. The ghost must make the read possible *before* firing, not after |
| A mispredicted restore snaps | The freeze covers the round trip by 3× |
| Ring memory across many rooms | 3.6 KB per player, capped; trivially bounded |

## Out of scope

Recalling other players, recalling the world, recalling further than 45 ticks,
and any charge economy beyond one per segment (coins can buy a recharge — that is
stage 6's sink, not this spec's).

---

## As built

The ring in [`recall.ts`](../../src/shared/recall.ts), the verb in
[`movement.ts`](../../src/shared/movement.ts), the per-player histories in
[`RaceRoom.ts`](../../src/rooms/RaceRoom.ts), the ghost in
[`course.ts`](../../src/client/render/course.ts), and the gates in
[`test/stages/recall.test.ts`](../../test/stages/recall.test.ts).

Everything in the acceptance list is covered, and the browser smoke run drives a
real restore end to end - it arms, freezes and lands with the charge spent.

### The ring is indexed by world tick, not by insertion

This is the one design decision worth writing down. An append-only queue is the
obvious shape and it is wrong here: a client that rolls back replays twenty
unacknowledged inputs, and a queue would happily append all twenty a second time
and remember twice as much past as actually happened. Slots keyed by
`tick % RECALL_HISTORY`, each remembering which tick it holds, make recording
**idempotent** - a replay rewrites its own slots with its own values and leaves
everything else alone. The tick check is also what stops a wrapped-around slot
being mistaken for a recent one.

Samples older than the replay window were written by the original prediction and
are never revisited, so a client that mispredicted has a slightly wrong memory
of where it was. That is exactly what the freeze is for.

### The step is split so the ring cannot get holes in it

`stepPlayer()` has half a dozen early returns - the respawn freeze, the recall
freeze itself, the voluntary reset, falling out of the world - and a history
with holes is one a restore silently refuses to use. So the exported
`stepPlayer` is now a two-line wrapper around `stepCore` that records the sample
on every path through it. The suite asserts both halves: that the ring is
continuous across a respawn, and that keeping one does not change the simulation
it is a history of.

### Three deviations

1. **The context action carries two verbs, split by hold length.** `use` was
   already Burn as of stage 6, and stage 8 wants it for Recall. A tap burns the
   purse on the release edge; a four-tick hold fires Recall. The hold was the
   spec's own guard against firing the recovery verb by accident, so using it as
   the discriminator costs nothing and leaves the stage-0 input packet exactly
   as stage 0 settled it. Burn moving from the press edge to the release edge
   delays it by at most three ticks.
2. **"Within 20 ticks of the finish" is enforced as a distance.** As written it
   cannot be evaluated without knowing the future. `RECALL_FINISH_GUARD` is
   twenty ticks of running - seven units - measured against the finish volume,
   which is the same statement made about something the level already knows.
3. **A restore does not zero velocity during the freeze.** What is restored is a
   *moment*, and a moment includes how fast the runner was going. Freezing
   position while keeping velocity is what makes "the platform you were standing
   on has moved on" resolve as an ordinary fall when control returns, rather
   than needing a special case.

### The coin recharge landed here rather than in stage 6

Stage 6's sink table lists a Recall recharge at 12 coins, and stage 6 could not
ship it because there was nothing to recharge. It is a `buy` message like the
other two, capped at `RECALL_MAX_CHARGES`, and it stacks on top of the charge a
checkpoint hands back rather than replacing it.
