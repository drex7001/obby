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
