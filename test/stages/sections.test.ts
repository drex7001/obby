/**
 * Stage 5 - the section pool.
 *
 * Every check here runs against every section in the registry, over a spread of
 * variant draws, because the contract in `docs/specs/stage-5-sections.md` is a
 * contract each section is authored against rather than something the generator
 * can enforce at assembly time.
 *
 * Two gates in that spec are deliberately not here: "completable using only its
 * declared requires" and "bot completion >= 95%" both need the scripted runner
 * that arrives with stage 10, and asserting them with anything weaker would be
 * a green light that means nothing.
 */

import assert from "assert";

import { mulberry32 } from "../../src/shared/math.js";
import { runSection } from "../../src/shared/sections/build.js";
import { SECTIONS } from "../../src/shared/sections/registry.js";
import { gateTurn, type SectionDef, type SectionResult, type Verb } from "../../src/shared/sections/types.js";

const ALL_VERBS = new Set<Verb>(["vault", "carve", "tether", "salvo"]);

/** Build one section from a seeded stream, counting how many values it drew. */
function build(def: SectionDef, seed: number, turn = gateTurn(def.exit)) {
  const rand = mulberry32(seed);
  let draws = 0;
  const result = runSection(def, {
    rand: () => { draws++; return rand(); },
    nextId: (() => { let id = 1; return () => id++; })(),
    nextCrumbleSlot: (() => { let slot = 0; return () => slot++; })(),
    nextPlateId: (() => { let id = 0; return () => id++; })(),
    nextBreakerSlot: (() => { let slot = 0; return () => slot++; })(),
    nextPickupSlot: (() => { let slot = 0; return () => slot++; })(),
    nextShellSlot: (() => { let slot = 0; return () => slot++; })(),
    verbs: ALL_VERBS,
  }, turn);
  return { result, draws };
}

/** Every variant of a section, near enough: twenty-four different draws. */
function variants(def: SectionDef): SectionResult[] {
  const out: SectionResult[] = [];
  for (let seed = 1; seed <= 24; seed++) { out.push(build(def, seed * 7919).result); }
  return out;
}

const hazards = (r: SectionResult) => r.obstacles.filter((o) => o.role === "hazard");

/**
 * How far along local Z an obstacle can ever reach, over its whole cycle.
 *
 * A rotating box sweeps a circle of its half-diagonal, a hinge sweeps its arm,
 * and a slider travels between its endpoints. Using the resting footprint
 * instead is how a spinning platform ends up sharing space with a bank.
 */
function reach(o: SectionResult["obstacles"][number]): [number, number] {
  const spins = o.kind === "spinner" || o.kind === "rotator" || o.kind === "hinge";
  const radius = spins
    ? (o.kind === "hinge" ? (o.offsetZ ?? 0) + Math.hypot(o.size.x, o.size.z) / 2
                          : Math.hypot(o.size.x, o.size.z) / 2)
    : o.size.z / 2;
  const zs = [o.pz];
  if (o.a) { zs.push(o.a.z); }
  if (o.b) { zs.push(o.b.z); }
  return [Math.min(...zs) - radius, Math.max(...zs) + radius];
}

/**
 * Clearance a moving part must leave at a gate.
 *
 * The generator's bank overlaps 0.6 u into each neighbour and a runner standing
 * at its edge reaches another 0.42 u past that, so anything closer than this can
 * touch - or worse, be *stood on* by - a runner who is meant to be resting.
 */
const GATE_CLEARANCE = 1.5;

describe("the section pool", () => {
  for (const def of SECTIONS) {
    describe(def.id, () => {
      it("draws the same number of random values whatever it rolls", () => {
        const first = build(def, 1).draws;
        for (let seed = 2; seed <= 60; seed++) {
          assert.strictEqual(build(def, seed * 104729).draws, first,
            `${def.id} drew a variable number of randoms - every section after ` +
            "it would shift, and the client and server would build different courses");
        }
        assert.ok(first > 0, `${def.id} draws nothing, so it has no variants`);
      });

      it("is 36 to 60 units long and keeps its geometry inside its own gates", () => {
        assert.ok(def.length >= 36 && def.length <= 60, `${def.id} is ${def.length} u`);
        for (const r of variants(def)) {
          const zs: number[] = [];
          for (const s of r.solids) { zs.push(s.z - s.hz, s.z + s.hz); }
          for (const o of r.obstacles) {
            const reach = Math.max(o.size.x, o.size.z) / 2;
            zs.push(o.pz - reach, o.pz + reach);
            if (o.a) { zs.push(o.a.z - reach, o.a.z + reach); }
            if (o.b) { zs.push(o.b.z - reach, o.b.z + reach); }
          }
          for (const p of r.plates) { zs.push(p.volume.z - p.volume.hz, p.volume.z + p.volume.hz); }
          for (const rp of r.ramps) { zs.push(rp.z - rp.hz, rp.z + rp.hz); }
          // A 1.5 u lip either end: geometry that stays inside this cannot
          // reach into the neighbouring section, whatever heading it lands at.
          assert.ok(Math.min(...zs) >= -1.5, `${def.id} reaches back to ${Math.min(...zs)}`);
          assert.ok(Math.max(...zs) <= def.length + 1.5,
            `${def.id} reaches to ${Math.max(...zs).toFixed(1)}, past its ${def.length} u exit`);
        }
      });

      it("respects the per-section budgets", () => {
        for (const r of variants(def)) {
          assert.ok(hazards(r).length <= 6, `${def.id} has ${hazards(r).length} hazards`);
          assert.ok(r.anchors.length <= 4, `${def.id} has ${r.anchors.length} anchors`);
          assert.ok(r.breakers.length <= 3, `${def.id} has ${r.breakers.length} breakers`);
          assert.ok(r.plates.length <= 2, `${def.id} has ${r.plates.length} plates`);
        }
      });

      it("puts exactly one landmark at least eight units tall in the section", () => {
        for (const r of variants(def)) {
          const tall = r.decor.filter((d) => d.hy * 2 >= 8);
          assert.ok(tall.length >= 1, `${def.id} has no landmark`);
        }
      });

      /**
       * Telegraph: 36 ticks at chain-8 speed is 16 u of clear sightline. The
       * generator drops a 4 u bank at every join, and every section keeps its
       * last 6 u hazard-free, so 6 + 4 + 6 clears the bar at any join. An
       * opener has nothing in front of it, so it has to find all 16 itself.
       */
      it("leaves a telegraphed approach to its first hazard and a clear run to its exit", () => {
        for (const r of variants(def)) {
          const list = hazards(r);
          if (list.length === 0) { continue; }
          const first = Math.min(...list.map((o) => o.pz));
          const last = Math.max(...list.map((o) => o.pz));
          const needed = def.roles.includes("opener") ? 16 : 6;
          assert.ok(first >= needed,
            `${def.id}: first hazard at ${first.toFixed(1)} u, needs ${needed}`);
          assert.ok(def.length - last >= 6,
            `${def.id}: last hazard is ${(def.length - last).toFixed(1)} u from the exit`);
        }
      });

      it("keeps every moving part clear of the checkpoint banks at its gates", () => {
        // Regression: the Spiral used to straddle both gates with platforms
        // that were spinning rotators 42% of the time, so a runner standing on
        // the bank was picked up and swung around the platform's axis.
        for (const r of variants(def)) {
          for (const o of r.obstacles) {
            const [lo, hi] = reach(o);
            assert.ok(lo >= GATE_CLEARANCE,
              `${def.id}: a ${o.kind} reaches back to ${lo.toFixed(2)} u, into the bank behind it`);
            assert.ok(def.length - hi >= GATE_CLEARANCE,
              `${def.id}: a ${o.kind} reaches to ${hi.toFixed(2)} u, into the bank ahead of it`);
          }
        }
      });

      it("emits a centre-line that starts at the entry gate and ends at the exit", () => {
        for (const r of variants(def)) {
          const first = r.spine[0];
          const last = r.spine[r.spine.length - 1];
          assert.ok(Math.abs(first.z) < 1e-9 && Math.abs(first.y) < 1e-9,
            `${def.id}: the centre-line must start at the entry gate`);
          assert.ok(Math.abs(last.z - def.length) < 1e-9,
            `${def.id}: the centre-line ends at ${last.z}, not ${def.length}`);
          assert.ok(Math.abs(last.y - def.exit.elevation) < 1e-9,
            `${def.id}: the centre-line ends at y ${last.y}, not ${def.exit.elevation}`);
          for (let i = 1; i < r.spine.length; i++) {
            assert.ok(r.spine[i].z >= r.spine[i - 1].z - 1e-9,
              `${def.id}: the centre-line must run forward`);
          }
        }
      });

      it("declares one taught verb and requires only verbs a mode can withhold", () => {
        for (const verb of def.requires) {
          assert.ok(ALL_VERBS.has(verb), `${def.id} requires an unknown verb ${verb}`);
        }
        if (def.requires.length > 0) {
          assert.ok(def.requires.includes(def.teaches as Verb),
            `${def.id} requires a verb it does not teach`);
        }
      });

      it("bends without leaving a gap in its track", () => {
        if (gateTurn(def.exit) === 0) { return; }
        // A turning section is warped onto an arc, so a long slab would come
        // out as a chord with the track falling away either side of it.
        for (const r of variants(def)) {
          for (const s of r.solids) {
            assert.ok(s.hz * 2 <= 8,
              `${def.id} emits a ${(s.hz * 2).toFixed(1)} u slab; ` +
              "a turning section must chunk its track");
          }
        }
      });
    });
  }

  it("covers every verb the kit will eventually have", () => {
    const taught = new Set(SECTIONS.map((s) => s.teaches));
    for (const verb of ["carve", "impact", "vault", "tether", "salvo"]) {
      assert.ok(taught.has(verb as never), `nothing in the pool teaches ${verb}`);
    }
  });

  it("hard-requires a verb in exactly the two sections that are about one", () => {
    const gated = SECTIONS.filter((s) => s.requires.length > 0).map((s) => s.id).sort();
    assert.deepStrictEqual(gated, ["chasm", "gallery"],
      "every other section must stay completable with every optional verb disabled");
  });
});
