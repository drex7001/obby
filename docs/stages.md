# Staged delivery

Twelve stages. **Every stage ships a playable game, and no stage invalidates the
one before it.** You can stop after any of them and have something coherent.

## Current implementation status

All twelve stages have their specified systems implemented and automated
coverage for their deterministic behavior. The remaining acceptance work is intentionally
manual or blocked on a later stage: Stage 1 still needs its twenty-round
momentum feel pass, Stage 2 still needs a focused landing-feel playtest, the two
completability gates in Stage 5 need the scripted runner that arrives with Stage
10, and the "completable with the gun disabled" and "completable with the tether
disabled" gates in Stages 6 and 7 need the same sweep — which now exists, and
does not yet pass. Stage 7 carries a genuine playtest gate, the prototype gate,
which no test can sign off, and Stage 10's interference section carries another.
The table records implementation status, not a claim that every playtest gate
has been signed off.

**The one number worth knowing.** The stage-10 bot sweep completes **48% of
courses at hard** against a specified bar of 95%.

A low number here does *not* by itself mean the game is broken, and it is worth
being precise about which is which. Three of the sections the sweep flags have
been taken apart by hand since:

| Section | Verdict |
| --- | --- |
| **The Chasm** | **A real bug, now fixed.** It was not completable by anybody — best possible swing 27 u against a 26–34 u gap, and no anchor was inside the camera's look-up range. See the stage-7 notes |
| **The Works** | Bot only. Its doors are 8 u wide on a track 39 u across, leaving 15.6 u clear each side, and the bridge plate holds for 8 s against a 2.4 s run |
| **Pendulum Pass** | Bot only. A narrow deck with heads on a 2.4–3.1 s cycle. Hard on purpose, and the timing windows are there |

The bot's remaining failures are its own navigation, not the course. Everything structural about
bots shipped — a bot is an input channel and nothing in `src/shared` knows one
exists — but the navigation is not good enough yet, and the completability gates
in stages 5, 6, 7 and 11 stay open until it is. `npm run sweep` reports the
per-section rates, which is the constraint the pool is now measured against.

**What is deliberately not built.** Three items, each gated by its own spec
rather than by effort: Stage 10's committed traps and co-op gate (behind that
spec's "playtest, then decide whether anything else is needed"), Stage 11's
Relay mode (last in its own build-by-cost order, and blocked on a schema-field
trade that should be a deliberate decision), and Stage 11's progression and
Arena (both explicitly gated on things no implementation can answer — a database
and an auth story for one, a design call for the other).

| Stage | Status | Delivered systems | Primary coverage |
| --- | --- | --- | --- |
| 0 · Safety net | Implemented | Extended input packet, full-state rollback fuzzing, tick-stamp defaults, shared world raycast | `test/stages/foundations.test.ts` |
| 1 · Momentum | Implemented | 90 Hz collision, falloff acceleration, directional targets, slope acceleration, overspeed decay | `test/stages/momentum.test.ts` |
| 2 · Impact and Chain | Implemented | Perfect/neutral/fumble/Heavy landings, Chain, server-stamped victim impulses, Heavy plates and crumble triggers | `test/stages/impact-chain.test.ts` |
| 3 · Carve | Implemented | Variable capsule height, stand-up clearance, dive, hop window, raised Gauntlet bar, Chain-scaled air control | `test/stages/carve.test.ts`; Stage 3 browser smoke |
| 4 · The course generator | Implemented | Turning cursor, arc warp, section registry, weighted selection, yawed ramps and trigger volumes, generated checkpoint banks | `test/stages/generator.test.ts` |
| 5 · The section pool | Implemented | Fourteen sections — six revised, eight new — against one authored contract | `test/stages/sections.test.ts` |
| 6 · The Salvo | Implemented | Gun pickup and magazine, deterministic shot resolution with assist, five breaker effects, coins, Burn and the Chain shield | `test/stages/salvo.test.ts` |
| 7 · Tether | Implemented | Deterministic anchor targeting, the swing constraint, the tension accumulator, and a closed-form arc-bottom release window | `test/stages/tether.test.ts` |
| 8 · Recall | Implemented | Tick-indexed history ring, the restore, the freeze that doubles as the confirmation window, the destination ghost | `test/stages/recall.test.ts` |
| 9 · Threats | Implemented | Six Watchers as pure functions of tick, shootable shells, and enemies on committed arcs — hazard and solid | `test/stages/threats.test.ts` |
| 10 · The race around the race | Implemented, with one gap | Series scoring, splits and rivals, bots and the headless sweep, self-verifying replays, slipstream, the contested plate, spectator influence | `test/stages/meta.test.ts` |
| 11 · Variation | Implemented, less Relay | Tuning migrated onto the level, twelve mutators, and four modes — time attack, Collect, Survival, Hunt | `test/stages/variation.test.ts` |

`npm test` runs all suites, and `SMOKE_STAGE3_ONLY=1 npm run smoke` drives two
real clients through entering Carve and landing a carve hop.

The packet contract is normalized in
[`src/shared/input.ts`](../src/shared/input.ts), reusable simulation fixtures
live under [`test/helpers/`](../test/helpers/), and stage-specific behavior is
grouped by feature under [`test/stages/`](../test/stages/). The course is
assembled by [`src/shared/generator.ts`](../src/shared/generator.ts) from the
sections under [`src/shared/sections/`](../src/shared/sections/);
[`src/shared/level.ts`](../src/shared/level.ts) is now only the shapes those two
agree on.

### Where stages 4 and 5 depart from their specs

Four deliberate deviations, each because the spec as written dead-ends:

1. **Sections are joined by a generated bank, not by matching gate widths.** The
   pool has exactly one narrow entry (Pendulum Pass) and exactly one narrow exit
   (the Chasm), and the Chasm is held out whenever the tether is disabled — so
   strict width matching makes Pendulum Pass unreachable. The 4 u bank the
   generator drops at every join is also where the checkpoint lives, which
   removes the same code from fourteen section files.
2. **`Volume` carries a yaw** instead of banks being confined to straight
   segments. It costs ten lines, and it also fixes the Works' pressure plate,
   which the straight-segment rule would not have.
3. **A bank is as wide as the ground either side of it** (20–28 u), not the
   spec's fixed 16–24. Sections build wider than the gates they declare — the
   Gauntlet's 26 u track is the whole point of that section — and a bank sized
   from the declared gate is a hole where the fast line meets it.
4. **Difficulty pacing is "no two 4s adjacent, no three hard sections in a row"**
   rather than "no two difficulty ≥ 3 adjacent". Nine of the ten middles are
   tagged 3 or 4 and the Climb is a 3; the spec's rule has no solution.
5. **Turnstile and Sieve are tagged difficulty 2**, and Turnstile can also be the
   rest beat. With one difficulty-2 middle in the pool the pacing rule forced the
   Spiral into every single course.

One known content gap, not a bug: the Spiral still appears in roughly three
quarters of courses, because it is the only section that climbs and the pool has
few soft middles. The cheapest fix is another difficulty-2 middle, and that is
authoring work rather than generator work.

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

Stage 4 does add three level *fields* — `Ramp.yaw`, `Volume.yaw` and
`Obstacle.baseYaw` — but the level is not networked: both ends rebuild it from
the seed, so none of it crosses the wire. Stage 6 adds `Pickup`, a `slot` on
every `Breaker`, and the `collapse` and `seal` obstacle kinds on the same terms.

Stage 6's real wire cost is `ammo`, `fireCool`, two held-input flags, `pickupIn`,
the Burn stamp and `shieldUntil` on the player, plus two int32 arrays on the
room — about two bytes per tick per player, and a stamp on the rare tick
something breaks. Stage 7 adds five more player fields and nothing else: anchors
are level data, and targeting is a pure function of the aim ray.

Stage 8 adds three player fields and nothing else. Its history ring is per
player, kept by both ends, and synchronised by neither — what crosses the wire is
the *result* of a restore, which is ordinary simulated state the reconciler
already handles.

The input packet is still exactly what stage 0 settled. Two bits now carry two
verbs each, and in both cases the discriminator is something the design already
wanted: `action` tethers when an anchor is inside the targeting cone and fires
otherwise, and `use` burns on a tap and recalls on a four-tick hold — the hold
being the accident guard Recall's spec asked for anyway.
| 6 | — | ammo, coins | breaker + pickup stamps |
| 7 | — | tether anchor, length | — |
| 8 | — | recall stamps | — |
| 9 | — | — | enemy collection, shell stamps |
| 10 | — | series points, splits, influence, bot flag | series state, best splits |
| 11 | — | — | mutator list, mode, kill line, hare |

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

*Spec: [stage-5-sections.md](specs/stage-5-sections.md)*

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
