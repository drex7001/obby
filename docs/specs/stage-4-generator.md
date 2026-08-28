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
