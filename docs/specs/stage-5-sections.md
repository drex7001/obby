# Stage 5 — The section pool

**Risk** Low technical / High authoring effort · Ships a course worth re-rolling.

Design intent: [GDD §4](../GDD.md#4--the-map). Machinery:
[stage-4-generator.md](stage-4-generator.md). This spec is the **contract every
section is authored against**, plus the catalogue with numbers.

Fourteen sections. Six exist and are revised; eight are new.

---

## The contract

Every `SectionDef` declares these. The generator uses them; the author must fill
them all.

```ts
{
  id:         string,
  weight:     number,                  // selection weight, 1 = average
  difficulty: 1 | 2 | 3 | 4,
  role:       "opener" | "middle" | "rest" | "climb",
  requires:   ("vault" | "carve" | "tether" | "salvo")[],
  teaches:    "vault" | "carve" | "tether" | "impact" | "salvo" | null,
  entry:      Gate,
  exit:       Gate,
}
```

### Gates

A gate is `{ width, elevation, turn }`. Only three widths and four turns exist, so
that any exit can meet any entry without bespoke transitions.

| Width | Value | Used by |
| --- | --- | --- |
| `narrow` | 6 u | high-difficulty crossings |
| `standard` | 14 u | the default |
| `wide` | 22 u | openers, banks, climbs |

| Turn | Value |
| --- | --- |
| `straight` | 0 |
| `bend` | ±30° |
| `corner` | ±90° |
| `about` | 180° |

`elevation` is the exit height relative to the entry, in units. Only `0`, `±4`
and `±8` are legal, so a section never lands mid-step.

**Rule:** section *n+1* may follow *n* only if `entry.width == exit.width` and
`entry.elevation == 0`. Elevation is consumed *inside* a section, never across a
join.

### Budgets, per section

| | |
| --- | --- |
| Length | 36–60 u |
| Hazards | ≤ 6 |
| Anchors | ≤ 4 |
| Breakers | ≤ 3 |
| Plates | ≤ 2 |
| Landmark | exactly 1, ≥ 8 u tall, visible from 60 u |
| Checkpoint bank | at the exit, 16–24 u wide, hazard-free for 6 u in every direction |

### Authoring rules

1. **Telegraph ≥ 36 ticks at arrival speed.** At chain-8 speed (13.4 u/s) that is
   **16 u of clear sightline** before the first hazard. A section that turns must
   place its first hazard at least that far past the turn.
2. **Escalate within the section.** The existing course already does this — bar
   speeds 0.9 → 1.25 → 1.6, rotator speeds 0.55 → 0.72 → 0.86. Keep it.
3. **One taught verb.** A section is built around one verb, with the others
   available. This is what makes the pool feel varied rather than reshuffled.
4. **Completable with only `requires`.** Every optional verb must have a
   non-optional answer, or a mutator that disables it breaks the course.
5. **Draw all random values at the top of `build()`**, in a fixed order.
6. **Trigger volumes only on straight segments** — they are axis-aligned by
   construction.

---

## The six existing sections, revised

Coordinates are section-local (+Z forward, entry at z 0, floor at y 0). Values in
**bold** are changes from the current course.

### 1 · The Gauntlet — difficulty 2 · teaches Carve

| | |
| --- | --- |
| Length | 46 u |
| Entry / exit | wide / wide, straight, elevation 0 |
| Track width | **26 u** (from 22) |
| Hazards | 3 spinners at z 12 / 24 / 36, arms 20 u, ω 0.9 / 1.25 / 1.6 |
| Pivot height | **0.95** (from 0.62) |

Raising the pivots is the whole change: a carving capsule (0.86) passes under, a
running one does not. This is where the verb is taught, in the first section of
the course, where the field is still packed and a mistake is cheap.

Widening to 26 while the arms stay 20 leaves the outer 3 u unswept — a genuine
fast lane with no railing. The void is the price.

- **Variants:** bar count 2–4 · sweep directions · speeds ±15% · outer lane railed
- **Landmark:** a gantry arch over the third bar

### 2 · The Drift — difficulty 3 · teaches Impact

| | |
| --- | --- |
| Length | 40 u |
| Entry / exit | wide / standard, straight, elevation 0 |
| Sliders | 2 × (7 × 7), z 5 and 13, travel x ±8, period 4.2 s, phase 0 / 0.5 |
| Crumbles | 5 × (3.8 × 3.8), z 21 → 37.8 at 4.2 u spacing |

Five crumble stones in sequence is five landing windows: a clean run is **chain
+5**, the biggest single block in the course. Keep the void — this section is
early and short, and it earns the harshness.

- **Variants:** slider period 3.6–4.8 · phase offset · crumble lane pattern (5!
  shuffle over ±2.4 / 0) · a third faster slider that skips one stone
- **Landmark:** lit slider rails extending past the play space

### 3 · Pendulum Pass — difficulty 4 · teaches Tether

| | |
| --- | --- |
| Length | 46 u |
| Entry / exit | narrow / standard, straight, elevation 0 |
| Deck width | 3.6 u (3.2–4.4 by variant) |
| Heads | 4 pendulums at z 7 / 17 / 27 / 37, arm 7, amplitude 1.08 rad, period 2.4–3.1 s |
| **Anchors** | **4, on the pivot housings at y 9, above each head** |

The anchors make this the Tether section: swing the deck entirely, timed against
the heads. High risk, high reward, and it costs a chain level to attach.

Keep the deck narrow and keep the void. This is the hardest section in the pool
and it should stay that way.

- **Variants:** head count 3–5 · sync vs travelling wave (phase spread 0 or 0.27)
  · period · amplitude · deck width
- **Landmark:** the pivot gantry — the tallest structure in the course

### 4 · The Carousel — difficulty 3 · teaches Vault

| | |
| --- | --- |
| Length | 44 u |
| Entry / exit | standard / wide, **corner (±90°)**, elevation 0 |
| Rotators | 3 × (9 × 9), z 7 / 18 / 29, ω 0.55 / 0.72 / 0.86, random phase |
| Pushers | 2 × (5 × 3.2 × 1) at z 38 / 41, travel x −9→1 and 9→−1, period 3.4 s |
| Pad | **20 u wide** (from 18) |

The first section to turn — see [§4.3 M1](../GDD.md#43--design-language). Rotators
carry momentum; a pusher taken from behind while it travels your way **pays +3
u/s**, which falls out of the soft cap and turns a hazard into a tool.

Widening the pad by 2 u gives a shoved player a chance to recover rather than
being deleted.

- **Variants:** rotator count 2–4 · directions · speeds · gap size · pusher period
  · turn direction
- **Landmark:** a central column through all three rotators

### 5 · The Works — difficulty 3 · teaches Impact

*Was The Fork. The two parallel lanes become one lane in sequence.*

| | |
| --- | --- |
| Length | 52 u |
| Entry / exit | wide / wide, **bend (±30°)**, elevation 0 |
| Doors | 3 × (8 × 3.4 × 0.7) at z 7 / 19 / 31, period 3.8–5.2 s, phase 0 / 0.34 / 0.68, open fraction 0.42 |
| Gap | z 34 → 45, 11 u |
| Plate | z 4, 4 × 4, **hold-to-open** |
| Bridge | hinge, 3.2 × 0.8 × 11, pivot at z 39.5, offset 5.5, closed −90° → open 0° |

The plate must be **held**, so in a field of three or more somebody arrives last
by opening it. The social moment survives the single-line rule intact, and the
bridge's 0.9 s swing-out means a runner who timed it is mid-crossing when the
holder lets go.

**Solo and duo fallback:** with fewer than 3 connected runners the plate reverts
to touch-and-hold-8-seconds, so nobody is ever stuck.

- **Variants:** door period and phase · plate hold length · bridge armed (72%) ·
  gap width 9–13
- **Landmark:** the swing bridge, silhouetted

### 6 · The Climb — difficulty 3 · role `climb` (always last)

| | |
| --- | --- |
| Length | 38 u |
| Entry / exit | wide / wide, straight, **elevation +4** |
| Ramp | 16 u wide, y 0 → 4.5 over z 0 → 14 |
| Sweepers | 3 at z 5 / 11 / 21, y 2.25 / 4.05 / **5.6**, period 2.3 / 1.95 / 2.5 |
| Finish | z 35, 16 × 6 × 3 |
| Run-out | z 35 → 43, widened to 20 u |

Genuinely uphill once slopes charge, so arriving with overspeed is worth seconds
and the whole preceding section matters. **Raising the last sweeper to 5.6** makes
it a carve rather than a vault, mixing verbs at the climax.

The widened run-out is so the field can watch the leader finish.

- **Variants:** sweeper count · flip directions · periods · ramp gradient
- **Landmark:** the finish gate, visible from three sections back

---

## The eight new sections

### 7 · The Spiral — difficulty 2 · teaches Vault

| | |
| --- | --- |
| Length | 44 u | 
| Entry / exit | standard / standard, **about (180°)**, elevation **+8** |

An ascending helix of platforms wrapping a central column, climbing 8 u while
turning through 180°. Half the platforms rotate slowly. Cut the corners by
vaulting across the helix, or follow the turn.

The section that proves the turning cursor — a course that turns feels twice the
size.

- **Variants:** rotation direction · platform count 8–12 · which platforms move
- **Landmark:** the column itself

### 8 · The Sieve — difficulty 3 · teaches Impact

| | |
| --- | --- |
| Length | 40 u |
| Entry / exit | wide / wide, straight, elevation 0 |

A 26 × 40 field of vertical pistons on offset cycles — a forest, not a corridor.
No fixed safe path: the line you can take depends on the phase you arrive at, so
two runners solve it differently on the same seed.

- **Variants:** grid density 4×5 to 6×7 · period spread · whether the centre is
  fastest or slowest
- **Landmark:** a piston tower at the far edge

### 9 · The Gallery — difficulty 2 · teaches Salvo · `requires: ["salvo"]`

| | |
| --- | --- |
| Length | 44 u |
| Entry / exit | standard / standard, **bend**, elevation 0 |
| Breakers | 3 on the walls at z 8 / 20 / 32 |

A long straight with breakers on the walls. Shoot to clear the hazard ahead, or
run it as it stands. The gun pickup sits 4 u off the fast line at z 2.

**Must be completable with the gun disabled** — every breaker's effect is a
convenience, never a requirement.

- **Variants:** breaker count 2–4 · effect (hazard disable vs support collapse) ·
  target size
- **Landmark:** the gantry the supports hold up

### 10 · The Chasm — difficulty 4 · teaches Tether · `requires: ["tether"]`

| | |
| --- | --- |
| Length | 42 u |
| Entry / exit | standard / narrow, straight, elevation 0 |
| Gap | 30 u |
| Anchors | 3, at y 10, spaced 9 u |

A 30 u gap with three anchors and one clean line. Nothing catches you.

This is the section that prices the tether honestly — it has to be able to punish,
or the verb means nothing. It is also the only section in the pool that hard-
requires a verb, so the generator must never pick it when the tether is disabled.

- **Variants:** anchor count 2–4 · gap width 26–34 · anchor height
- **Landmark:** the far tower

### 11 · The Watchtower — difficulty 3 · teaches Carve

| | |
| --- | --- |
| Length | 48 u |
| Entry / exit | wide / standard, **corner**, elevation 0 |
| Threats | 2 sentries sweeping stun beams, 1 turret on a fixed cycle |

Two towers over an open approach. Straight through the beams, timed — or the
covered flank, longer, out of the turret's arc. Beams stun rather than kill, so a
hit costs chain and seconds, not the round.

- **Variants:** beam period · turret fire rate · tower count 1–3
- **Landmark:** the towers

### 12 · The Cascade — difficulty 3 · teaches Impact

| | |
| --- | --- |
| Length | 46 u |
| Entry / exit | standard / standard, straight, elevation **−8** |

A descending waterfall of crumble platforms across three drops. Each drop is a
landing window, and each pays overspeed on a Perfect — the section where falling
*downward on purpose* is the fast line.

The one section that descends, which makes it the natural pair for The Spiral.

- **Variants:** drop count 3–4 · crumble delay · platform spacing
- **Landmark:** the head of the cascade, seen from the entry

### 13 · The Turnstile — difficulty 3 · teaches Carve

| | |
| --- | --- |
| Length | 40 u |
| Entry / exit | standard / standard, straight, elevation 0 |
| Walls | 3 rotating panels at z 8 / 20 / 32 |

Rotating walls with timed openings at two heights — one you vault through, one you
carve under. Pure readable timing, mixing both movement verbs. It costs time
rather than lives, which makes it a good rest beat despite the difficulty tag.

- **Variants:** rotation speeds · opening sizes · panel count 2–4
- **Landmark:** the tallest panel

### 14 · The Straightaway — difficulty 1 · role `rest` · teaches nothing

| | |
| --- | --- |
| Length | 36 u |
| Entry / exit | wide / wide, straight, elevation 0 |

Open run, a gentle slalom of soft obstacles, and a narrowing where slipstream
does its most visible work. Every course needs one breath.

**Never placed adjacent to a checkpoint bank** — it *is* the rest, and two rests
in a row is dead air.

- **Variants:** slalom spacing · narrowing position
- **Landmark:** a distant arch framing the next section

---

## Pool composition

| Role | Sections |
| --- | --- |
| `opener` | Gauntlet, Straightaway, Gallery |
| `middle` | Drift, Pendulum Pass, Carousel, Works, Spiral, Sieve, Chasm, Watchtower, Cascade, Turnstile |
| `rest` | Straightaway |
| `climb` | Climb |

Elevation must net out: the generator tracks running elevation and may only pick
Cascade (−8) if a Spiral (+8) or Climb has already banked height, or vice versa.
A course must end within ±4 u of where it started, plus the Climb's final +4.

---

## Acceptance

Per section:

- [ ] Completable using only its declared `requires`, verified by a bot.
- [ ] Completable with every *optional* verb disabled.
- [ ] First hazard is ≥ 16 u past the entry, and ≥ 16 u past any turn.
- [ ] Exactly one landmark, ≥ 8 u tall, visible from 60 u.
- [ ] Difficulty escalates within the section.
- [ ] Length within 36–60 u; all budgets respected.
- [ ] Trigger volumes only on straight segments.
- [ ] Draws a fixed number of random values.

Per pool:

- [ ] Every exit gate has at least three matching entry gates, so selection never
      dead-ends.
- [ ] Elevation nets out across every generated course.
- [ ] The Chasm is never selected when the tether is disabled; the Gallery never
      when the Salvo is.
- [ ] 1000 seeds: every course completable, 280–340 u, first section difficulty
      ≤ 2, last is the Climb, no two difficulty ≥ 3 adjacent, no repeats.
- [ ] Bot completion ≥ 95% at hard difficulty per section — a section below that
      is either badly authored or badly tagged, and is held out of the pool until
      it passes.

## The real risk

Not technical. **This is the largest authoring job in the plan**, and the quality
of the game after stage 5 is entirely a function of how good these fourteen
sections are rather than how good the generator is.

Budget accordingly: build three new sections, play them, and only then build the
other five. A pool of nine good sections beats fourteen mediocre ones.
