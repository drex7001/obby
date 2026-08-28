# Staged delivery

Twelve stages. **Every stage ships a playable game, and no stage invalidates the
one before it.** You can stop after any of them and have something coherent.

---

## The non-breaking rules

What "non-breaking" means here, concretely. A stage that violates any of these is
not ready.

1. **Schema fields are added, never removed or repurposed.** A field means the
   same thing in stage 11 as it did when it was introduced. Renaming a field is a
   breaking change; adding one beside it is not.
2. **A new simulated field lands in all three places in the same commit** — the
   sim state, the schema (with a default), and the client's reconciled field list.
   Two out of three is a silent desync that only shows under packet loss.
3. **A constant that a later stage will vary moves onto the level *before* it is
   varied.** Otherwise the client's compiled-in copy disagrees with the server's.
4. **A stage ships with its tuning done.** No "we will balance it later" that
   forces the previous stage to be re-tuned — that is a breaking change wearing a
   different hat.
5. **Systems precede the content that needs them.** The generator before the
   sections; the raycast before the tether; the verbs before the sections built
   around them.
6. **Every stage ends with the determinism harness green.** That is the definition
   of done, not a nice-to-have.

## What crosses the wire, by stage

The clearest way to see that the stages are additive.

| Stage | Added to the input packet | Added to player state | Added to room state |
| --- | --- | --- | --- |
| 0 | pitch, 3 action bits | tick stamps | — |
| 1 | — | — | — |
| 2 | — | chain, impact buffers, knock stamps | — |
| 3 | — | carve state | — |
| 4 | — | — | — |
| 5 | — | — | — |
| 6 | — | ammo, coins | breaker + pickup stamps |
| 7 | — | tether anchor, length | — |
| 8 | — | recall stamps | — |
| 9 | — | — | enemy collection |
| 10 | — | series points, splits | series state |
| 11 | — | — | mutator id |

Nothing is ever taken away. The input packet is settled in stage 0 and never
touched again.

---

# Stage 0 · Safety net

*Spec: [stage-0-foundations.md](specs/stage-0-foundations.md)*

**Ships:** an identical game, now provable.

| Work | Why now |
| --- | --- |
| Determinism fuzz harness over every simulated field | Every stage after this adds fields. The current test checks a trajectory; a new field can desync without moving the body |
| Extended input packet — camera pitch, three action bits | One wire change instead of four. The bits sit unused until stage 2 |
| Per-player tick-stamp convention | Every timed mechanic from here uses it |
| Shared world raycast | Tether targeting, shooting, bot hazard awareness and the camera boom are one query |

**Cannot break anything:** nothing is player-visible. The new input fields are
sanitised and ignored.

**Exit:** the harness fails loudly on a deliberately introduced non-determinism.

---

# Stage 1 · Momentum

*Spec: [stage-1-momentum.md](specs/stage-1-momentum.md)*

**Ships:** the same game, with a body that has weight.

Acceleration on a falloff curve, lower friction, directional speed scaling, air
and slope preservation, the soft cap, overspeed decay, `SUB_STEPS` to 3.

**Cannot break stage 0:** no schema change at all. Overspeed needs no new field —
it is just velocity above the cap, and velocity is already synced. This stage is
physics inside the existing step plus a constants file.

**The gate — and it is a real one.** Play twenty rounds. Does holding a line feel
good? Does stopping hurt? Does the course still feel fair near hazards? Tune the
acceleration curve until yes. **Do not proceed until this is right**, because
every later stage assumes momentum feels good.

---

# Stage 2 · Impact and the Chain

*Spec: [stage-2-impact.md](specs/stage-2-impact.md)*

**Ships:** the vertical slice — and the decision point for the whole design.

The landing window (perfect / neutral / fumble / heavy), the shockwave, the chain
feeding the soft cap, and the stamped-impulse pattern for cross-player knocks.

Build it against **one hand-authored section**, two players. No course generation,
no series, no enemies, no HUD polish.

**Cannot break stage 1:** momentum is untouched. A neutral landing keeps 85%, so a
player who ignores the mechanic entirely plays exactly the stage-1 game, slightly
slower. Nothing is taken away from anyone.

**The gate: is landing fun?**

If yes, everything downstream follows. If no, the design thesis is wrong — and it
is far better to know after one section than after twelve. Stages 4, 9, 10 and 11
are valuable either way; stages 3, 7 and 8 are not.

---

# Stage 3 · Carve

*Spec: [stage-3-carve.md](specs/stage-3-carve.md)*

**Ships:** the second verb, and the first real decision inside a jump.

The slide/dive, the halved capsule, the carve hop.

**Cannot break stage 2:** additive. Impact resolves identically whether you
arrived carving or not.

**The risk, stated plainly:** the capsule height is currently a module constant
read directly throughout the collision code. Making it variable means threading
height through the body and auditing every read site, plus a stand-up check so a
player never un-carves into a ceiling. This is the most delicate refactor in the
plan and it wants the stage-0 harness already in place.

**Exit:** a capsule is never inside geometry — asserted by carving into every low
gap on a large seed sample.

---

# Stage 4 · The course generator

*Spec: [stage-4-generator.md](specs/stage-4-generator.md)*

**Ships:** courses that actually vary.

Sections become registry entries built at a cursor that carries a *heading*, not
just a Z coordinate, so the course can turn. The six existing sections migrate
unchanged first, then gain their revisions.

**Cannot break stage 3:** it is a refactor of a pure function, guarded by the
existing same-seed-same-level test. No player mechanic is touched.

**Smaller than it looks.** The single-line rule removes the route graph, branch
scoring and per-branch validity testing entirely. The existing centre-line
progress model stands unchanged.

**Exit:** 1000 seeds produce bit-identical levels on both ends; every section's
exit gate matches the next section's entry; build time under 4 ms.

---

# Stage 5 · The section pool

*Content, authored to the contract in [stage-4-generator.md](specs/stage-4-generator.md). Sections themselves: [GDD §4.5–4.6](GDD.md#45--the-six-existing-sections-revised).*

**Ships:** a course worth re-rolling.

Eight new sections, each built around one verb. The six existing sections gain
their revisions — raised bar pivots so the Gauntlet teaches Carve, anchors on the
pendulum housings, the Fork resequenced into the single-line Works.

**Cannot break stage 4:** content only, inside the contract the registry defines.

**Exit:** every generated course is completable using only its declared verbs,
and completable with no gun and no tether at all.

---

# Stage 6 · The Salvo

*Spec: [stage-6-salvo.md](specs/stage-6-salvo.md)*

**Ships:** the reward loop.

Gun pickup, four shots, breakers, coin pods, and **Burn** — convert coins to
overspeed. One sink is enough to prove the currency; the shield, the Recall
recharge and the seal key follow only if it works.

**Cannot break stage 5:** every section stays completable with no gun, tested by
the bot sweep. A player who never picks the gun up plays the stage-5 game.

**Exit:** shots resolve identically on prediction, replay and server; two players
hitting one pod within 5 ticks both get coins.

---

# Stage 7 · Tether

*Spec: [stage-7-tether.md](specs/stage-7-tether.md)*

**Ships:** the aerial verb, and the game's most expressive moment.

Anchors as level content, an elastic swing that stores tension, and a release
window that converts to height or speed depending on when you let go.

**Cannot break stage 6:** anchors are new level content. Sections without them are
untouched, and every section must remain completable with the tether disabled —
which is also how a mutator can remove the verb safely.

**Prototype gate.** Build it against one hand-authored section before placing
anchors across the pool. Rope mechanics are hard to make feel good and a bad one
is worse than none. If it does not land after a focused effort, cut it — the kit
is already complete without it, and slipstream plus the Watchers are the
replacement.

---

# Stage 8 · Recall

*Spec: [stage-8-recall.md](specs/stage-8-recall.md)*

**Ships:** the recovery verb, and the kit is complete.

A ring of past states per player, a restore that does not rewind the world, and a
freeze that doubles as the server-confirmation window.

**Cannot break stage 7:** purely a new ability on a cooldown.

**Exit:** a restore is identical under rollback replay at 0 ms and 200 ms
latency, and the correction always lands inside the freeze.

---

# Stage 9 · Threats

*Spec: [stage-9-threats.md](specs/stage-9-threats.md)*

**Ships:** a course that feels hostile.

Watchers first — turret, sentry, jaws, hunter — all pure functions of tick, so
they cost nothing on the wire and carry no netcode risk. Then tier-1 enemies:
they chase, knock and stun, and are never a surface.

**Cannot break stage 8:** Watchers are new obstacle kinds inside the existing
union. Enemies are a new collection interacting through the same soft-force slot
the player shove already occupies.

**Stop early if it is enough.** Build the Watchers, play them, and see how much of
"the course is hostile" is already there. Whatever is still missing is the actual
case for enemies — and it will be a much better-informed case.

---

# Stage 10 · The race around the race

*Spec: [stage-10-meta.md](specs/stage-10-meta.md)*

**Ships:** a session with a shape.

Series scoring (best of five, final round double), per-checkpoint splits against
the leader, rival markers, finished-runner influence charges, bots, and
deterministic replays.

**Cannot break stage 9:** every item is server-side scoring or presentation. None
of it touches the simulation.

**Two of these punch above their weight.** Series scoring is the cheapest comeback
mechanic in the plan — losing one round stops meaning losing the session. And
bots are the course generator's test suite as much as a lobby filler: a thousand
seeds run headless answering "is this actually completable?"

---

# Stage 11 · Variation

*Spec: [stage-11-variation.md](specs/stage-11-variation.md)*

**Ships:** the same content, many times over.

The mutator deck, then alternate modes — time attack first (nearly free once
replays exist), then Collect.

**Cannot break stage 10 — but only if one thing is done first.** Any tuning
constant a mutator varies must move onto the level before the mutator ships, or
the client's compiled-in copy disagrees with the server's. That migration is the
first task of this stage, not the last.

---

## If you only build three stages

**0, 1, 2.** The safety net, momentum, and the landing. That is the whole thesis,
it is playable, and it answers the only question that has to be true before any of
the rest is worth building.
