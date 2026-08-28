# Stage 9 — Threats: Watchers and enemies

**Risk** Low (Watchers) / Low–Medium (enemies) · Ships a hostile course.

Design context: [GDD §6](../GDD.md#6--threats). Build in the order below; each
step is cheaper than the next and may make it unnecessary.

---

# Part 1 · The Watchers

New obstacle kinds that read as alive but are **pure functions of tick**, so they
cost zero bytes and carry no netcode risk. They fit the existing `Obstacle` union,
the existing renderer path, and the existing hazard collision.

| Watcher | Kinematics | Effect |
| --- | --- | --- |
| **Turret** | Shell position = `f(fireTick, tick)` — a parabola from a fixed muzzle on a fixed cycle | Hazard hit: knockback + stun |
| **Sentry** | A beam volume swept by `sin(t)` on a fixed period | Stun, no knockback — it slows rather than launches |
| **Jaws** | Two solids closing and opening on a period | Hard block while shut; the classic timing gate |
| **Hunter** | A hazard on a fixed patrol with a searching animation | Reads as alive; is a slider with better art |
| **Nest** | Static, emits Shamblers on a fixed cycle | An obstacle with a spawn schedule |
| **Swarm** | A hazard field activated by a plate or trap stamp | Class B — no new machinery |

The only genuinely new work is a **projectile hazard collider** — a moving sphere
or small box — and its mirrored-geometry test.

**Build these first and see how much of "the course is hostile" is already
there.** Players do not experience "is this reactive?"; they experience "is this
dangerous and readable?". Whatever is still missing after the Watchers is the
actual case for enemies, and it will be a far better-informed case.

- [ ] A turret shell's position is a pure function of tick.
- [ ] The shell's hitbox passes a mirrored-geometry test.
- [ ] Every Watcher is readable ≥ 1.2 s ahead at chain-8 speed.
- [ ] Zero new synced state for turret, sentry, jaws, hunter, nest.

---

# Part 2 · Enemies

Two tiers. **Tier 1 is most of the value.**

| | Tier 1 — hazard | Tier 2 — solid |
| --- | --- | --- |
| Knocks and stuns | Yes | Yes |
| Can be stood on / blocked by | **No** | **Yes** |
| Client shows it by | dead reckoning | evaluating a published path |
| Hit resolution | `rewind.lastSeenBy()` — built in | pure function, no rewind |
| Class | C | B+ |
| Cost | **~20 lines** | schema + pure function + AI loop |

## What Colyseus gives you

Lag compensation [ships with Colyseus 0.18](https://docs.colyseus.io/netcode/lag-compensation).

```ts
class RaceRoom extends Room {
  rewind = this.allowRewindState({ maxRewindMs: 500 });

  onCreate() {
    this.rewind.attachAll(this.state.players, { fields: ["x", "z"] });
    this.rewind.attachAll(this.state.enemies, { fields: ["x", "z"], mode: "reckon" });
  }

  fire(shooterId, ray) {
    const seen = this.rewind.lastSeenBy(shooterId);
    // seen.value(target, "x") — the world as that client last saw it
  }
}
```

The framework records attached entities on every broadcast and `lastSeenBy()`
returns the world as that client last saw it, clamped to `[now − maxRewindMs, now]`
for anti-spoofing. Inputs carry the render-time stamp automatically.

**The project is already configured the way it expects.** The client runs
`predict.attachAll("players", { mode: "lerp", smoothMs: REMOTE_INTERP_MS })`, and
`REMOTE_INTERP_MS = 90` *is* the interpolation buffer the stamp binds to.

**The footgun:** the timeline mode must match what the client displays. Players are
lerped ⇒ `"snapshot"`. Enemies are dead-reckoned ⇒ `"reckon"`. Mismatching them
causes double-compensation and silently wrong hits.

## What rewind does not solve

Rewind answers *"was my shot a hit?"* — a **hit-resolution** problem, now
essentially free.

A **solid** enemy is a different problem: **collision under prediction**. The
client predicts its body forward past what the server has acknowledged and replays
on every rollback, so it needs the enemy's position at ticks the server has not
simulated yet. Rewind reconstructs the past; prediction needs the future.

Dead reckoning is a *guess* at that future — fine for drawing an enemy, fine for
hit resolution (the server rewinds to the same guess), **not** fine for standing on
one. A wrong guess about a soft impulse costs centimetres and heals; a wrong guess
about a surface costs metres and snaps.

## Tier 1 — hazard enemies

```ts
const Enemy = schema({
  id: t.uint16(),
  kind: t.uint8(),
  x: t.number().default(0), y: t.number().default(0), z: t.number().default(0),
  vx: t.number().default(0), vz: t.number().default(0),   // for dead reckoning
  yaw: t.number().default(0),
  action: t.uint8().default(0),   // 0 idle · 1 walk · 2 wind-up · 3 lunge · 4 recover
  alive: t.boolean().default(true),
  downUntil: t.int32().default(-1),
});
```

Interaction runs in the **same sub-step slot as the existing player shove**, whose
ordering is already proven deterministic: overlap ⇒ knockback + `STUN_TICKS` +
chain break. Never a surface, never a blocker; the predicted body passes through
if it must.

The AI ticks in the room's fixed step, outside the schema proxies, mirrored into
state — the pattern `crumbleTicks` already uses.

| Kind | Behaviour |
| --- | --- |
| **Shambler** | Walks toward the nearest runner. Slow, relentless, easy to route around, exhausting to ignore |
| **Lurcher** | Idles until a runner enters a radius, winds up 0.5 s, lunges along a fixed line |

## Tier 2 — solid enemies, via committed paths

Only if playtesting says the course needs an enemy you can be *blocked* by.

The server publishes a short **committed path** rather than a position:

```ts
const EnemyCommit = schema({
  fromTick: t.int32().default(-1),   // ALWAYS in the future when published
  toTick:   t.int32().default(-1),
  x0: t.number(), y0: t.number(), z0: t.number(),
  dx: t.number(), dz: t.number(),
  speed: t.number(),
  turn: t.number().default(0),       // rad/s — an arc without control points
  action: t.uint8().default(0),
});
```

Both ends compute the pose with a pure function, allocation-free, taking a
**fractional** tick so it can be sampled inside a sub-step — identical in contract
to the existing `poseAt()`:

```ts
export function enemyPoseAt(e: Enemy, tick: number, out: Pose): Pose;
```

Before `fromTick` it returns the start pose; after `toTick` it holds the end pose
until the next commit lands.

**The rule that makes it safe:** a commit is always published to take effect in the
future, by more than a worst-case round trip — `COMMIT_LEAD` ≈ 15 ticks (500 ms).
Nobody ever evaluates a path they have not received. Same principle as
`HINGE_SWING_TICKS`: the bridge takes 0.9 s to move precisely so a late stamp
cannot teleport geometry into a player.

**The convergence worth noticing.** That lead caps reactivity at half a second,
which on screen reads as something heavy that telegraphs and follows through —
exactly what a good threat should do anyway. When a technical limit and a design
requirement point the same way, the design is usually right.

| Kind | Behaviour |
| --- | --- |
| **Bulwark** | Slow solid that blocks a lane and must be routed around or shot down |

## Shooting enemies

**Tier 1:** the built-in rewind, `mode: "reckon"`.

**Tier 2:** no rewind at all. If position at tick `T` is *derivable*, the client
resolves the shot with `raycastWorld()` plus `enemyPoseAt(e, T)` and sees the hit
instantly; the server evaluates the same function at the same tick and agrees. A
position that can be recomputed never has to be remembered.

Either way the server validates that `T` is within a sane window of the room tick
and the ray is plausible from the shooter's authoritative position.

---

## Budgets

| | Ceiling |
| --- | --- |
| Live enemies per room | 16 |
| Tier 1 wire cost | ~28 B per enemy per patch, only while moving |
| Tier 2 re-commits | ≤ 4/s per enemy while tracking |
| `maxRewindMs` | 500 (default; `REMOTE_INTERP_MS = 90` plus headroom) |
| Server AI | ≤ 0.3 ms/tick for a full field |

## Failure modes

| Failure | Mitigation |
| --- | --- |
| Rewind mode mismatched to display | The documented footgun. Players `"snapshot"`, enemies `"reckon"`, asserted in a test |
| A tier-2 commit arrives after `fromTick` | Hold the previous end pose and blend over ~6 ticks. Bounded, and rare because of the lead |
| Clock drift past `COMMIT_LEAD` | `rebase()` holds drift inside `REBASE_DEADBAND` (2 ticks); a lead of 15 is 7× that |
| A solid enemy traps a player | Solid kinds must never fully block the line — a level rule, tested by the bot sweep |
| Enemy count spikes | Hard cap 16; oldest despawns |

## Acceptance

- [ ] Players attach `"snapshot"`, enemies `"reckon"`; a shot at a moving enemy
      resolves within one radius of what the shooter saw.
- [ ] A hazard enemy never becomes a surface — drive a player into one at full
      speed from eight angles and assert no grounding.
- [ ] No commit is ever published with `fromTick <= state.tick`.
- [ ] A solid enemy can be stood on and walked into with no reconciliation snap at
      120 ms.
- [ ] A deliberately withheld commit produces a bounded blend, never a teleport.
- [ ] No enemy holds a player stationary longer than `STUN_TICKS`.
- [ ] Full `SimState` equality on replay with enemies active.
- [ ] The bot sweep completes courses containing every threat kind.

## Build order

1. **Watchers.** Stop here if the answer is already yes.
2. **Tier 1: Shambler**, then **Lurcher** — the wind-up/commit/recover cycle is
   where the character comes from, and it is worth more than a second creature.
3. **Enable `allowRewindState`** and wire shooting enemies.
4. **Tier 2: Bulwark**, only if a *solid* enemy is what is missing.
