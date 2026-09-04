/**
 * Enemy meshes.
 *
 * Deliberately separate from `Course`: the course is rebuilt once a round and
 * then only posed, whereas the enemy field appears and disappears mid-race. The
 * pool below is sized once at `ENEMY_MAX` and never grows, so a nest emptying
 * itself into the course costs no allocation at all.
 *
 * Everything drawn here comes from `enemyPoseAt()` - the same function the
 * simulation collides with - so what you see and what you hit cannot disagree.
 */

import { Color3 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";

import { COMMIT_LEAD, ENEMY_MAX } from "../../shared/constants.js";
import { enemyPoseAt, enemyShape, LUNGE, WINDUP, type EnemyView } from "../../shared/enemies.js";
import { makePose, type Pose } from "../../shared/obstacles.js";
import { meshYaw, type Stage } from "./scene.js";

const pose: Pose = makePose();

interface Slot {
  body: Mesh;
  /** The eye: it is what makes a Watcher read as looking at you. */
  eye: Mesh;
  kind: number;
}

export class Threats {
  private stage: Stage;
  private slots: Slot[] = [];
  private materials = new Map<number, StandardMaterial>();

  constructor(stage: Stage) {
    this.stage = stage;
    for (let i = 0; i < ENEMY_MAX; i++) {
      const body = MeshBuilder.CreateBox(`enemy-${i}`, { size: 1 }, stage.scene);
      body.isPickable = false;
      body.setEnabled(false);
      stage.castsAndReceives(body, true, false);

      const eye = MeshBuilder.CreateBox(`enemy-eye-${i}`, { size: 1 }, stage.scene);
      eye.isPickable = false;
      eye.setEnabled(false);
      eye.material = stage.flatMaterial("enemy-eye", "#ffd166", 0.9, 0);

      this.slots.push({ body, eye, kind: -1 });
    }
  }

  private material(kind: number): StandardMaterial {
    const cached = this.materials.get(kind);
    if (cached) { return cached; }
    const mat = this.stage.material(enemyShape(kind).style);
    this.materials.set(kind, mat);
    return mat;
  }

  /**
   * Pose every live enemy at `tick`.
   *
   * A wind-up rears back and a lunge leans in. Both are read straight off
   * `action`, which is published half a second before the arc it belongs to
   * starts - so the tell is always on screen before the thing it tells you
   * about happens, which is the whole reason the commit lead is a feature.
   */
  update(enemies: readonly EnemyView[], tick: number) {
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      const e = enemies[i];
      if (!e || !e.alive) {
        slot.body.setEnabled(false);
        slot.eye.setEnabled(false);
        continue;
      }

      const shape = enemyShape(e.kind);
      if (slot.kind !== e.kind) {
        slot.kind = e.kind;
        slot.body.material = this.material(e.kind);
      }

      enemyPoseAt(e, tick, pose);
      const lean = e.action === WINDUP ? -0.28 : e.action === LUNGE ? 0.34 : 0;

      slot.body.setEnabled(true);
      slot.body.scaling.set(shape.radius * 2, shape.height, shape.radius * 2);
      slot.body.position.set(pose.x, pose.y + shape.height / 2, pose.z);
      slot.body.rotation.y = meshYaw(pose.yaw);
      slot.body.rotation.x = lean;

      // The eye sits on the front face and looks where the enemy is going.
      slot.eye.setEnabled(true);
      slot.eye.scaling.set(shape.radius * 0.9, 0.16, 0.12);
      slot.eye.position.set(
        pose.x + Math.sin(pose.yaw) * shape.radius,
        pose.y + shape.height * 0.82,
        pose.z + Math.cos(pose.yaw) * shape.radius,
      );
      slot.eye.rotation.y = meshYaw(pose.yaw);
    }
  }

  /** How long a tell is guaranteed to be on screen before it lands, in ticks. */
  static get telegraph() { return COMMIT_LEAD; }

  dispose() {
    for (const slot of this.slots) { slot.body.dispose(); slot.eye.dispose(); }
    this.slots = [];
  }
}

export const ENEMY_TINTS: Record<string, string> = {
  shambler: "#7f5aa8",
  lurcher: "#c2415e",
  bulwark: "#4a6f9c",
};

export const enemyTint = (style: string) => Color3.FromHexString(ENEMY_TINTS[style] ?? "#888888");
