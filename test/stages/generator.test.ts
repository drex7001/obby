/**
 * Stage 4 - the course generator.
 *
 * These are the acceptance gates from
 * `docs/specs/stage-4-generator.md`, in the order that spec lists them. What
 * they collectively assert is that the *machinery* is sound: the seed is the
 * only input, sections meet cleanly, the course does not fold back onto itself,
 * and the yawed ramp the turning cursor made necessary collides where it is
 * drawn.
 */

import assert from "assert";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { buildLevel, buildLevelWith, type Level } from "../../src/shared/level.js";
import { inVolume, rampSurfaceY } from "../../src/shared/collision.js";
import { pathProgress } from "../../src/shared/progress.js";
import { SECTIONS, sectionById } from "../../src/shared/sections/registry.js";
import { Course } from "../../src/client/render/course.js";
import type { Stage } from "../../src/client/render/scene.js";

/** Course centre-line, resampled at roughly two-unit spacing. */
function centreLine(level: Level) {
  const out: { x: number; z: number; at: number }[] = [];
  for (let i = 1; i < level.path.length; i++) {
    const a = level.path[i - 1], b = level.path[i];
    const span = level.pathCum[i] - level.pathCum[i - 1];
    const steps = Math.max(1, Math.ceil(span / 2));
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      out.push({
        x: a.x + (b.x - a.x) * t,
        z: a.z + (b.z - a.z) * t,
        at: level.pathCum[i - 1] + span * t,
      });
    }
  }
  return out;
}

describe("course generator", () => {
  it("rebuilds a bit-identical level from the same seed, across 1000 seeds", () => {
    for (let seed = 1; seed <= 1000; seed++) {
      const first = JSON.stringify(buildLevel(seed));
      const second = JSON.stringify(buildLevel(seed));
      assert.strictEqual(second, first, `seed ${seed} rebuilt differently`);
    }
  });

  it("assembles seven sections: an easy opener, a Climb last, and no repeats", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const { sections } = buildLevel(seed);
      assert.strictEqual(sections.length, 7, `seed ${seed} built ${sections.length} sections`);
      assert.ok(sections[0].difficulty <= 2,
        `seed ${seed} opened on difficulty ${sections[0].difficulty}`);
      assert.strictEqual(sections[sections.length - 1].id, "climb",
        `seed ${seed} did not end on the Climb`);
      const ids = new Set(sections.map((s) => s.id));
      assert.strictEqual(ids.size, sections.length, `seed ${seed} repeated a section`);
    }
  });

  /**
   * The spec asks for "no two difficulty >= 3 adjacent". That is unsatisfiable
   * against the pool it ships with - nine of the ten middles are tagged 3 or 4
   * and the Climb is a 3 - so the generator enforces the intent instead, and
   * this is the shape of it.
   */
  it("paces difficulty: never two 4s in a row, never three hard sections in a row", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const d = buildLevel(seed).sections.map((s) => s.difficulty);
      for (let i = 1; i < d.length; i++) {
        assert.ok(!(d[i] >= 4 && d[i - 1] >= 4), `seed ${seed}: two 4s at ${i}`);
      }
      for (let i = 2; i < d.length; i++) {
        assert.ok(!(d[i] >= 3 && d[i - 1] >= 3 && d[i - 2] >= 3),
          `seed ${seed}: three hard sections at ${i} (${d.join(",")})`);
      }
    }
  });

  it("nets elevation out to the Climb's +4 and keeps total length in budget", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const level = buildLevel(seed);
      const net = level.sections.reduce(
        (sum, s) => sum + (sectionById(s.id)?.exit.elevation ?? 0), 0);
      assert.strictEqual(net, 4, `seed ${seed} ended ${net} u off the datum`);
      assert.ok(level.courseLength >= 280 && level.courseLength <= 340,
        `seed ${seed} is ${level.courseLength} u long`);
    }
  });

  it("joins every section to the next through a bank at least as wide as both gates", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const level = buildLevel(seed);
      assert.strictEqual(level.checkpoints.length, level.sections.length - 1,
        `seed ${seed}: one bank per join`);

      for (let i = 0; i < level.sections.length - 1; i++) {
        const exit = sectionById(level.sections[i].id)!.exit;
        const entry = sectionById(level.sections[i + 1].id)!.entry;
        const bank = level.checkpoints[i];
        // The bank is what makes any exit meet any entry. Without it the pool
        // dead-ends: exactly one section has a narrow entry and exactly one has
        // a narrow exit, and that one is held out whenever the tether is off.
        const widths = { narrow: 6, standard: 14, wide: 22 };
        const span = (bank.volume.hx + 1) * 2;
        assert.ok(span >= widths[exit.width] && span >= widths[entry.width],
          `seed ${seed}: bank ${i} is ${span} u, gates are ` +
          `${widths[exit.width]}/${widths[entry.width]}`);
      }
    }
  });

  it("never narrows the ground at a bank", () => {
    // The one place on the course a runner is put back must be at least as wide
    // as the track that delivers them to it. A section may build wider than the
    // gate it declares - the Gauntlet's unswept outer lane is the whole point of
    // that section - and a bank sized from the declared gate is a hole exactly
    // where the fast line meets it.
    for (let seed = 1; seed <= 300; seed++) {
      const level = buildLevel(seed);
      level.checkpoints.forEach((cp, i) => {
        const pad = cp.volume.hx * 2 + 2;
        const feeding = Math.max(level.sections[i].exitTrack, level.sections[i + 1].entryTrack);
        assert.ok(pad >= feeding - 1e-9,
          `seed ${seed}: bank ${i} is ${pad.toFixed(1)} u but ` +
          `${level.sections[i].id}/${level.sections[i + 1].id} deliver ${feeding.toFixed(1)} u`);
      });
    }
  });

  it("keeps progress monotonic along the assembled centre-line", () => {
    for (const seed of [3, 31, 97, 256, 401, 512]) {
      const level = buildLevel(seed);
      let last = -1;
      for (const p of centreLine(level)) {
        const at = pathProgress(level, p.x, p.z);
        assert.ok(at >= last - 1e-9,
          `seed ${seed}: progress fell from ${last} to ${at} at ${p.at.toFixed(1)} u`);
        last = at;
      }
    }
  });

  it("never lets the course double back onto itself", () => {
    // Two points far apart along the course must be far apart in space, or the
    // track crosses itself and `pathProgress` cannot tell them apart.
    for (let seed = 1; seed <= 200; seed++) {
      const points = centreLine(buildLevel(seed));
      for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j < points.length; j++) {
          if (points[j].at - points[i].at < 70) { continue; }
          const d = Math.hypot(points[i].x - points[j].x, points[i].z - points[j].z);
          assert.ok(d >= 26,
            `seed ${seed}: centre-line comes within ${d.toFixed(1)} u of itself ` +
            `(${points[i].at.toFixed(0)} u vs ${points[j].at.toFixed(0)} u)`);
        }
      }
    }
  });

  it("puts solid ground under every respawn point", () => {
    // A bank is where a fallen runner is put back, so it is the one place on
    // the course that must never be a hole. It is also the join between two
    // sections, which is exactly where a transform bug would leave one.
    for (let seed = 1; seed <= 300; seed++) {
      const level = buildLevel(seed);
      const places = [
        { at: level.spawn, what: "the lobby spawn" },
        ...level.checkpoints.map((cp) => ({ at: cp.spawn, what: `bank ${cp.index}` })),
      ];
      for (const { at, what } of places) {
        const under = level.solids.some((box) => {
          const c = Math.cos(box.yaw), s = Math.sin(box.yaw);
          const dx = at.x - box.x, dz = at.z - box.z;
          const lx = dx * c + dz * s, lz = -dx * s + dz * c;
          return Math.abs(lx) <= box.hx && Math.abs(lz) <= box.hz
            && Math.abs((box.y + box.hy) - at.y) < 0.2;
        });
        assert.ok(under, `seed ${seed}: nothing solid under ${what}`);
      }
    }
  });

  it("allocates one crumble slot per crumble obstacle, with no gaps", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const level = buildLevel(seed);
      const slots = level.obstacles.filter((o) => o.kind === "crumble").map((o) => o.slot!);
      assert.strictEqual(level.crumbleCount, slots.length,
        `seed ${seed}: crumbleCount ${level.crumbleCount} vs ${slots.length} crumbles`);
      assert.deepStrictEqual([...slots].sort((a, b) => a - b),
        slots.map((_, i) => i), `seed ${seed}: crumble slots are not 0..n-1`);
    }
  });

  it("only picks sections whose required verbs the mode actually grants", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const level = buildLevel(seed);
      const granted = new Set(level.verbs);
      for (const s of level.sections) {
        for (const verb of sectionById(s.id)!.requires) {
          assert.ok(granted.has(verb),
            `seed ${seed}: ${s.id} requires ${verb}, which this mode does not grant`);
        }
      }
    }
    // A section gated on a verb that has not shipped stays out entirely...
    for (let seed = 1; seed <= 300; seed++) {
      for (const s of buildLevelWith(seed, { verbs: ["vault", "carve"] }).sections) {
        assert.ok(sectionById(s.id)!.requires.length === 0,
          `seed ${seed}: ${s.id} was picked by a mode that grants neither salvo nor tether`);
      }
    }
    // ...and becomes reachable the moment it does.
    const seen = new Set<string>();
    for (let seed = 1; seed <= 400; seed++) {
      const level = buildLevelWith(seed, { verbs: ["vault", "carve", "tether", "salvo"] });
      for (const s of level.sections) { seen.add(s.id); }
    }
    assert.ok(seen.has("chasm"), "the Chasm should be selectable once the tether exists");
    assert.ok(seen.has("gallery"), "the Gallery should be selectable once the Salvo exists");
  });

  it("treats the verb set as part of the seeded input", () => {
    const a = buildLevelWith(11, { verbs: ["vault", "carve"] });
    const b = buildLevelWith(11, { verbs: ["carve", "vault"] });
    assert.strictEqual(JSON.stringify(a), JSON.stringify(b),
      "verb order must not change the course");
    const c = buildLevelWith(11, { verbs: ["vault", "carve", "tether"] });
    assert.notStrictEqual(JSON.stringify(a.sections), JSON.stringify(c.sections),
      "a different verb set indexes a different space of courses");
  });

  it("builds a course in well under 4 ms", () => {
    const samples: number[] = [];
    for (let seed = 1; seed <= 400; seed++) {
      const t0 = performance.now();
      buildLevel(seed);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)];
    assert.ok(p95 < 4, `p95 build time was ${p95.toFixed(2)} ms`);
  });
});

describe("the turning cursor", () => {
  it("rises along a yawed ramp's own axis and stays level across it", () => {
    // The ramp the Climb emits inherits whatever heading the course reached, so
    // "up the slope" is almost never world +Z. This is the whole regression:
    // reading world Z instead of the ramp's local Z tilts the surface sideways.
    let checked = 0;
    for (let seed = 1; seed <= 200 && checked < 12; seed++) {
      const level = buildLevel(seed);
      for (const ramp of level.ramps) {
        if (Math.abs(ramp.yaw) < 0.05) { continue; }
        checked++;
        const c = Math.cos(ramp.yaw), s = Math.sin(ramp.yaw);
        const at = (lx: number, lz: number) =>
          rampSurfaceY(ramp, ramp.x + lx * c - lz * s, ramp.z + lx * s + lz * c);

        assert.ok(at(0, -ramp.hz * 0.9) < at(0, ramp.hz * 0.9),
          "the surface must rise along the ramp's own axis");
        assert.ok(Math.abs(at(-ramp.hx * 0.9, 0) - at(ramp.hx * 0.9, 0)) < 1e-9,
          "the surface must be level across the ramp's axis");
        assert.ok(Number.isNaN(at(0, ramp.hz * 1.5)),
          "past the top edge there is no surface");
      }
    }
    assert.ok(checked > 0, "some seed should produce a yawed ramp");
  });

  it("draws a yawed ramp on exactly the surface the simulation walks", () => {
    let checked = 0;
    for (let seed = 1; seed <= 60 && checked < 3; seed++) {
      const level = buildLevel(seed);
      const yawed = level.ramps.filter((r) => Math.abs(r.yaw) > 0.05);
      if (yawed.length === 0) { continue; }

      // A fresh scene per seed: `Course` names every ramp mesh "ramp", so a
      // reused scene hands back the previous course's slab.
      const engine = new NullEngine();
      const scene = new Scene(engine);
      const stage = {
        scene, material: () => null as any, castsAndReceives: () => {},
      } as unknown as Stage;
      new Course(stage, level);
      const meshes = scene.meshes.filter((m) => m.name === "ramp");
      assert.strictEqual(meshes.length, level.ramps.length);

      level.ramps.forEach((ramp, i) => {
        if (Math.abs(ramp.yaw) <= 0.05) { return; }
        checked++;
        const mesh = meshes[i];
        mesh.computeWorldMatrix(true);
        // Points on the slab's top face, which is the surface the runner walks.
        const slope = Math.hypot(ramp.hz * 2, ramp.y1 - ramp.y0);
        for (const t of [-0.35, 0, 0.35]) {
          const local = new Vector3(0, 0.45, slope * t);
          const world = Vector3.TransformCoordinates(local, mesh.getWorldMatrix());
          const walkable = rampSurfaceY(ramp, world.x, world.z);
          // A tenth of a millimetre. Babylon's world matrices are float32, so a
          // ramp a hundred units from the origin cannot round-trip to double
          // precision; what is under test is that the drawn slab and the walked
          // surface are the same plane, not the same float.
          assert.ok(Math.abs(walkable - world.y) < 1e-4,
            `seed ${seed}: drawn ${world.y.toFixed(5)} vs walkable ${walkable.toFixed(5)}`);
        }
      });
      engine.dispose();
    }
    assert.ok(checked > 0, "some seed should produce a yawed ramp");
  });

  it("catches a runner in a rotated trigger volume, and only inside it", () => {
    // The spec's alternative was to keep every bank on a straight segment. A
    // yaw on the volume is cheaper and also fixes the plate on a bending
    // section, which that rule would not have.
    let checked = 0;
    for (let seed = 1; seed <= 200 && checked < 20; seed++) {
      for (const cp of buildLevel(seed).checkpoints) {
        if (Math.abs(cp.volume.yaw) < 0.2) { continue; }
        checked++;
        const v = cp.volume;
        const c = Math.cos(v.yaw), s = Math.sin(v.yaw);
        const at = (lx: number, lz: number) =>
          inVolume(v.x + lx * c - lz * s, v.y - v.hy, v.z + lx * s + lz * c, v);

        assert.ok(at(0, 0), "the centre of a bank must trigger");
        assert.ok(at(v.hx * 0.9, 0), "the far edge of a bank must trigger");
        assert.ok(!at(v.hx + 4, 0), "four units clear of the bank must not trigger");
        assert.ok(!at(0, v.hz + 4), "four units past the bank must not trigger");
      }
    }
    assert.ok(checked > 0, "some seed should produce a rotated bank");
  });
});

describe("the section registry", () => {
  it("declares fourteen sections, each covering a role the generator asks for", () => {
    assert.strictEqual(SECTIONS.length, 14);
    for (const role of ["opener", "middle", "rest", "climb"] as const) {
      assert.ok(SECTIONS.some((s) => s.roles.includes(role)), `no section can be a ${role}`);
    }
    for (const s of SECTIONS) {
      assert.ok(s.roles.length > 0, `${s.id} has no role`);
      assert.ok(s.weight > 0, `${s.id} has no selection weight`);
      assert.strictEqual(s.entry.elevation, 0,
        `${s.id}: elevation is consumed inside a section, never across a join`);
      assert.ok([0, 4, -4, 8, -8].includes(s.exit.elevation),
        `${s.id} exits at an illegal elevation`);
    }
  });
});
