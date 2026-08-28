# Stage 1 — Momentum

**Risk** Medium · Ships the same game with a body that has weight.

**Implementation status — implemented; acceptance validation ongoing.** The shared simulation now runs three
sub-steps and implements the specified falloff acceleration, directional target
scaling, slope acceleration, and overspeed decay. Automated coverage lives in
[`momentum.test.ts`](../../test/stages/momentum.test.ts). The twenty-round feel
gate remains a deliberate manual tuning check.

Design context: [GDD §2](../GDD.md#2--the-player). **No schema change at all** —
this stage is physics inside the existing step plus a constants file. Overspeed
needs no field: it is just velocity above the cap, and velocity is already synced.

---

## The problem

```
body.vx += (targetX - body.vx) * min(1, GROUND_ACCEL * dt / RUN_SPEED)
```

With `GROUND_ACCEL = 92`, `dt = 1/60` and `RUN_SPEED = 9.6`, that closes **16% of
the velocity gap per sub-step** — top speed in ~0.1 s. `GROUND_FRICTION = 13`
bleeds ~22% per sub-step, so you stop in ~0.06 s.

Stopping is free. Turning is free. You are at 0 or at 9.6, and a smooth runner and
a stuttery runner arrive together.

---

## Implementation

All of it inside `subStep()` in
[movement.ts](../../src/shared/movement.ts#L215).

### Asymmetric acceleration — section 2

```
accel = GROUND_ACCEL * (1 - ACCEL_FALLOFF * clamp(speed / softCap, 0, 1))
```

Near-current responsiveness at rest, which is what keeps fine adjustment near
hazards viable. At 90% of cap you are pushing against a wall, so the last tenth
has to be *held*.

### Directional scaling — section 2

Scale the target speed by the angle between facing and movement: forward 1.00,
strafe 0.82, backward 0.65. Derived from `cmd.yaw`, which is already simulated
and already on the wire.

### Overspeed decay — new, immediately after section 2

```
softCap = BASE_SPEED                    // chain arrives in stage 2
if (speed > softCap) speed -= OVERSPEED_DECAY * dt
```

**Decay, never clamp.** A hard clamp deletes every speed mechanic in later stages
before it exists — a tether release, a downhill, a draft would each produce speed
thrown away on the next tick.

### Slope acceleration — new, after the ramp resolve in section 5

```
if (onRamp) applyAlongSlope(GRAVITY * SLOPE_ACCEL_SCALE)
```

Ramps already exist as first-class geometry. Downhill pays past the soft cap;
uphill charges. About fifteen lines against geometry that is already there.

### Overspeed at this stage

Only two sources exist yet, and both are free:

| Source | Gain |
| --- | --- |
| Downhill slope | +1 to +3 while descending |
| A Carousel pusher taken from behind | +3 |

The second is not designed — it falls out of removing the clamp. Existing hazards
become speed sources when taken correctly. Expect more; treat them as features.

---

## Constants

| Constant | Today | Stage 1 |
| --- | --- | --- |
| `SUB_STEPS` | 2 | **3** |
| `MAX_SPEED` | — | **30** |
| `BASE_SPEED` (`RUN_SPEED`) | 9.6 | **10.5** |
| `GROUND_ACCEL` | 92 | **34** |
| `ACCEL_FALLOFF` | — | **0.6** |
| `GROUND_FRICTION` | 13 | **5.5** |
| `AIR_DRAG` | 0.35 | **0.18** |
| `AIR_ACCEL` | 34 | **38** |
| `GRAVITY` | 34 | **30** |
| `JUMP_SPEED` | 12.4 | **13.2** |
| `FALL_GRAVITY_MULT` | 1.35 | **1.5** |
| `STRAFE_SCALE` | — | **0.82** |
| `BACK_SCALE` | — | **0.65** |
| `SLOPE_ACCEL_SCALE` | — | **0.55** |
| `OVERSPEED_DECAY` | — | **4.5 u/s²** |

**Protect the 0.8-second airtime.** Apex 2.9 u at 0.44 s up, 0.36 s down. That is
one landing beat every 0.8 s — about 75 BPM — and it is the tempo the whole game
is built on. Tune everything else around keeping it.

### The tunnelling constraint

`MAX_SPEED` is a collision limit, not a taste one, and it wants the same reasoning
`constants.ts` already applies to fall speed.

At `SUB_STEPS = 3` the sim integrates at 90 Hz, so per-sub-step travel is
`speed / 90`. A capsule is detected while `|localX| < hx + PLAYER_RADIUS`, so the
band for the thinnest geometry in the course (a 0.8-thick divider) is
`2 × (0.4 + 0.42) = 1.64 u`.

| Speed | Travel/sub-step | Margin |
| --- | --- | --- |
| 13.4 u/s (chain 8, stage 2) | 0.15 u | 11× |
| 30 u/s (hard cap) | 0.33 u | 4.9× |
| 74 u/s | 0.82 u | 2× — the theoretical edge |

Generous, unlike the vertical case — but **assert it with a test**, never assume.
Raising `MAX_SPEED` past ~45 needs a fourth sub-step.

---

## Acceptance

- [ ] Standstill to 90% of soft cap takes 0.32–0.40 s.
- [ ] Releasing input from full speed coasts 0.9–1.2 m before dropping below 30%.
- [ ] Strafing tops at 82% of forward; backpedalling at 65%.
- [ ] Overspeed from a downhill is **never clamped** on the frame it is produced,
      and decays at 4.5 u/s².
- [ ] Uphill costs measurable speed; the Climb is slower than flat ground.
- [ ] **No tunnelling at `MAX_SPEED`** against the thinnest geometry across a
      1000-seed sample, driven into every wall from eight angles.
- [ ] Full `SimState` equality on replay, with overspeed active **across a
      sub-step boundary** — the likeliest place to diverge.
- [ ] The existing jump-height test still passes; vertical tuning is untouched.
- [ ] Two players of equal execution, one managing momentum deliberately, differ
      by 5–8 s over a full course.

## Risks

| Risk | Mitigation |
| --- | --- |
| **Sluggish or imprecise near hazards** | The falloff curve exists for this. Tune `ACCEL_FALLOFF` first; do not raise the base accel back |
| Overspeed breaks a section's timing | Pendulum Pass punishing overspeed is *correct*. A section that becomes impossible is a level fix, not a system fix |
| Tunnelling | Hard cap 30, explicit test, a fourth sub-step if it ever rises past ~45 |

## The gate

Play twenty rounds. Does holding a line feel good? Does stopping hurt? Is the
course still fair near hazards? **Do not proceed until this is right** — every
later stage assumes momentum feels good, and re-tuning it afterwards is a
breaking change wearing a different hat.
