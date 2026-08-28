# Decision log

**Not part of the GDD.** The design documents describe what we are building; this
file records what was considered and settled, so a closed question stays closed
and a reversal is visible as a reversal.

One line per decision. Detail only where the reasoning is load-bearing or where
something would change the verdict.

| # | Decision | Verdict | Date |
| --- | --- | --- | --- |
| D1 | Shooting other runners | Not adopted — design | 2026-08-28 |
| D2 | Shooting the world (pickups, breakers, coins) | **Adopted** — The Salvo, stage 6 | 2026-08-28 |
| D3 | Reactive AI enemies | **Adopted** — reversed from an earlier no | 2026-08-28 |
| D4 | Knife/gun speed swapping | Replaced by per-action weight | 2026-08-28 |
| D5 | Dash/Tank persistent stances | Replaced by per-action weight | 2026-08-28 |
| D6 | Health bars / damage numbers on players | Not adopted | 2026-08-28 |
| D7 | Ammo as a limiter | **Adopted** — reversed from an earlier no | 2026-08-28 |
| D8 | Flow as a passive continuity meter | Replaced by the Chain | 2026-08-28 |
| D9 | Ledge grab | Replaced by Recall | 2026-08-28 |
| D10 | Wall run | Not adopted — scope | 2026-08-28 |
| D11 | Full deterministic rollback of the world | Not adopted — different architecture | 2026-08-28 |
| D12 | Cosmetic progression | Deferred — needs persistence | 2026-08-28 |

---

## D1 · Shooting other runners — not adopted

**Not a technical objection.** Colyseus 0.18 ships lag compensation
(`allowRewindState` / `rewind.lastSeenBy`), the room tick is a common clock, and
`tickBase` already maps each player onto it. It would be days of work.

The objection is that the leader cannot look backwards while running a hazard
course, so a shot from behind has no counterplay.

**What would reverse this** — any one of:

- **Forward-arc only.** You may shoot who you are chasing, never who is chasing
  you. Symmetric, because everyone is chasing someone.
- **Tempo damage only.** A hit breaks a chain or bleeds overspeed; never a stun,
  never a loss of control.
- **A visible lock warning** giving the target ~1 second to break line of sight or
  spend a coin on a shield.

Any of those makes it an ordinary balance problem. Scope note: this is the only
form of shooting not adopted. Shooting the world is D2.

## D3 · Reactive AI enemies — adopted, reversed

Originally refused on the grounds that reactive AI can never hard-collide with a
predicted body. That is true of one entity class and false as a general claim.

Hazard enemies (knock and stun, never a surface) are dead-reckoned and cost about
twenty lines. Solid enemies need the server to publish a committed path ahead of
time so the future is derivable rather than guessed. Both are buildable; lag
compensation for shooting them ships with the framework.

The part of the original objection that stands: an enemy that *stops* a runner
turns a timing test into a damage race. Hence the three rules in the spec —
enemies cost tempo and never HP-to-zero, they pressure space rather than health,
and they commit visibly.

## D4, D5 · Loadout swapping and persistent stances — replaced

Both had the same structural flaw: in a race, a persistent form with a speed
advantage has a permanent correct answer. You carry the fast thing and flick to
the other as a panic button. That is a cooldown with two icons, not a choice.

Replaced by pricing weight **per action** — you do not become heavy, you land
heavy. One loadout decision per race becomes forty micro-decisions, each with a
genuinely variable answer.

## D6 · Health bars and damage numbers on players — not adopted

A race is lost by losing time. Every hostile effect resolves as knockback, stun,
or lost momentum — all denominated in seconds, which is the currency the game is
actually scored in. Health introduces a second win condition competing with the
first. Enemies may have hit points; players may not.

## D7 · Ammo — adopted, reversed

Originally set aside as bookkeeping in favour of a cooldown. Wrong for the pickup
model: with a finite magazine, "spend my last shot on this pod or save it for the
seal ahead?" is a real question. Ammo is bad as a tax and good as a resource.

## D8 · Flow → the Chain

Flow rewarded *not stopping*, which is passive. The Chain rewards *executing
conversions*, which is active. Same role in the economy, far better skill
expression.

## D11 · Full deterministic rollback of the world — not adopted

It would give solid, instantly-reactive entities. It also requires the server to
broadcast every input to every client, every client to simulate every entity, and
remote players to be rolled back and visibly snapped. That replaces the
reconciler — a different netcode architecture, not an addition to this one.

---

## Corrections to earlier claims

Recorded because they changed cost estimates that decisions were made on.

| Claim | Status |
| --- | --- |
| "The architecture has no common clock" | **Wrong.** The room tick is a common clock; `tickBase` maps each player onto it |
| "Lag compensation would be a multi-week build" | **Wrong.** Colyseus 0.18 ships it; the client half is already configured correctly via `REMOTE_INTERP_MS` |
| "Reactive AI can never hard-collide with a predicted body" | **Overbroad.** True of soft-force entities, false given a published path |
| "Ammo is bookkeeping" | **Wrong** for a pickup model |
