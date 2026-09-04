/**
 * Stage 7 - the Tether.
 *
 * Class A throughout, so the netcode half of this file is the stage-0 argument
 * again: run the swing twice and demand the same answer. The rest is the verb
 * itself - that the constraint is stable at three sub-steps, that the release
 * window is a window rather than a slope, and that a tether can only convert
 * speed a runner already brought.
 *
 * Two acceptance items are not here. "Every course completable with the tether
 * disabled, 1000 seeds" needs the stage-10 bot sweep; its checkable half - that
 * a mode without the verb never picks a section requiring it - lives in the
 * generator suite. And the smoke run cannot be relied on to reach an anchor, so
 * the full attach/swing/release is driven headless here instead.
 */

import assert from "assert";

import {
  CHAIN_MAX, GRAVITY, RUN_SPEED, SHOT_EYE, TETHER_COOL_TICKS, TETHER_HAND,
  TETHER_HEIGHT_RATE, TETHER_MAX_TICKS, TETHER_RANGE, TETHER_RELEASE_WINDOW,
  TETHER_SPEED_GAIN, TETHER_TENSION_FLOOR, TICK_RATE,
} from "../../src/shared/constants.js";
import { buildLevel, buildLevelWith, type Level } from "../../src/shared/level.js";
import { softCap, type SimInput, type SimState } from "../../src/shared/movement.js";
import { selectAnchor } from "../../src/shared/tether.js";
import { sectionById } from "../../src/shared/sections/registry.js";
import {
  createFlatLevel, createSimState, createWorld, firstStateDifference, idleInput,
  stepSimulation,
} from "../helpers/simulation.js";

// ---------------------------------------------------------------- the rig
//
// A single anchor over a void. The runner is launched at it from twelve units
// back and four below, which is inside the pitch limits a real camera allows -
// a test that has to look further up than the game does is not testing the game.

const ANCHOR = { x: 0, y: 9, z: 0 };
const START = { x: 0, y: 3, z: -12 };

function rig(): Level {
  const level = createFlatLevel();
  // The floor is only there to keep the runner above KILL_Y; the swing never
  // reaches it, so nothing about this test is a collision test by accident.
  level.solids[0] = { x: 0, y: -12.5, z: 0, hx: 60, hy: 0.5, hz: 60, yaw: 0, style: "floor" };
  level.anchors = [{ id: 7, ...ANCHOR }];
  return level;
}

/** The yaw and pitch that put the anchor dead centre from the start point. */
function aim() {
  const dx = ANCHOR.x - START.x;
  const dy = ANCHOR.y - (START.y + SHOT_EYE);
  const dz = ANCHOR.z - START.z;
  return { yaw: Math.atan2(dx, dz), pitch: -Math.atan2(dy, Math.hypot(dx, dz)) };
}

function runner(over: Partial<SimState> = {}): SimState {
  return createSimState({
    ...START, vz: 13.4, grounded: false, chain: CHAIN_MAX, ...over,
  });
}

const at = aim();
const swingInput = (over: Partial<SimInput> = {}): SimInput =>
  ({ ...idleInput, yaw: at.yaw, pitch: at.pitch, action: true, ...over });

/** Distance from the runner's hand to the anchor. */
const rope = (s: SimState) =>
  Math.hypot(s.x - ANCHOR.x, s.y + TETHER_HAND - ANCHOR.y, s.z - ANCHOR.z);

/**
 * Attach on tick 0, swing, and release on `releaseAt` (never, if omitted).
 * Returns the state plus a per-tick trace of the rope length.
 */
function swing(
  releaseAt = Infinity, ticks = 60, over: Partial<SimState> = {}, replay = false,
  /** Override the tension banked at the moment of release, for A/B runs. */
  forceTension?: number,
) {
  const level = rig();
  const world = createWorld(level);
  const state = runner(over);
  const lengths: number[] = [];
  const heights: number[] = [];
  let tensionAtRelease = 0;
  for (let tick = 0; tick < ticks; tick++) {
    if (tick === releaseAt) {
      tensionAtRelease = state.tension;
      if (forceTension !== undefined) { state.tension = forceTension; }
    }
    stepSimulation(state, swingInput({ action: tick < releaseAt }), world, tick, replay);
    lengths.push(rope(state));
    heights.push(state.y);
  }
  return { state, lengths, heights, level, world, tensionAtRelease };
}

describe("the tether", () => {
  // =================================================================== aiming

  it("picks the same anchor from the same ray, and none from the wrong one", () => {
    const level = rig();
    const world = createWorld(level);
    const eye = { x: START.x, y: START.y + SHOT_EYE, z: START.z };

    const first = selectAnchor(level, world.phase, 0, eye.x, eye.y, eye.z, at.yaw, at.pitch);
    assert.ok(first, "an anchor dead ahead must be selectable");
    for (const tick of [0, 17, 4211.5]) {
      const again = selectAnchor(level, world.phase, tick, eye.x, eye.y, eye.z, at.yaw, at.pitch);
      assert.strictEqual(again, first, "selection must not depend on the tick");
    }

    // Outside the cone, and behind: neither is a swing.
    assert.strictEqual(
      selectAnchor(level, world.phase, 0, eye.x, eye.y, eye.z, at.yaw + 0.6, at.pitch), null);
    assert.strictEqual(
      selectAnchor(level, world.phase, 0, eye.x, eye.y, eye.z, at.yaw + Math.PI, at.pitch), null);
  });

  it("will not attach to an anchor out of range or behind a wall", () => {
    const level = rig();
    const world = createWorld(level);
    const eye = { x: START.x, y: START.y + SHOT_EYE, z: START.z };

    const far = { ...level.anchors[0] };
    level.anchors[0] = { ...far, z: far.z + TETHER_RANGE + 5 };
    assert.strictEqual(
      selectAnchor(level, world.phase, 0, eye.x, eye.y, eye.z, at.yaw, at.pitch), null,
      "range is a hard limit, not a hint");

    level.anchors[0] = far;
    level.solids.push({ x: 0, y: 5, z: -6, hx: 8, hy: 6, hz: 0.5, yaw: 0, style: "wall" });
    assert.strictEqual(
      selectAnchor(level, world.phase, 0, eye.x, eye.y, eye.z, at.yaw, at.pitch), null,
      "an anchor through a wall is not a target");
  });

  it("breaks a tie by anchor id so both ends agree", () => {
    const level = rig();
    const world = createWorld(level);
    const eye = { x: START.x, y: START.y + SHOT_EYE, z: START.z };
    // Two anchors at the same point: the offsets are identical to the bit.
    level.anchors = [{ id: 9, ...ANCHOR }, { id: 4, ...ANCHOR }];
    const first = selectAnchor(level, world.phase, 0, eye.x, eye.y, eye.z, at.yaw, at.pitch);
    level.anchors.reverse();
    const second = selectAnchor(level, world.phase, 0, eye.x, eye.y, eye.z, at.yaw, at.pitch);
    assert.strictEqual(first!.id, 4);
    assert.strictEqual(second!.id, 4, "list order must not decide it");
  });

  // ================================================================ the swing

  it("attaches on the press, at the distance it was made from, and costs Chain", () => {
    const level = rig();
    const world = createWorld(level);
    const state = runner();
    const before = Math.hypot(
      state.x - ANCHOR.x, state.y + TETHER_HAND - ANCHOR.y, state.z - ANCHOR.z);

    stepSimulation(state, swingInput(), world, 0);

    assert.strictEqual(state.anchorId, 8, "anchor id + 1, so 0 can mean detached");
    assert.ok(Math.abs(state.ropeLen - before) < 0.5,
      `rope is ${state.ropeLen.toFixed(2)}, attached from ${before.toFixed(2)}`);
    assert.strictEqual(state.chain, CHAIN_MAX - 1, "attaching costs a Chain point");
    assert.strictEqual(state.tetherUntil, TETHER_MAX_TICKS);
  });

  it("holds a swing steady at three sub-steps, with no oscillation", () => {
    // The rope is slack until it is not: a runner who throws it from twelve
    // units back falls for half a second before it catches. What matters is
    // what happens at and after the catch - a spring would ring there, and a
    // hard positional correction does not.
    const { lengths, state } = swing(Infinity, 40);
    const ropeLen = state.ropeLen;
    const caught = lengths.findIndex((len) => len >= ropeLen);
    assert.ok(caught > 0, "the fixture must actually put the rope under load");

    // The catch itself is allowed one sub-step of overshoot, because that is
    // exactly how long the constraint takes to see it.
    const overshoot = lengths[caught] - ropeLen;
    assert.ok(overshoot < 0.15, `the catch overshot by ${overshoot.toFixed(4)} u`);

    // After that it is taut and stays taut, with no ringing at all.
    for (let i = caught + 1; i < lengths.length; i++) {
      const stretch = Math.abs(lengths[i] - ropeLen);
      assert.ok(stretch < 0.01,
        `tick ${i}: the rope is ${stretch.toFixed(4)} u off its length`);
    }
  });

  it("lets go of the world before the world lets go of it", () => {
    // The constraint runs before the collision resolve, so a rope that would
    // drag a runner through a wall loses the argument.
    const level = rig();
    level.solids.push({ x: 0, y: 2, z: -4, hx: 10, hy: 8, hz: 1, yaw: 0, style: "wall" });
    const world = createWorld(level);
    const state = runner({ z: -8 });
    // Attach directly rather than through the aim, which the wall now blocks.
    state.anchorId = 8;
    state.ropeLen = 6;
    for (let tick = 0; tick < 40; tick++) {
      stepSimulation(state, swingInput(), world, tick);
      const insideZ = Math.abs(state.z - -4) < 1 - 0.01;
      const insideY = state.y + 1.72 > -6 && state.y < 10;
      assert.ok(!(insideZ && insideY),
        `tick ${tick}: the constraint seated the runner inside the wall at z ${state.z.toFixed(2)}`);
    }
  });

  it("banks tension from tangential speed, and nothing at all from hanging", () => {
    const swung = swing(Infinity, 30).state;
    assert.ok(swung.tension > 0.5, `a real swing banked only ${swung.tension.toFixed(3)}`);

    // Hanging motionless directly below the anchor: no tangential speed, so no
    // tension, however long you hold on. A tether cannot create speed.
    const level = rig();
    const world = createWorld(level);
    const still = createSimState({
      x: ANCHOR.x, y: ANCHOR.y - TETHER_HAND - 6, z: ANCHOR.z,
      grounded: false, anchorId: 8, ropeLen: 6, chain: 4,
    });
    for (let tick = 0; tick < TETHER_MAX_TICKS - 1; tick++) {
      stepSimulation(still, swingInput(), world, tick);
    }
    assert.strictEqual(still.tension, 0, "a stationary hang pays nothing");

    // ...and letting go of it pays nothing either, not even the Chain point.
    stepSimulation(still, swingInput({ action: false }), world, TETHER_MAX_TICKS);
    assert.strictEqual(still.anchorId, 0);
    assert.strictEqual(still.chain, 4, "no swing, no reward");
  });

  // ============================================================== the release

  it("finds the arc bottom where the swing actually reaches it", () => {
    // The window is computed in closed form from the current state rather than
    // by integrating forward; this is the check that the closed form is right.
    const { heights } = swing(Infinity, 60);
    let bottom = -1;
    for (let i = 1; i < heights.length; i++) {
      if (heights[i] > heights[i - 1] && bottom < 0) { bottom = i - 1; }
    }
    assert.ok(bottom > 0, "the rig must actually produce a swing with a bottom");

    // Walk the same swing again, asking each tick how far the bottom is.
    const level = rig();
    const world = createWorld(level);
    const state = runner();
    let opened = -1;
    for (let tick = 0; tick <= bottom; tick++) {
      stepSimulation(state, swingInput(), world, tick);
      if (opened < 0 && state.anchorId !== 0) {
        const probe = { ...state };
        const trial = createSimState(probe);
        // Release on the next tick and see what it would have been worth.
        const shadow = createWorld(rig());
        stepSimulation(trial, swingInput({ action: false }), shadow, tick + 1);
        if (trial.chain > probe.chain) { opened = tick + 1; }
      }
    }
    assert.ok(opened > 0, "the speed window must open somewhere on the way down");
    assert.ok(Math.abs(opened - bottom) <= TETHER_RELEASE_WINDOW + 1,
      `the window opened at ${opened} but the arc bottom is at ${bottom}`);
  });

  it("pays speed and Chain at the bottom, and nothing at all outside the window", () => {
    const { heights } = swing(Infinity, 60);
    let bottom = 1;
    for (let i = 1; i < heights.length; i++) {
      if (heights[i] > heights[i - 1]) { bottom = i - 1; break; }
    }

    const timed = swing(bottom, bottom + 4).state;
    assert.strictEqual(timed.anchorId, 0, "releasing detaches");
    assert.strictEqual(timed.chain, CHAIN_MAX, "a point spent attaching, a point back");
    assert.ok(Math.hypot(timed.vx, timed.vz) > RUN_SPEED,
      "the bottom of the arc pays horizontal speed");

    // Far too early: still descending, nowhere near the bottom. No partial
    // credit, and the Chain point spent on the attach is simply gone.
    const early = swing(2, 8).state;
    assert.strictEqual(early.chain, CHAIN_MAX - 1, "an early release pays nothing back");
  });

  it("converts banked tension into height when let go on the way up", () => {
    const { heights } = swing(Infinity, 60);
    let bottom = 1;
    for (let i = 1; i < heights.length; i++) {
      if (heights[i] > heights[i - 1]) { bottom = i - 1; break; }
    }
    const late = bottom + TETHER_RELEASE_WINDOW + 4;

    // Two runs identical but for what the swing banked, released on the same
    // tick of the same arc. Comparing against a runner still on the rope would
    // compare two different things - they are still being driven up by it.
    const lifted = swing(late, late + 1);
    const empty = swing(late, late + 1, { }, false, 0);
    const banked = lifted.tensionAtRelease;
    assert.ok(banked > 2, `a real swing should bank more than ${banked.toFixed(2)}`);
    assert.ok(
      Math.abs((lifted.state.vy - empty.state.vy) - banked * TETHER_HEIGHT_RATE) < 1e-6,
      `height paid ${(lifted.state.vy - empty.state.vy).toFixed(3)}, not ` +
      `${(banked * TETHER_HEIGHT_RATE).toFixed(3)}`);
    assert.strictEqual(lifted.state.chain, CHAIN_MAX - 1,
      "height is the consolation, not the prize - it pays no Chain");
  });

  it("leaves a mistimed swing worse off than never having attached", () => {
    const mistimed = swing(2, 8).state;
    const control = runner();
    assert.ok(mistimed.chain < control.chain,
      "the Chain point is the price of the attempt");
    assert.ok(softCap(mistimed) < softCap(control),
      `a wasted swing lowers the soft cap: ${softCap(mistimed).toFixed(2)} vs ${softCap(control).toFixed(2)}`);
  });

  // ================================================================= netcode

  it("replays a whole attach, swing and release bit-identically", () => {
    const live = swing(28, 50, {}, false);
    const replayed = swing(28, 50, {}, true);
    assert.strictEqual(firstStateDifference(live.state, replayed.state), null,
      "a replayed swing must land on exactly the same state");
    assert.strictEqual(live.state.anchorId, 0, "the fixture must actually release");
  });

  it("holds the cooldown against a rapid re-press, replay included", () => {
    const level = rig();
    const world = createWorld(level);
    const state = runner();

    stepSimulation(state, swingInput(), world, 0);
    stepSimulation(state, swingInput({ action: false }), world, 1);
    assert.strictEqual(state.anchorId, 0);
    const cool = state.tetherCool;
    assert.strictEqual(cool, 1 + TETHER_COOL_TICKS);

    // Hammer the button for the whole cooldown. Nothing attaches.
    for (let tick = 2; tick < cool; tick++) {
      stepSimulation(state, swingInput({ action: tick % 2 === 0 }), world, tick, tick % 3 === 0);
      assert.strictEqual(state.anchorId, 0, `re-attached at tick ${tick}, before the cooldown`);
    }
  });

  it("drops the rope on a respawn without banking a free cooldown", () => {
    const level = rig();
    const world = createWorld(level);
    const state = runner();
    stepSimulation(state, swingInput(), world, 0);
    assert.notStrictEqual(state.anchorId, 0);

    stepSimulation(state, swingInput({ respawn: true }), world, 1);
    assert.strictEqual(state.anchorId, 0, "a respawn drops the rope");
    assert.strictEqual(state.tension, 0);
    assert.strictEqual(state.tetherCool, -1, "and does not charge the cooldown for it");
  });

  it("is the verb the press means only when there is an anchor to take", () => {
    // One wire bit, two verbs. An anchor in the cone claims the press; a press
    // with nothing in front of it is a shot, and the magazine proves which.
    const level = rig();
    const world = createWorld(level);

    const swinger = runner({ ammo: 4 });
    stepSimulation(swinger, swingInput(), world, 0);
    assert.notStrictEqual(swinger.anchorId, 0, "the anchor takes the press");
    assert.strictEqual(swinger.ammo, 4, "and no shot is spent taking it");

    const shooter = runner({ ammo: 4 });
    stepSimulation(shooter, swingInput({ yaw: at.yaw + Math.PI }), world, 0);
    assert.strictEqual(shooter.anchorId, 0);
    assert.strictEqual(shooter.ammo, 3, "with no anchor in the cone, the press fires");
  });

  it("stays out of a course whose mode withholds the verb", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const level = buildLevelWith(seed, { verbs: ["vault", "carve", "salvo"] });
      for (const s of level.sections) {
        assert.ok(!sectionById(s.id)!.requires.includes("tether"),
          `seed ${seed}: ${s.id} needs a tether the mode does not grant`);
      }
      const state = createSimState({ ...START, grounded: false });
      const world = createWorld(level);
      // And the verb itself is inert, so an anchor left over from a section
      // that does not require it cannot be used either.
      if (level.anchors.length > 0) {
        const a = level.anchors[0];
        state.x = a.x; state.y = a.y - 6; state.z = a.z - 6;
        stepSimulation(state, {
          ...idleInput, action: true,
          yaw: Math.atan2(a.x - state.x, a.z - state.z),
          pitch: -Math.atan2(a.y - state.y - SHOT_EYE, Math.hypot(a.x - state.x, a.z - state.z)),
        }, world, 0);
        assert.strictEqual(state.anchorId, 0, `seed ${seed}: the tether fired with the verb withheld`);
      }
    }
  });

  // =========================================================== level content

  it("keeps anchors inside the placement rules on every course", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const level = buildLevel(seed);
      const perSection = new Map<string, number>();
      for (const anchor of level.anchors) {
        // Nearest section by entry distance is good enough to count per-section
        // budgets: sections are 36-60 u apart and anchors sit inside one.
        let best = "";
        let bestDistance = Infinity;
        for (const s of level.sections) {
          const d = Math.hypot(anchor.x - s.x, anchor.z - s.z);
          if (d < bestDistance) { bestDistance = d; best = s.id; }
        }
        perSection.set(best, (perSection.get(best) ?? 0) + 1);
      }
      for (const [id, count] of perSection) {
        assert.ok(count <= 4, `seed ${seed}: ${id} carries ${count} anchors, over the budget of 4`);
      }
    }
  });

  it("hangs every anchor high enough to be worth swinging from", () => {
    for (let seed = 1; seed <= 120; seed++) {
      const level = buildLevel(seed);
      for (const anchor of level.anchors) {
        // Under a runner's own height an anchor is a handrail, not a swing.
        let ground = -Infinity;
        for (const s of level.solids) {
          if (Math.abs(s.x - anchor.x) > s.hx + 4 || Math.abs(s.z - anchor.z) > s.hz + 4) { continue; }
          ground = Math.max(ground, s.y + s.hy);
        }
        if (ground === -Infinity) { continue; }
        assert.ok(anchor.y - ground > 3,
          `seed ${seed}: an anchor hangs ${(anchor.y - ground).toFixed(1)} u over the floor`);
      }
    }
  });

  it("costs a swing about what a pendulum says it should", () => {
    // Sanity on the numbers rather than on the code: a 12.9 u rope under this
    // gravity has a quarter period near a second, so a swing is a beat inside a
    // section and not a way to cross one.
    const { state } = swing(Infinity, 2);
    const quarter = (Math.PI / 2) / Math.sqrt(GRAVITY / state.ropeLen);
    assert.ok(quarter * TICK_RATE < TETHER_MAX_TICKS,
      "the hard cap must not cut a normal swing short");
    assert.ok(TETHER_SPEED_GAIN < RUN_SPEED,
      "one release must not be worth more than a whole second of running");
    assert.ok(TETHER_TENSION_FLOOR > 0);
  });
});
