# Gauntlet Run — Design Documents

Four documents and eleven specs. Nothing here is implemented yet.

| | |
| --- | --- |
| **[GDD.md](GDD.md)** | **What the game is.** Identity, the player, the five verbs, the map, shooting, threats, the reward economy, multiplayer, failure, modes. Start here. |
| **[stages.md](stages.md)** | **What to build, in what order.** Twelve stages; each ships a playable game and none invalidates the one before it. |
| **[engineering.md](engineering.md)** | **What a mechanic must survive.** What may hard-collide, what must be telegraphed, what may never be predicted. |
| **[decisions.md](decisions.md)** | Settled decisions, one line each — including two reversals and the corrections behind them. Not part of the GDD. |
| [specs/](specs/) | Implementation detail per stage: schemas, constants, netcode, acceptance criteria. |

## The game in one paragraph

Two to six runners, one line through a hostile course, and the whole game is how
well you carry speed through it. Speed is not a stat you have — it is energy you
move between forms, and it leaks at every handoff you fumble. Vault converts
horizontal to vertical; Carve converts it to distance; Tether stores it; Impact —
the landing, every 0.8 seconds, on a ±4 tick window — either keeps it or throws it
away. Chain those conversions and your top speed rises; break the chain and it
collapses. You interfere with other runners not by damaging them but by breaking
their chain, and you interfere with the course by shooting it.

## Specs by stage

| Stage | Spec | Ships |
| --- | --- | --- |
| 0 | [stage-0-foundations.md](specs/stage-0-foundations.md) | Fuzz harness, input packet, tick stamps, shared raycast |
| 1 | [stage-1-momentum.md](specs/stage-1-momentum.md) | Acceleration curve, soft cap, overspeed, slopes |
| 2 | [stage-2-impact.md](specs/stage-2-impact.md) | **The landing and the Chain — the vertical slice** |
| 3 | [stage-3-carve.md](specs/stage-3-carve.md) | Carve, carve hop, air control, launch start |
| 4 | [stage-4-generator.md](specs/stage-4-generator.md) | Section registry, turning cursor, generation validity |
| 5 | — | Content, authored to stage 4's contract |
| 6 | [stage-6-salvo.md](specs/stage-6-salvo.md) | Gun pickup, breakers, coins |
| 7 | [stage-7-tether.md](specs/stage-7-tether.md) | The elastic tether and its release window |
| 8 | [stage-8-recall.md](specs/stage-8-recall.md) | The recovery verb |
| 9 | [stage-9-threats.md](specs/stage-9-threats.md) | Watchers, then enemies |
| 10 | [stage-10-meta.md](specs/stage-10-meta.md) | Series, splits, bots, replays, interference |
| 11 | [stage-11-variation.md](specs/stage-11-variation.md) | Mutators, modes, progression |

## Where to look

| Looking for | Go to |
| --- | --- |
| What the game *is* | [GDD §1](GDD.md#1--identity) |
| Movement physics and every tuning number | [GDD §2](GDD.md#2--the-player) |
| The five verbs | [GDD §3](GDD.md#3--mechanics--the-five-verbs) |
| The course, sections, level-design rules | [GDD §4](GDD.md#4--the-map) |
| Guns, breakers, coins | [GDD §5](GDD.md#5--shooting--the-salvo) |
| Obstacles, Watchers, enemies | [GDD §6](GDD.md#6--threats) |
| The reward economy | [GDD §7](GDD.md#7--rewards-and-economy) |
| What other players do to you | [GDD §8](GDD.md#8--multiplayer) |
| Why a mechanic is or is not allowed | [engineering.md](engineering.md) |

## If you build three things

**Stages 0, 1 and 2.** The safety net, momentum, and the landing. That is the
whole thesis, it is playable, and it answers the only question that has to be true
before the rest is worth building: *is landing fun?*
