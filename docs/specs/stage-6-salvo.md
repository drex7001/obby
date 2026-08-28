# Stage 6 — The Salvo

**Risk** Low netcode / Medium balance · Ships the reward loop.

Design context: [GDD §5](../GDD.md#5--shooting--the-salvo) and
[§7](../GDD.md#7--rewards-and-economy).

---

## The loop

```
   run past a floating gun  ──►  4 shots
            │
            ▼
   shoot a breaker ahead   ──►  it changes / collapses / opens
            │
            ▼
        coins drop         ──►  stored energy
            │
            ▼
   spend mid-race          ──►  speed, a shield, a shortcut, a Recall
            │
            └──────────────────►  back into the chain
```

Four beats, each one a decision, and the last one feeds straight back into the
[GDD](../GDD.md) economy.

---

## Why it fits, rather than merely being addable

**Coins are stored energy.** That is the insight that makes this feature belong
rather than sit beside the game. Conversion says every verb moves energy between
forms with a timing window; a coin is horizontal speed you banked by spending
tempo on a shot, held until you convert it back. Shooting is not a second game
mode bolted onto a racer — it is another converter.

Which means the sink matters more than the source. See below.

**Aiming already costs you your line, for free.** The camera is the movement
frame — input is camera-relative in
[movement.ts](../../src/shared/movement.ts#L228). Turning to look at a target
turns your run. No artificial penalty is needed; the existing control scheme
prices aiming automatically. That is a rare piece of luck and the design should
lean on it rather than adding a firing tax on top.

**It is the safe line.** A player at 19 u/s in a chain cannot afford to aim. A
player who just fumbled and dropped to chain 0 can. So shooting naturally becomes
the recovering player's tool and dodging stays the fast player's — a rubber band
that emerges from the mechanics instead of being imposed on them, with neither
playstyle dominant.

---

## What can be shot

A distinct visual class — **breakers** — placed by section authors. Deliberately
*not* the hazards themselves by default; see Risk 1.

| Breaker | Effect | Class |
| --- | --- | --- |
| **Coin pod** | Drops 3 coins | B — tick stamp |
| **Weak point** | Disables one hazard for 5 s | B — the pressure-plate pattern exactly |
| **Support** | Collapses a gantry into a ramp, or drops a bridge | B |
| **Seal** | Opens a locked shortcut permanently for the round | B |
| **Crate** | Refills 2 shots | B |
| **Incoming projectile** | A turret shell, shot down mid-flight | A — pure function of tick |

That last row is the defence mechanism: Watcher turrets (stage 9) fire projectiles
that are a pure function of tick, so shooting one down is a **timing window** —
the same design language as Impact and Tether. Defence and offence are the same
verb at different moments.

### Ammo

Ammo is bad as a *tax* and good as a *resource*: with a pickup model, a finite
magazine is what makes "do I spend my last shot on this pod, or save it
for the seal ahead?" a real question. **4 shots per pickup, no reload, crates
refill 2.**

---

## Coins, and the part that needs deciding

A currency with no sink is a number going up, and players see through that in
about two races. This is the genuinely weak point of the proposal as stated, and
it is worth resolving before any of it is built.

**Recommendation: spend them inside the race.** A between-rounds sink needs
persistence (a database this project does not have) and, more importantly, it
moves the decision *out* of the moment where it is interesting.

| Sink | Cost | Why it earns its place |
| --- | --- | --- |
| **Burn** — convert coins to overspeed, +0.5 u/s each, instantly | any | The purest conversion. Coins *are* speed; this is the exchange rate |
| **Chain shield** — absorbs one fumbled Impact | 8 | Protects the thing the game is actually about |
| **Recall recharge** | 12 | A second life for the segment |
| **Seal key** — opens a locked shortcut without shooting it | 15 | Lets coins buy route access |

Cap the purse at 30 so hoarding is not a strategy, and so the decision is always
"spend now on what?" rather than "save for later".

**Burn is the one to build first.** It closes the loop with a single number and
proves whether the currency is fun before any of the other sinks are written.

---

## Multiplayer, without ever aiming at a person

Every competitive moment here comes from contested *objects*:

- **The gun pickup is contested.** One gun, two runners converging on it — that is
  a genuine race-within-the-race, and it happens on a spot the designer chose.
- **Breakers change the course for everyone behind you.** Collapse a support into
  a ramp and you have built a shortcut for your pursuer. Shoot a seal and you have
  opened a route you may not be able to defend. Every shot is a public act.
- **Coin pods are first-come** — with one anti-frustration rule below.
- **Weak points are shared.** Disabling a hazard for 5 s helps whoever is in the
  section, including the runner right behind you.

That last property is the interesting one: **shooting is generous by default.**
You cannot clear a path only for yourself. Deciding whether the person behind you
benefits more than you do is a real tactical read, and it makes a five-player
field feel like a field.

### The contested-pod rule

Two players shoot the same pod within 5 ticks: **both get coins.** This dissolves
the only fairness dispute the feature can generate — "I hit it first" — and it
costs nothing but a handful of coins. Anti-frustration beats strict arbitration
when the stake is small.

---

## Netcode

The whole feature is Class A and Class B. There is no player-position rewind
anywhere in it, because nothing is ever aimed at a player.

| Piece | Class | Notes |
| --- | --- | --- |
| Shot resolution | **A** | `raycastWorld()` (stage 0) against level geometry and pure-function obstacle poses at the shot's fractional tick. Identical on client prediction, on rollback replay, and on the server |
| Breaker destroyed | **B** | A `breakerTicks` array, structurally identical to `crumbleTicks` |
| Pickup taken / respawning | **B** | Tick stamp; respawns 20 s after |
| Ammo count | **A** | Simulated, predicted, in `SIM_FIELDS` |
| Coins | **D** | Server-owned. The client may show an optimistic +3 and accept correction |
| Spending coins | **B** | The purchase is a server-validated stamp; the *effect* (an overspeed burst) is applied by the victim's own deterministic step |

**Aim assist can be generous** — a 4° cone is fine — precisely because there is no
opposing player to feel cheated. Assist against world geometry is a usability
feature; assist against players would be a fairness argument. This is the whole
reason shooting the world is cheap and shooting people is not.

### State

| Field | Type | Where |
| --- | --- | --- |
| `ammo` | `uint8` | `SimState` + schema + `SIM_FIELDS` |
| `fireCool` | `int32` | tick stamp |
| `coins` | `uint8` | `Player` only — Class D |
| `shieldUntil` | `int32` | tick stamp, from the chain shield |
| `breakerTicks` | `int32[]` | `RaceState`, mirrored server-side like `crumbleTicks` |
| `pickupTicks` | `int32[]` | `RaceState` |

Wire cost: ~2 bytes/tick/player plus stamps on the rare tick something breaks.

---

## The two real risks

### Risk 1 — Shooting could delete the obstacle course

The serious one. If you can destroy the thing you were meant to dodge, the game's
central skill becomes optional, and "did I pick up the gun" replaces "can I time
the pendulum."

**Three rules that prevent it:**

1. **Breakers are a separate prop class from hazards.** A pendulum is not
   shootable. Its *housing* might be, and hitting that disables it for 5 seconds —
   a window, not a deletion.
2. **Every shootable effect is temporary or positional**, never "the obstacle is
   gone." Disable for 5 s, open a route, drop a ramp. The course is modified, not
   removed.
3. **A section must be completable with no gun at all.** Enforced by the bot sweep
   (stage 10) running every seed with the gun disabled.

### Risk 2 — Attention budget

At 19 u/s with an Impact window every 0.8 s, "aim at a thing" competes for the
same attention as the landing beat. This is real, and it is why big forgiving
targets and a generous assist cone matter more here than in any shooter.

**Mitigation:** require *decision*, not precision. The skill is choosing what to
shoot and when to spend the tempo — never whether you can hit a small thing while
moving.

---

## Acceptance criteria

- [ ] A shot resolves identically on client prediction, on rollback replay, and on
      the server, at 0 ms and 200 ms simulated latency.
- [ ] Every generated course is completable with the gun disabled — bot sweep,
      1000 seeds.
- [ ] No shootable effect permanently removes a hazard.
- [ ] Two players hitting one pod within 5 ticks both receive coins.
- [ ] A breaker stamp arriving late produces a bounded correction, never a
      teleport (engineering.md).
- [ ] Ammo is bit-identical on replay; firing cannot be spammed past the cooldown
      under rollback.
- [ ] Burn converts coins to overspeed at exactly +0.5 u/s each and is not clamped
      on the frame it fires.
- [ ] An optimistic client-side coin award that the server denies resolves without
      a visible HUD snap.
- [ ] A turret projectile can be shot down mid-flight, and the window is ≥ 8 ticks
      wide at typical engagement range.

## Build order

1. **Gun pickup, 4 shots, coin pods, Burn.** The complete loop with one breaker
   type and one sink. Ship it, play it, find out whether shooting-while-racing is
   fun at all.
2. Weak points — the first breaker that changes a hazard rather than dropping
   loot.
3. Supports and seals — breakers that change *routes*, which is where the
   multiplayer interest is.
4. Crates, chain shield, Recall recharge.
5. Shooting down projectiles, once Watchers (stage 9) exist.

Step 1 is small enough to sit inside the vertical slice if you want it there —
the raycast helper (stage 0) is the only prerequisite, and it is about forty lines.

---

