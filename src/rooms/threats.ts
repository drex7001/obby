/**
 * The enemy field: spawning, despawning, and the AI that publishes commits.
 *
 * This runs in the room's fixed step, outside the schema proxies, and is
 * mirrored into state - the pattern `crumbleTicks` already uses. Nothing here
 * is ever read by the simulation directly; what the simulation reads is the
 * committed arc on each enemy, which both ends evaluate with `enemyPoseAt()`.
 *
 * The single rule everything else follows from: **a commit takes effect
 * `COMMIT_LEAD` ticks in the future**, so no client is ever asked to evaluate a
 * path it has not received. Every decision this class makes is therefore a
 * decision about where an enemy should be half a second from now, which is also
 * why the enemies read as heavy things that telegraph and follow through.
 */

import {
  BULWARK_SPEED, COMMIT_LEAD, COMMIT_SPAN, ENEMY_DOWN_TICKS, ENEMY_LEASH,
  ENEMY_MAX, LURCHER_LUNGE_SPEED, LURCHER_LUNGE_TICKS, LURCHER_RECOVER_TICKS,
  LURCHER_WAKE_RADIUS, LURCHER_WINDUP_TICKS, NEST_PERIOD_TICKS, SHAMBLER_SPEED,
} from "../shared/constants.js";
import {
  BULWARK, enemyPoseAt, enemyShape, IDLE, LUNGE, LURCHER, RECOVER, SHAMBLER,
  WALK, WINDUP, type EnemyView,
} from "../shared/enemies.js";
import type { Level } from "../shared/level.js";
import { makePose } from "../shared/obstacles.js";

/** What the AI is allowed to know about a runner. Position and nothing else. */
export interface ThreatTarget {
  x: number; y: number; z: number;
  live: boolean;
}

interface EnemyRecord extends EnemyView {
  hp: number;
  downUntil: number;
  /** Set whenever a field the schema mirrors has changed. */
  dirty: boolean;
  /** Kept out of the schema: the AI's own bookkeeping. */
  homeX: number; homeZ: number;
  patrol: number;
}

const pose = makePose();

export class Threats {
  private list: EnemyRecord[] = [];
  private nextId = 1;
  /** Per nest obstacle id: the tick its next brood is due. */
  private nests = new Map<number, number>();

  /** Everything the shared step and the renderer need. */
  get enemies(): readonly EnemyView[] { return this.list; }

  /** A new round is a new field. Nothing survives a course change. */
  reset(level: Level, tick: number) {
    this.list = [];
    this.nextId = 1;
    this.nests.clear();
    for (const ob of level.obstacles) {
      if (ob.kind !== "nest") { continue; }
      // Staggered by the nest's own phase, so a course with two of them does
      // not breathe in unison.
      this.nests.set(ob.id, tick + Math.round(NEST_PERIOD_TICKS * (ob.phase ?? 0)) + COMMIT_LEAD);
    }
    for (const spawn of level.spawns) {
      this.spawn(spawn.kind, spawn.x, spawn.y, spawn.z, tick);
    }
  }

  /** One tick of AI. `targets` is every runner still in the race. */
  update(level: Level, tick: number, targets: readonly ThreatTarget[]) {
    for (const ob of level.obstacles) {
      if (ob.kind !== "nest") { continue; }
      const due = this.nests.get(ob.id) ?? Infinity;
      if (tick < due) { continue; }
      this.nests.set(ob.id, tick + NEST_PERIOD_TICKS);
      // A nest only bothers while somebody is near enough for it to matter.
      if (this.near(ob.px, ob.pz, targets, ENEMY_LEASH) && this.list.length < ENEMY_MAX) {
        this.spawn(SHAMBLER, ob.px, ob.py, ob.pz, tick);
      }
    }

    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      if (!e.alive && tick > e.downUntil) { this.list.splice(i, 1); continue; }
      if (!e.alive) { continue; }

      // Nothing chases the field off the end of the course.
      enemyPoseAt(e, tick, pose);
      if (!this.near(pose.x, pose.z, targets, ENEMY_LEASH)) {
        this.list.splice(i, 1);
        continue;
      }
      // Re-commit as the current arc runs out, and never any later than that:
      // the whole guarantee is that the arc a client is evaluating right now
      // has been in its hands for half a second already.
      if (tick + COMMIT_LEAD >= e.toTick) { this.commit(e, tick, targets); }
    }
  }

  /** A shot connected. Returns true if this put the enemy down. */
  hit(id: number, tick: number): boolean {
    const e = this.list.find((x) => x.id === id);
    if (!e || !e.alive) { return false; }
    e.hp -= 1;
    e.dirty = true;
    if (e.hp > 0) { return false; }
    e.alive = false;
    e.downUntil = tick + ENEMY_DOWN_TICKS;
    return true;
  }

  /** Everything the room has to mirror, with the untouched ones skipped. */
  takeDirty(): EnemyRecord[] {
    const out = this.list.filter((e) => e.dirty);
    for (const e of out) { e.dirty = false; }
    return out;
  }

  get records(): readonly EnemyRecord[] { return this.list; }

  // ------------------------------------------------------------------ internals

  private spawn(kind: number, x: number, y: number, z: number, tick: number) {
    if (this.list.length >= ENEMY_MAX) { return; }
    const e: EnemyRecord = {
      id: this.nextId++,
      kind,
      alive: true,
      action: IDLE,
      fromTick: tick + COMMIT_LEAD,
      toTick: tick + COMMIT_LEAD + COMMIT_SPAN,
      x0: x, y0: y, z0: z,
      dx: 0, dz: 1,
      speed: 0,
      turn: 0,
      hp: enemyShape(kind).hp,
      downUntil: -1,
      dirty: true,
      homeX: x, homeZ: z,
      patrol: 1,
    };
    this.list.push(e);
  }

  /**
   * Publish the next arc.
   *
   * Every branch below decides where the enemy should be *half a second from
   * now*, because that is when the commit starts. It is why a Lurcher's lunge
   * has to be aimed at where a runner is going rather than where they are, and
   * why the whole field reads as deliberate rather than twitchy.
   */
  private commit(e: EnemyRecord, tick: number, targets: readonly ThreatTarget[]) {
    const from = Math.max(tick + COMMIT_LEAD, e.toTick);
    enemyPoseAt(e, from, pose);
    const x = pose.x, z = pose.z;

    e.x0 = x; e.z0 = z;
    e.fromTick = from;
    e.turn = 0;
    e.dirty = true;

    const target = this.nearest(x, z, targets);

    switch (e.kind) {
      case LURCHER: {
        // Idle, wind up, lunge, recover. The cycle is where the character
        // comes from - a creature that simply chased would be a Shambler.
        if (e.action === WINDUP) {
          e.action = LUNGE;
          e.speed = LURCHER_LUNGE_SPEED;
          e.toTick = from + LURCHER_LUNGE_TICKS;
        } else if (e.action === LUNGE) {
          e.action = RECOVER;
          e.speed = 0;
          e.toTick = from + LURCHER_RECOVER_TICKS;
        } else if (target && this.distance(x, z, target) < LURCHER_WAKE_RADIUS) {
          e.action = WINDUP;
          e.speed = 0;
          this.face(e, x, z, target.x, target.z);
          e.toTick = from + LURCHER_WINDUP_TICKS;
        } else {
          e.action = IDLE;
          e.speed = 0;
          e.toTick = from + COMMIT_SPAN;
        }
        break;
      }

      case BULWARK: {
        // Slow, solid, and across the lane rather than along it: something to
        // be routed around or shot down, never something that plugs the line.
        const drift = Math.hypot(x - e.homeX, z - e.homeZ);
        if (drift > 7) { e.patrol = -e.patrol; }
        const away = Math.atan2(x - e.homeX, z - e.homeZ) + Math.PI / 2 * e.patrol;
        e.dx = Math.sin(away);
        e.dz = Math.cos(away);
        e.speed = BULWARK_SPEED;
        e.turn = 0.22 * e.patrol;
        e.action = WALK;
        e.toTick = from + COMMIT_SPAN;
        break;
      }

      default: {
        // Shambler. Slow, relentless, easy to route around, exhausting to
        // ignore - and it walks at where you will be, not where you are.
        if (target) {
          this.face(e, x, z, target.x, target.z);
          e.speed = SHAMBLER_SPEED;
          e.action = WALK;
        } else {
          e.speed = 0;
          e.action = IDLE;
        }
        e.toTick = from + COMMIT_SPAN;
        break;
      }
    }
  }

  private face(e: EnemyRecord, x: number, z: number, tx: number, tz: number) {
    const dx = tx - x, dz = tz - z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) { return; }
    e.dx = dx / len;
    e.dz = dz / len;
  }

  private distance(x: number, z: number, t: ThreatTarget) {
    return Math.hypot(t.x - x, t.z - z);
  }

  private nearest(x: number, z: number, targets: readonly ThreatTarget[]): ThreatTarget | null {
    let best: ThreatTarget | null = null;
    let bestDistance = Infinity;
    for (const t of targets) {
      if (!t.live) { continue; }
      const d = this.distance(x, z, t);
      if (d < bestDistance) { bestDistance = d; best = t; }
    }
    return best;
  }

  private near(x: number, z: number, targets: readonly ThreatTarget[], within: number) {
    const t = this.nearest(x, z, targets);
    return t !== null && this.distance(x, z, t) <= within;
  }
}
