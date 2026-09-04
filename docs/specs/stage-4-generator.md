# Stage 4 — The course generator

**Risk** Low technical / Medium content · Ships courses that actually vary.

Design context: [GDD §4](../GDD.md#4--the-map). The sections themselves are
specified in [stage-5-sections.md](stage-5-sections.md); this spec is the
machinery that assembles them. **The course does not branch**, so
there is no route graph here — a section contributes one centre-line segment and
the existing arc-length progress model stands unchanged.

---

## The problem

Sections are addressed by hardcoded Z: `[12, 24, 36].forEach(...)`,
`floor(0, 128, 3.6, 46)`. They cannot be reordered, resized, repeated or omitted.
That is the mechanical reason the "procedural" course is parameter jitter over a
fixed skeleton.

## The cursor

A frame, not a coordinate:

```ts
interface Cursor {
  x: number; z: number;
  yaw: number;   // heading, +Z at 0
  y: number;     // elevation
}
```

Sections emit geometry in **section-local space** (+Z forward, origin at the entry
gate, floor at y 0) and the assembler transforms it by the cursor. This is what
lets the course turn.

Transform notes:

- `SolidBox` and `Obstacle` already carry a `yaw` — rotate the position about the
  cursor, add the cursor yaw. No format change.
- **`Ramp` needs a `yaw` field.** It is axis-aligned along +Z today
  ([level.ts](../../src/shared/level.ts#L22)) and `resolveRamp()` /
  `rampSurfaceY()` assume it. The only format change the refactor needs, and it
  touches collision, so it gets its own mirrored-geometry test.
- **Slider endpoints (`a`, `b`) are absolute world points** and must be
  transformed too. Easy to miss.
- Trigger volumes are axis-aligned by construction. **Keep checkpoint banks on
  straight segments** — they are rest beats anyway — and the problem disappears
  without giving `Volume` a yaw.

## Section definition

```ts
interface SectionDef {
  id: string;
  weight: number;
  difficulty: 1 | 2 | 3 | 4;
  /** Verbs a runner needs. The generator only picks what the mode allows. */
  requires: readonly ("vault" | "carve" | "tether" | "salvo")[];
  role: "opener" | "middle" | "rest" | "climb";
  entry: Gate;
  exit: Gate;
  build(ctx: SectionCtx): SectionResult;
}

interface Gate { width: number; elevation: number; turn: number }

interface SectionCtx {
  rand: () => number;
  nextId: () => number;
  nextCrumbleSlot: () => number;
  nextPlateId: () => number;
  verbs: ReadonlySet<string>;
}

interface SectionResult {
  length: number;                 // Z consumed, local space
  solids: SolidBox[];
  ramps: Ramp[];
  obstacles: Obstacle[];
  plates: Plate[];
  anchors: Anchor[];              // stage 7
  breakers: Breaker[];            // stage 6
  checkpoint: Omit<Checkpoint, "index"> | null;
  spine: Vec3[];                  // local-space centre-line
  notes: string[];
}
```

## Selection

```
1. opener   — role "opener", difficulty <= 2
2. 4 middles — no repeats, no two difficulty>=3 adjacent,
               entry gate matches previous exit, requires ⊆ mode verbs
3. rest     — inserted after the hardest run
4. climb    — role "climb", always last
5. build each at the cursor, appending geometry and spine
6. lobby before, run-out after
```

---

## Determinism rules

The ways a procedural generator desynchronises. Each has bitten real projects.

1. **Draw all random values up front, in a fixed order.** A section calling
   `rand()` a variable number of times depending on an earlier `rand()` shifts
   every downstream section. The current code is safe only because its counts are
   fixed — make it a rule, and prefer drawing an array at the top of `build()`.
2. **Never branch generation on anything but the seed.** Not player count, not
   time, not the room tick. If a mode changes generation, the mode is part of the
   seeded input and is synced.
3. **Ids and slots come from the context allocators.** The room sizes its
   `crumbleTicks` array from `level.crumbleCount`; any gap breaks the mapping.
4. **Keep the arithmetic boring.** Prefer plain `sqrt` over `Math.hypot` in
   generation. It is fine in the sim, where both ends run the same call.

## Migration

1. Land the registry with the six existing sections, producing the same courses.
   Existing tests must pass.
2. Add the turning cursor and `Ramp.yaw` with every section still declaring
   `turn: 0`. Nothing changes visually; the machinery is proven.
3. Turn on turns for one section, then more.
4. Add new sections ([stage-5-sections.md](stage-5-sections.md)).

Expect the *specific course* for a seed to change at step 1 — the seed now indexes
a different space. Determinism is the invariant, not any particular course.

## Acceptance

- [ ] The same seed produces a bit-identical `Level` across 1000 seeds, compared
      field by field.
- [ ] Every section's exit gate matches the next section's entry gate.
- [ ] Total length 280–340 u; no geometry from section *n* overlaps *n+1*.
- [ ] No two difficulty ≥ 3 adjacent; first ≤ 2; last is role `climb`.
- [ ] Every section is completable using only its declared verbs, and with every
      optional verb disabled — verified by bots (stage 10) or a scripted runner.
- [ ] Progress is monotonic along the assembled centre-line.
- [ ] A yawed ramp passes a mirrored-geometry test: a point on the rendered
      surface is walkable, its mirror across the ramp axis is not.
- [ ] Trigger volumes are never emitted on a turning segment.
- [ ] `buildLevel()` stays under 4 ms at p95.

## Risks

| Risk | Mitigation |
| --- | --- |
| Yawed ramps break `resolveRamp()` | Its own seam test; land it before any section turns |
| A section draws a variable number of randoms | Review checklist; draw up front |
| An impossible course ships | Bot completability sweep in CI |
| Crumble slot mapping breaks | Allocator owns slots; assert `crumbleCount` equals the number of crumble obstacles |

---

## As built

Machinery in [`generator.ts`](../../src/shared/generator.ts), the contract in
[`sections/types.ts`](../../src/shared/sections/types.ts), the emitter in
[`sections/build.ts`](../../src/shared/sections/build.ts), and the gates in
[`test/stages/generator.test.ts`](../../test/stages/generator.test.ts).
`level.ts` is now only the shapes both sides agree on, which is what keeps the
section files free of an import cycle back into it.

**A section is bent, not authored bent.** Rather than each turning section
emitting an arc, the assembler warps every point it emits onto a constant-radius
arc — `turn` radians over `length` units gives radius `length / turn`, and a
straight section is the degenerate case. A section therefore contains course
design and no coordinates that depend on where it lands. The cost is that a
turning section has to emit its track in chunks (`ctx.track`, `ctx.rail`), since
one long slab would come out as a chord; a straight section still emits one slab
and pays nothing.

**The turn direction is a decision, not just a draw.** The seed picks a sign,
then two rules can veto it: the course may not wind past a half turn
cumulatively, and a bend that would bring the course back within 26 u of track
already laid is flipped. Running straight is always the third option, and it is
exactly the shape every earlier turn was judged against — which is what makes
the guarantee hold rather than merely usually hold. Measured over 600 seeds the
worst approach between two points 70 u apart along the course is 28 u.

### Four deviations, each because the spec dead-ends

1. **Sections are joined by a generated bank rather than by matching gate
   widths.** The pool has exactly one narrow entry and exactly one narrow exit,
   and the narrow exit is the Chasm, which is held out whenever the tether is
   disabled — so strict width matching makes Pendulum Pass unreachable. The 4 u
   bank the assembler drops at every join is 20 u wide, hazard-free, and carries
   the checkpoint, which also removes that code from fourteen section files.
2. **`Volume` carries a yaw**, rather than banks being confined to straight
   segments. Ten lines, and it fixes the Works' pressure plate too, which the
   straight-segment rule would not have.
3. **A bank is sized from the ground either side of it, not from the declared
   gate.** A gate width is one of three values; real track is whatever the
   section wanted. The Gauntlet builds 26 u because its unswept outer lane is
   the point of the section, and a bank sized from its declared 22 u gate is a
   two-metre hole on each side exactly where the fast line arrives. Banks
   therefore run 20-28 u rather than the spec's 16-24; a bank narrower than the
   track feeding it is not a bank. `gateSpan()` measures it, and the banks are
   emitted in a second pass because sizing one needs the section on *both*
   sides of it.
4. **Difficulty pacing is "never two 4s adjacent, never three hard sections in a
   row"**, not "no two difficulty ≥ 3 adjacent". Nine of the ten middles are
   tagged 3 or 4 and the Climb is a 3, so the spec's rule has no solution.
5. **Elevation outranks pacing** when the two constraints disagree. A course
   that does not net out ends 8 u off its own datum, which is broken; one hard
   section too many in a row is only worse.

`Obstacle.baseYaw` is the one addition the warp forced on the simulation:
`poseAt()` adds it for every kind, because on a bent section it is the
difference between a door lying along the track and lying across it.

### Where it stands against the acceptance list

Every item is covered by `test/stages/generator.test.ts` except
"completable using only its declared verbs", which needs the scripted runner
that arrives with stage 10 and is tracked there. `buildLevel()` p95 is about
0.06 ms against a 4 ms budget.
