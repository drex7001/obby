# Stage 11 — Mutators, modes, progression

**Risk** Low–Medium · Ships the same content, many times over.

Design context: [GDD §10](../GDD.md#10--variation-and-modes).

---

# 11.1 The mutator deck

Each round draws one or two modifiers, announced in the lobby during the
countdown. The display is already built — `Level.notes` carries a human-readable
list of what the round changed and the HUD already shows it.

Fourteen sections × a dozen mutators is a far larger space than fourteen sections.
The highest value-per-line item in the stage.

| Mutator | Effect |
| --- | --- |
| **Low gravity** | `GRAVITY` × 0.7 |
| **Rush hour** | All obstacle periods × 0.75 |
| **Sudden death** | No checkpoints; a fall ends your round |
| **Greasy** | `GROUND_FRICTION` halved |
| **Chain reaction** | The chain builds and breaks twice as fast |
| **No tether** | Verb disabled; the generator picks accordingly |
| **Fog** | Sightlines cut, telegraphs shortened |
| **Marathon** | 8 sections |
| **Sprint** | 4 sections, doubled series points |
| **Mirror** | Course generated with X negated |
| **Crowded** | Shove strength doubled |
| **One shot** | An influence charge each, for everyone including runners |

## The one technical trap — do this first

**A mutator that changes a constant the client reads from `constants.ts` will
desync**, because the client's copy is compiled in. Every tuning value a mutator
varies must move onto the `Level` (or a small synced mutator record) so both ends
read the same number from the same place.

That migration is the **first task of this stage, not the last.**

Mutators are drawn from the seed or synced as one small integer. **Never rolled at
runtime.**

- [ ] A mutator changes gameplay identically on client and server, verified by the
      stage-0 harness with each mutator active.
- [ ] No mutator makes a generated course incompletable — the bot sweep runs per
      mutator.
- [ ] Mutators are announced before the countdown ends, never after.
- [ ] A compatibility matrix prevents impossible combinations (Fog + Rush Hour).
- [ ] No tuning constant a mutator varies is still read from `constants.ts` by the
      client.

---

# 11.2 Modes

The same courses, different definitions of winning.

| Mode | Rules | Cost |
| --- | --- | --- |
| **Time attack** | Solo or ghost-only, no contact, best time wins | Nearly free after replays |
| **Collect** | Tokens placed beside hazards; hold N to finish | Pickup stamps + section content |
| **Survival** | A kill plane closes behind you; last runner standing | Class A, one parameter |
| **Hunt** | One runner starts ahead as the hare; catching them by proximity scores | Uses the existing shove/proximity code |
| **Relay** | 2v2, one runner active per team, tag at checkpoints | Teams in the schema, real match-flow work |

Build by cost: Time attack, Survival, Collect, Hunt, Relay.

**Collect is the most interesting** and worth prototyping before Relay. Tokens
placed beside hazards force a genuine risk/reward decision in every section, and a
player who is behind can choose to take more risk to catch up — a comeback
mechanic that costs nothing but content.

---

# 11.3 Cosmetic progression

Unlockable trails, colours, avatar shapes.

**Cosmetic only.** Anything that changes movement, speed or capability breaks the
fairness a race depends on. A new player must never be slower for being new.

**The real cost is infrastructure, not gameplay.** This is the first feature
needing persistence — a database, accounts, an auth story — in a project that
currently has none and deploys as a single Vite server. Treat it as an
infrastructure decision.

Do not start until the loop has proven itself. Unlocks extend a good loop; they
cannot rescue a bad one, and the effort is better spent on sections.

---

# 11.4 Arena — a design call, not a netcode project

If PvP shooting is still wanted, it belongs here as a **separate room type**, so
the race mode never inherits its balance problems.

**The technical objection is withdrawn.** The room tick *is* a common clock,
`tickBase` already maps each player onto it, and Colyseus ships lag compensation
(`allowRewindState` / `rewind.lastSeenBy`) with the client-side stamp already bound
to the interpolation buffer this project configures. It is days of work — the same
mechanism stage 9 uses for shooting enemies, pointed at players with
`mode: "snapshot"`.

**What remains is design.** In a race, the leader cannot look backwards while
running a hazard course, so a shot from behind has no counterplay. That is why it
is a separate mode rather than a race mechanic.

Three changes would make it viable inside the race itself, any one sufficient:

- **Forward-arc only** — you shoot who you chase, never who chases you. Symmetric,
  because everyone is chasing someone.
- **Tempo damage only** — a hit breaks a chain or bleeds overspeed. Never a stun,
  never a loss of control.
- **A visible lock warning** giving the target ~1 second to break line of sight or
  spend a coin on a shield.

Recorded in [decisions.md](../decisions.md) as D1 so the option stays open rather
than lost.

---

## Order

1. **Constants onto the level** — the migration, before anything else here.
2. Mutator deck.
3. Time attack.
4. Collect.
5. Survival, Hunt.
6. Relay.
7. Progression, only if the loop has proven itself.
8. Arena, only if PvP is still genuinely wanted.

---

## As built

The deck in [`mutators.ts`](../../src/shared/mutators.ts), the tuning it varies
in [`level.ts`](../../src/shared/level.ts), the structural half in
[`generator.ts`](../../src/shared/generator.ts), the modes in
[`RaceRoom.ts`](../../src/rooms/RaceRoom.ts), and the gates in
[`test/stages/variation.test.ts`](../../test/stages/variation.test.ts).

Order items 1-5 shipped: the migration, all twelve mutators, and four of the
five modes. Items 6-8 did not, each for its own stated reason.

### The migration was the first thing done, and it is enforced

`Tuning` is a record on the `Level` carrying gravity, ground friction, chain
decay, chain gain and shove strength, defaulted to the constants it shadows.
`stepPlayer()` reads it and nothing else - and a test greps `movement.ts` for
`GRAVITY`, `GROUND_FRICTION`, `CHAIN_DECAY_TICKS` and `PUSH_STRENGTH` and fails
if any of them reappears. That is the trap the spec warns about, closed by
something that cannot quietly rot.

### One deviation: the deck is published, not derived

The spec allows either ("drawn from the seed **or** synced as one small
integer"), and this takes the second. `buildLevel(seed)` stays the clean game
and keeps every guarantee stage 4 makes about it - seven sections, 280-340 u, no
self-intersection - and a mutated round is one the room drew, published on
`state.mutators`, and the client rebuilt from. Three reasons:

1. **A mode may want to force or forbid part of the deck.** Collect wants
   tokens; a future ranked mode might want none of it. Deriving from the seed
   makes that impossible without a second channel anyway.
2. **The stage-4 acceptance tests keep meaning what they meant.** They assert
   properties of a clean course, and a seed that silently drew Marathon would
   fail them for the right reason at the wrong time.
3. **One string on the wire is cheaper than two implementations of a draw
   rule** that have to stay identical forever.

A test builds the room's course from the published deck and asserts it matches
the room's own, byte for byte, because that is exactly what a client does.

### Mirror is applied to the finished level, on purpose

A reflection is an isometry with a sign flip, so *everything* angular has to
flip with it: yaw, `baseYaw`, a spinner's direction, a hinge's swept angles, a
pendulum's amplitude, a section's turn. Threading that through the emitters
would mean getting it right in a dozen places and in every section written
afterwards. Doing it once to the finished level is provably total, and the test
walks every solid and every obstacle asserting both the position and the
handedness flipped.

### The four modes, and the one that did not ship

| Mode | How it works |
| --- | --- |
| **Time attack** | The field is simply not there: `fillOthers` returns empty and landing contact is off, so there is no contact of any kind |
| **Collect** | The finish line does not open until you are carrying `COLLECT_TARGET`. Tokens are coin pods - the prop that already means "worth going out of your way for" - scattered off the centre-line so each is a real detour |
| **Survival** | One number. A kill plane advances as course progress from a fixed tick at a fixed rate, and anybody behind it is out |
| **Hunt** | The runner in front is the hare; proximity scores, with a cooldown so a catch is a catch and not a hold |

**Relay did not ship.** Two reasons, and the second is the real one. The spec
puts it last in its own build-by-cost order and calls it "real match-flow work".
And `Player` is at Colyseus' hard ceiling of 63 fields - adding one for a team
means trading one away, which is a deliberate decision about what the schema is
for rather than something a mode should quietly do on its way past. It is the
one item in the stage whose cost is structural rather than incidental.

### Progression and Arena were not started, as instructed

Progression is gated in its own section: "do not start until the loop has proven
itself", and its real cost is a database, accounts and an auth story in a
project that deploys as one Vite server. Arena is explicitly "a design call, not
a netcode project", and the design question it turns on - that a leader cannot
look behind while running a hazard course - is not one an implementation
answers. Both stay recorded rather than half-built.

### Where it stands against the acceptance list

Every item is covered except one. "No mutator makes a generated course
incompletable - the bot sweep runs per mutator" needs the bot to be good enough
for its completion rate to mean something, and at 44.5% it is not. What is
asserted instead, under every mutator in turn, is the set of structural
properties that make a course completable at all: enough sections, a bank per
join, checkpoints that advance along the centre-line, a finish past all of them,
and solid ground under every respawn point. When the bot reaches its bar, the
sweep is a one-line change away from covering the rest.
