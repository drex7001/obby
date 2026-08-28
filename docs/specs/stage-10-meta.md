# Stage 10 — The race around the race

**Risk** Low–Medium · Ships a session with a shape.

Six features, all server-side scoring, presentation or tooling. **None touches the
simulation**, which is why they land together and cannot break stage 9.

Design context: [GDD §7.4–7.5](../GDD.md#74--the-series) and
[§8](../GDD.md#8--multiplayer).

---

# 10.1 Series scoring

Rounds group into a best-of-five. Points 5 / 3 / 2 / 1, DNF 0, **final round
double**.

- Ends at 5 rounds or 15 points, whichever first.
- A player joining mid-series enters at the current **last-place** score, not
  zero, so they are not mathematically eliminated on arrival.
- Series standings show beside the round standings on the results screen.

```
seriesRound  : uint8
seriesLength : uint8
seriesPoints : uint16    // on Player
seriesWinner : string    // sessionId, "" while live
```

The cheapest comeback mechanic available: losing one round stops meaning losing
the session, so a runner who fell at The Drift still has something to play for.
Build it first — it takes an afternoon and changes how a session feels
immediately.

- [ ] Points award correctly for every position including DNF.
- [ ] The final round doubles.
- [ ] A mid-series joiner is seeded at the current minimum.
- [ ] Disconnect and reconnect inside the `allowReconnection` window keeps points.
- [ ] Room tests cover a full five-round series end to end.

# 10.2 Splits and rivals

On banking a checkpoint the server records `(player, index, tick)`. The HUD shows
`−0.8s` / `+2.4s` against the best time to that checkpoint this round, held ~2 s.
A marker names the runner immediately ahead and behind with the gap in seconds.

```
splits : t.array("uint32")   // ms per checkpoint, 0 = not reached
```

A player in third currently has no idea whether they are one second or twenty
behind, so there is nothing to fight for. This is the whole fix.

- [ ] A split appears within one tick of banking.
- [ ] The leader's split shows against their previous round, not themselves.
- [ ] Markers need hysteresis — they must never flicker between two near-equal
      runners.
- [ ] Nothing here is predicted; a correction never causes a visible snap.

# 10.3 Finished-runner agency

A finished or eliminated player gets a free camera and **one charge** to influence
the live course. Each section declares 0–2 influence points: a hazard that can be
dropped, a segment that can be opened, a door cycle that can be nudged.

Rules, in order of importance:

1. **Symmetric.** It affects the *section*, never a chosen runner. That is what
   stops it being griefing and what stops it being collusion.
2. **One charge per player per race**, non-refundable.
3. **Telegraphed ≥ 36 ticks** before geometry moves, to everyone, attributed by
   name. The attribution *is* the social payload — the fun is that runners know
   who did it.
4. **Never removes control.** It may change geometry; it may not stun or freeze.
5. **Locked out in the final 10 s**, so it cannot decide a photo finish.

Technically it is a plate a spectator pressed: the server validates, then writes a
Class B tick stamp. Nothing new in the simulation.

Free camera: the follow rig detaches and cycles between live runners. The body
stays in the world but stops taking input.

- [ ] A running player cannot spend a charge.
- [ ] Geometry never moves less than 36 ticks after the announcement.
- [ ] A late stamp produces a bounded correction, not a teleport.
- [ ] The spectator camera never shows a runner's un-reconciled predicted state.

---

# 10.4 Bots

`simulatePlayers()` steps every player from `this.inputs.get(sessionId)`. **A bot
is an object that fills an input channel** — no special case in the simulation, no
separate movement or collision code, and it cannot cheat by construction.

```
InputSource
  ├── ClientChannel   (existing: decoded from the wire)
  └── BotChannel      (new: filled by BotController.think())
```

That indirection is the entire structural change. Bots are `Player` entries with
`bot: t.boolean().default(false)`, which the client needs only to style the
nameplate.

**Navigation** rides machinery that already exists: the course centre-line is a
navmesh; checkpoints are ordered goals; `raycastWorld()` plus a direct `poseAt()`
query gives legitimate hazard awareness (a pure function a skilled human learns
too); no progress for N ticks sends the `respawn` bit, exactly as a human presses
R.

**Difficulty**, expressed only in ways a human could also have:

| Knob | Easy | Hard |
| --- | --- | --- |
| Reaction delay | 12 ticks | 3 ticks |
| Impact timing error | ±8 ticks | ±1 tick |
| Chain usage | ignores it | maintains it |
| Verbs | vault only | carve, hop, Recall |
| Mistake rate | 1 fall per section | rare |

**Never** a speed bonus, a wider capsule, or knowledge a human could not have. The
moment a bot cheats, losing to one stops meaning anything.

| Lobby | Behaviour |
| --- | --- |
| 1 human | Fill to 3 after `SOLO_UNLOCK_TICKS` |
| 2–3 humans | Fill to 4 |
| 4+ humans | No bots |
| A human joins mid-series | Remove a bot at the next round boundary, never mid-race |

Bots score in the series but are marked, and a series won by a bot is reported as
such.

**They are also the course generator's test suite** — a thousand seeds run
headless asking "is this actually completable?". That is the real reason they are
not a stage-11 nicety.

- [ ] A bot is stepped through the identical `stepPlayer()`, with no branch
      anywhere in `src/shared`.
- [ ] A bot completes ≥ 95% of generated courses at hard, ≥ 70% at easy.
- [ ] A bot's input packet passes the same `sanitize` as a human's.
- [ ] A headless harness runs 1000 seeds with 4 bots and reports completion rate
      per section.

**The real risk** is competence, not netcode: a bot that falls at the pendulums
every time is worse than no bot. Make bot navigability an explicit constraint on
the section pool, and gate a section's inclusion on a bot completion threshold.

**Recommendation:** cap bots below the best human in the room, so they are
pace-setters rather than bosses.

---

# 10.5 Deterministic replays

A race is already fully described by data the server has: seed, per-player input
streams, `tickBase`, and the tick stamps. Store those and re-run the simulation.
No video, no position recording, no interpolation.

A 110-second six-player race is ~120 KB uncompressed, and inputs compress
extremely well.

```ts
interface RaceRecording {
  version: number; buildHash: string;
  seed: number; round: number;
  raceStartTick: number; raceDeadlineTick: number;
  players: Array<{
    sessionId: string; name: string; colour: number; bot: boolean;
    tickBase: number;
    inputs: PackedInput[];
    rebases: Array<[tick: number, newBase: number]>;
  }>;
  stamps: Array<[tick: number, array: number, index: number, value: number]>;
}
```

**Two things that are easy to forget and break everything:**

1. **`tickBase` rebases.** `rebase()` adjusts a player's base mid-race a tick at a
   time ([RaceRoom.ts](../../src/rooms/RaceRoom.ts#L217)). A replay using only the
   initial base drifts exactly as a lagging client would.
2. **Record stamp *writes*, not stamp state.** A faithful replay regenerates them
   — but only if it is bit-exact. Recording them lets the replayer **assert** they
   match, which turns replay into a determinism test rather than a hope.

That second point is what makes this valuable rather than cute: **the replay
verifies itself.** A regenerated stamp that does not match has found a real
determinism bug.

**Build order:** the headless replayer and CI check first (developer tooling);
client-side playback, ghosts and spectator scrubbing after.

- [ ] A recorded race replays to bit-identical positions, times and ranks.
- [ ] Every regenerated stamp matches the recording.
- [ ] Recording adds < 0.1 ms/tick and never allocates in the step.
- [ ] `tools/replay.mjs <file>` exits non-zero on divergence.
- [ ] A deliberately introduced non-determinism is *caught*. Test the test.

**Expect it to find existing bugs.** Replay turns determinism from something
relied upon into something proven, and the first honest run will surface drift
nobody knew about. Budget for fixing what it finds.

---

# 10.6 Interference

**Nothing here ships before Recall (stage 8).** Pushing a player who has no
recovery verb is griefing, not gameplay.

The governing rule: *interference must cost the interferer something measurable,
and the target must see it coming.*

### Slipstream — build this first

Running within 12° and 1.5–5 u behind another runner siphons **a chain level every
2 s** from them to you.

Class C by construction and a perfect fit: a soft, bounded, self-correcting effect
applied from interpolated positions, using the exact code path the existing shove
already occupies. **There is no cheaper way to add meaningful player interaction to
this codebase.**

The cost is elegant because it is purely positional — drafting means giving up
route freedom, a real price in a currency the game already has. Only one drafter
benefits per leader; nearest wins.

Balance risk only. Too strong and a pack never breaks apart, which is as boring as
six time trials. **Start weak.**

### Contested plate

The Works' bridge plate must be **held**, not touched: whoever opens it cannot
cross. A semantic change to `touchPlate()` plus a level tweak, converting the
game's oldest mechanic into a genuine social problem.

The bridge takes `HINGE_SWING_TICKS` (0.9 s) to swing out once released — enough
for a runner who timed it to be mid-crossing, and the hinge already carries riders
correctly via `groundId`. Under 3 connected runners it reverts to
touch-and-hold-8-seconds so a duo is never stuck.

### Committed traps

Arm a lever by standing on it ~0.8 s, **or** by spending 60% of your chain while
moving. It fires on a 2–4 s delay, visible and attributed from the moment it is
armed.

Levers sit off the fast line, so using one is a real detour. The effect is
knockback, a dropped hazard, or a closed door — never a stun longer than
`STUN_TICKS`, never a teleport.

**It affects whoever is there, including its author.** A trap that cannot catch
the person who set it is a free weapon; one that can is a decision.

Structurally a pressure plate with a delay and an owner — the plate system is the
proof of concept.

### Co-op gate

Two plates 18 u apart, held simultaneously, open a shortcut for 6 s. Neither
runner can open it alone. Worth ~4–6 s so cooperating beats running alone without
deciding the race.

Under 3 connected runners the two plates merge into one. Bots should be able to
participate — a bot that will hold a plate for a human makes solo play far richer.

**The open question:** does this ever fire in a real lobby? It needs two runners
near each other, aware, and willing. Prototype it with bots as guaranteed partners
and see whether humans take the bait.

### Build order — and the honest answer

1. Slipstream.
2. Contested plate.
3. **Playtest, then decide whether anything else is needed.**
4. Co-op gate, then traps.

Step 3 is the real content of this section. The Chain plus Heavy Impact plus
slipstream may already supply all the player-to-player interaction the game needs,
and every mechanic past sufficiency makes the race noisier rather than deeper.

---

## What is deliberately absent

Direct attacks on another runner — no shooting them, no melee, no targeted
abilities. The leader cannot see behind while running a hazard course, so an
attack from behind is uncontestable by construction. Recorded in
[decisions.md](../decisions.md) with the three changes that would reverse it.
