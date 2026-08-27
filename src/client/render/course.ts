/**
 * Builds the visible course from a `Level` and drives its moving parts.
 *
 * The level is never received over the network - it is rebuilt locally from
 * `state.seed`, so this module is handed the same `Level` object the simulation
 * collides against. That means what you see and what you hit cannot disagree:
 * both read `poseAt()` at the same world tick.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";

import type { Level, Obstacle } from "../../shared/level.js";
import { makePose, poseAt, type Pose, type WorldPhase } from "../../shared/obstacles.js";
import { meshYaw, Stage } from "./scene.js";

interface Dynamic {
  ob: Obstacle;
  mesh: Mesh;
  /** Pendulum arm, drawn from the pivot down to the head. */
  arm?: Mesh;
}

const CASTS = new Set(["wall", "divider"]);

export class Course {
  private stage: Stage;
  private root: Mesh[] = [];
  private dynamics: Dynamic[] = [];
  private gates: { index: number; material: StandardMaterial; parts: Mesh[] }[] = [];
  private pose: Pose = makePose();
  private reached = -1;

  level: Level;

  constructor(stage: Stage, level: Level) {
    this.stage = stage;
    this.level = level;
    this.build();
  }

  /** Tear down the current course and build the next round's. */
  rebuild(level: Level) {
    for (const mesh of this.root) { mesh.dispose(); }
    this.root = [];
    this.dynamics = [];
    this.gates = [];
    this.reached = -1;
    this.level = level;
    this.build();
  }

  private track(mesh: Mesh, style: string, cast: boolean, receive = true) {
    mesh.material = this.stage.material(style);
    mesh.isPickable = false;
    this.stage.castsAndReceives(mesh, cast, receive);
    this.root.push(mesh);
    return mesh;
  }

  private build() {
    const scene = this.stage.scene;
    const level = this.level;

    // ---------------------------------------------------------- static solids
    for (const s of level.solids) {
      const mesh = MeshBuilder.CreateBox("solid", {
        width: s.hx * 2, height: s.hy * 2, depth: s.hz * 2,
      }, scene);
      mesh.position.set(s.x, s.y, s.z);
      mesh.rotation.y = meshYaw(s.yaw);
      this.track(mesh, s.style, CASTS.has(s.style));
      mesh.freezeWorldMatrix();
    }

    // ------------------------------------------------------------------ ramps
    for (const r of level.ramps) {
      const length = r.hz * 2;
      const rise = r.y1 - r.y0;
      const slope = Math.hypot(length, rise);
      const pitch = Math.atan2(rise, length);
      const half = 0.45;

      const mesh = MeshBuilder.CreateBox("ramp", {
        width: r.hx * 2, height: half * 2, depth: slope,
      }, scene);
      // Pitch the slab so its TOP face lies on the surface the simulation walks
      // on. The half-thickness rotates too, so the centre is offset along the
      // tilted normal - without that the visible surface sits a couple of
      // centimetres below the one the player actually stands on.
      mesh.rotation.x = -pitch;
      mesh.position.set(
        r.x,
        (r.y0 + r.y1) / 2 - half * Math.cos(pitch),
        r.z + half * Math.sin(pitch),
      );
      this.track(mesh, r.style, false);
      mesh.freezeWorldMatrix();
    }

    // ------------------------------------------------------------- obstacles
    for (const ob of level.obstacles) {
      const mesh = MeshBuilder.CreateBox(`ob-${ob.id}`, {
        width: ob.size.x, height: ob.size.y, depth: ob.size.z,
      }, scene);
      this.track(mesh, ob.style, true, ob.role === "solid");

      const entry: Dynamic = { ob, mesh };

      if (ob.kind === "pendulum") {
        const arm = MeshBuilder.CreateBox(`arm-${ob.id}`, {
          width: 0.22, height: ob.armLength, depth: 0.22,
        }, scene);
        this.track(arm, "rope", true, false);
        entry.arm = arm;

        // The pivot housing never moves, so it is a static prop.
        const hub = MeshBuilder.CreateBox(`hub-${ob.id}`, {
          width: 1.1, height: 0.7, depth: 1.1,
        }, scene);
        hub.position.set(ob.px, ob.py, ob.pz);
        this.track(hub, "post", true, false);
        hub.freezeWorldMatrix();
      }

      if (ob.kind === "spinner") {
        const hub = MeshBuilder.CreateCylinder(`hub-${ob.id}`, {
          diameter: 1.5, height: 1.4, tessellation: 12,
        }, scene);
        hub.position.set(ob.px, ob.py, ob.pz);
        this.track(hub, "post", true, false);
        hub.freezeWorldMatrix();
      }

      this.dynamics.push(entry);
    }

    // ------------------------------------------- checkpoint and finish gates
    //
    // A frame plus a glowing strip on the floor, deliberately NOT a translucent
    // curtain across the opening: the follow camera passes through the gate a
    // moment after the player does, and a full-width transparent plane tints the
    // entire screen as it goes by.
    level.checkpoints.forEach((cp) => {
      const v = cp.volume;
      const groundY = cp.spawn.y;
      const mat = this.gateMaterial(`cp-${cp.index}`, "#6ee7ff");
      const parts: Mesh[] = [];

      for (const side of [-1, 1]) {
        const post = MeshBuilder.CreateBox(`cp-post-${cp.index}-${side}`, {
          width: 0.44, height: 3.8, depth: 0.44,
        }, scene);
        post.position.set(v.x + side * (v.hx - 0.3), groundY + 1.9, v.z);
        parts.push(this.gatePart(post, mat));
      }

      const bar = MeshBuilder.CreateBox(`cp-bar-${cp.index}`, {
        width: v.hx * 2, height: 0.34, depth: 0.44,
      }, scene);
      bar.position.set(v.x, groundY + 3.6, v.z);
      parts.push(this.gatePart(bar, mat));

      const strip = MeshBuilder.CreateBox(`cp-strip-${cp.index}`, {
        width: v.hx * 2 - 0.8, height: 0.1, depth: 1.1,
      }, scene);
      strip.position.set(v.x, groundY + 0.05, v.z);
      parts.push(this.gatePart(strip, mat));

      this.gates.push({ index: cp.index, material: mat, parts });
    });

    const f = level.finish;
    const finishMat = this.gateMaterial("finish", "#ffd166");
    for (const side of [-1, 1]) {
      const post = MeshBuilder.CreateBox(`fin-post-${side}`, {
        width: 0.66, height: 6, depth: 0.66,
      }, scene);
      post.position.set(f.x + side * (f.hx - 0.4), level.finishGroundY + 3, f.z);
      this.gatePart(post, finishMat);
    }
    const banner = MeshBuilder.CreateBox("fin-banner", {
      width: f.hx * 2, height: 1.3, depth: 0.6,
    }, scene);
    banner.position.set(f.x, level.finishGroundY + 6.3, f.z);
    this.gatePart(banner, finishMat);

    const finishStrip = MeshBuilder.CreateBox("fin-strip", {
      width: f.hx * 2, height: 0.1, depth: 1.4,
    }, scene);
    finishStrip.position.set(f.x, level.finishGroundY + 0.05, f.z);
    this.gatePart(finishStrip, finishMat);

    // Posts along the narrow bridge, purely so the eye has something to judge
    // depth and speed against on the section where that matters most.
    for (let z = 108; z <= 148; z += 8) {
      for (const side of [-1, 1]) {
        const post = MeshBuilder.CreateBox(`bp-${z}-${side}`, {
          width: 0.28, height: 1.1, depth: 0.28,
        }, scene);
        post.position.set(side * 1.62, 0.55, z);
        this.track(post, "post", true, false);
        post.freezeWorldMatrix();
      }
    }
  }

  /** A gate's own material, so each can be recoloured independently. */
  private gateMaterial(name: string, hex: string): StandardMaterial {
    const mat = new StandardMaterial(`gate-${name}`, this.stage.scene);
    const tint = Color3.FromHexString(hex);
    mat.diffuseColor = tint.scale(0.35);
    mat.emissiveColor = tint.scale(0.85);
    mat.specularColor = Color3.Black();
    return mat;
  }

  private gatePart(mesh: Mesh, mat: StandardMaterial): Mesh {
    mesh.material = mat;
    mesh.isPickable = false;
    mesh.receiveShadows = false;
    mesh.freezeWorldMatrix();
    this.root.push(mesh);
    return mesh;
  }

  /**
   * Recolour the gates the local player has already banked, so "where do I
   * respawn" is answerable at a glance.
   */
  setReached(index: number) {
    if (index === this.reached) { return; }
    this.reached = index;
    for (const gate of this.gates) {
      const done = gate.index <= index;
      const tint = Color3.FromHexString(done ? "#6ee787" : "#6ee7ff");
      gate.material.diffuseColor = tint.scale(0.35);
      gate.material.emissiveColor = tint.scale(done ? 0.5 : 0.85);
    }
  }

  /** Move every dynamic mesh to its pose at `tick`. */
  update(tick: number, phase: WorldPhase) {
    for (const d of this.dynamics) {
      const pose = poseAt(d.ob, tick, phase, this.pose);
      const mesh = d.mesh;
      mesh.position.set(pose.x, pose.y, pose.z);

      // No obstacle uses yaw and roll at once (solids only yaw, pendulums only
      // roll), so Euler composition order never comes into play here.
      mesh.rotation.y = meshYaw(pose.yaw);
      mesh.rotation.z = pose.roll;

      if (d.arm) {
        // Local +Y of the arm points from the head back up to the pivot, which
        // is exactly what rotation.z = roll produces.
        mesh.rotation.z = pose.roll;
        d.arm.rotation.z = pose.roll;
        d.arm.position.set(
          (d.ob.px + pose.x) / 2,
          (d.ob.py + pose.y) / 2,
          d.ob.pz,
        );
      }

      // A crumble platform that has dropped is still drawn, falling away - the
      // gap it leaves reads much better than a mesh that simply vanishes.
      mesh.setEnabled(pose.active || d.ob.kind === "crumble");
    }
  }

  /** World-space position of a checkpoint arch, for HUD direction hints. */
  checkpointAt(index: number): Vector3 | null {
    const cp = this.level.checkpoints[index];
    return cp ? new Vector3(cp.volume.x, cp.volume.y, cp.volume.z) : null;
  }
}
