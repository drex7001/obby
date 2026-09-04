/**
 * Builds the visible course from a `Level` and drives its moving parts.
 *
 * The level is never received over the network - it is rebuilt locally from
 * `state.seed`, so this module is handed the same `Level` object the simulation
 * collides against. That means what you see and what you hit cannot disagree:
 * both read `poseAt()` at the same world tick.
 */

import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";

import type { Anchor, Level, Obstacle, Pickup } from "../../shared/level.js";
import { rotateY } from "../../shared/math.js";
import {
  breakerBroken, makePose, pickupAvailable, poseAt, type Pose, type WorldPhase,
} from "../../shared/obstacles.js";
import { meshYaw, Stage } from "./scene.js";

interface Dynamic {
  ob: Obstacle;
  mesh: Mesh;
  /** Pendulum arm, drawn from the pivot down to the head. */
  arm?: Mesh;
}

/**
 * A breaker or a pickup: drawn from level data, but present or absent
 * according to a synchronised stamp rather than a pose.
 */
interface Prop {
  mesh: Mesh;
  slot: number;
  kind: "breaker" | "pickup";
  /** Pickups bob and spin, so a floating gun reads as collectable. */
  baseY: number;
  pickup?: Pickup;
}

const CASTS = new Set(["wall", "divider"]);

export class Course {
  private stage: Stage;
  private root: Mesh[] = [];
  private dynamics: Dynamic[] = [];
  private props: Prop[] = [];
  /** Anchor meshes by anchor id, so the aimed one can be picked out. */
  private anchorMeshes = new Map<number, Mesh>();
  private rope: Mesh | null = null;
  private ghost: Mesh | null = null;
  private aimed = -1;
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
    this.props = [];
    this.anchorMeshes.clear();
    this.rope = null;
    this.ghost = null;
    this.aimed = -1;
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
    const offset = { x: 0, z: 0 };
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
      // centimetres below the one the player actually stands on. Babylon applies
      // X before Y, so pitching in the ramp's local frame and then yawing it is
      // exactly the composition rampSurfaceY() inverts.
      rotateY(0, half * Math.sin(pitch), r.yaw, offset);
      mesh.rotation.x = -pitch;
      mesh.rotation.y = meshYaw(r.yaw);
      mesh.position.set(
        r.x + offset.x,
        (r.y0 + r.y1) / 2 - half * Math.cos(pitch),
        r.z + offset.z,
      );
      this.track(mesh, r.style, false);
      mesh.freezeWorldMatrix();
    }

    // ------------------------------------------------------------------ decor
    // Landmarks, rails and posts. Nothing here is in the simulation's world, so
    // it is drawn and then forgotten.
    for (const d of level.decor) {
      const mesh = MeshBuilder.CreateBox("decor", {
        width: d.hx * 2, height: d.hy * 2, depth: d.hz * 2,
      }, scene);
      mesh.position.set(d.x, d.y, d.z);
      mesh.rotation.y = meshYaw(d.yaw);
      this.track(mesh, d.style, true, false);
      mesh.freezeWorldMatrix();
    }

    // Tether anchors (stage 7) are already level content; drawing them now is
    // how a section built around them can be looked at before the verb exists.
    for (const a of level.anchors) {
      const mesh = MeshBuilder.CreateBox("anchor-" + a.id, {
        width: 0.7, height: 0.7, depth: 0.7,
      }, scene);
      mesh.position.set(a.x, a.y, a.z);
      this.track(mesh, "anchor", false, false);
      // Deliberately not frozen: the anchor the aim is on swells, which is the
      // whole in-range indicator. A verb with no affordance is a manual.
      this.anchorMeshes.set(a.id, mesh);
    }

    // One rope, reused. It is the only mesh in the course that is driven by a
    // player's state rather than by the world tick.
    const rope = MeshBuilder.CreateCylinder("tether-rope", {
      diameter: 0.13, height: 1, tessellation: 6,
    }, scene);
    rope.rotationQuaternion = Quaternion.Identity();
    rope.setEnabled(false);
    this.rope = this.track(rope, "rope", false, false);

    // Recall's ghost. It is not decoration: it is how a player makes the read
    // *before* firing, and it has to be honest that the world around it will
    // have moved on by the time they get there.
    const ghost = MeshBuilder.CreateBox("recall-ghost", {
      width: 0.9, height: 1.72, depth: 0.9,
    }, scene);
    ghost.setEnabled(false);
    ghost.isPickable = false;
    ghost.material = this.gateMaterial("ghost", "#c4b5fd");
    ghost.material.alpha = 0.4;
    this.root.push(ghost);
    this.ghost = ghost;

    // Breakers vanish when they are shot, and a pickup comes back twenty
    // seconds after it is taken - both driven by a synchronised stamp, so what
    // is on screen is exactly what the simulation will let you hit.
    for (const b of level.breakers) {
      const mesh = MeshBuilder.CreateBox("breaker-" + b.id, {
        width: b.hx * 2, height: b.hy * 2, depth: b.hz * 2,
      }, scene);
      mesh.position.set(b.x, b.y, b.z);
      mesh.rotation.y = meshYaw(b.yaw);
      this.track(mesh, b.style, false, false);
      this.props.push({ mesh, slot: b.slot, kind: "breaker", baseY: b.y });
    }

    for (const p of level.pickups) {
      const mesh = MeshBuilder.CreateBox("pickup-" + p.id, {
        width: 1.1, height: 0.5, depth: 1.1,
      }, scene);
      mesh.position.set(p.x, p.y, p.z);
      this.track(mesh, p.kind === "gun" ? "gun" : "crate", false, false);
      this.props.push({ mesh, slot: p.slot, kind: "pickup", baseY: p.y, pickup: p });
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

      // A bank sits at whatever heading the course had reached, so the arch is
      // built in the volume's frame rather than along world X.
      const along = (lx: number) => rotateY(lx, 0, v.yaw, offset);

      for (const side of [-1, 1]) {
        const post = MeshBuilder.CreateBox(`cp-post-${cp.index}-${side}`, {
          width: 0.44, height: 3.8, depth: 0.44,
        }, scene);
        const at = along(side * (v.hx - 0.3));
        post.position.set(v.x + at.x, groundY + 1.9, v.z + at.z);
        post.rotation.y = meshYaw(v.yaw);
        parts.push(this.gatePart(post, mat));
      }

      const bar = MeshBuilder.CreateBox(`cp-bar-${cp.index}`, {
        width: v.hx * 2, height: 0.34, depth: 0.44,
      }, scene);
      bar.position.set(v.x, groundY + 3.6, v.z);
      bar.rotation.y = meshYaw(v.yaw);
      parts.push(this.gatePart(bar, mat));

      const strip = MeshBuilder.CreateBox(`cp-strip-${cp.index}`, {
        width: v.hx * 2 - 0.8, height: 0.1, depth: 1.1,
      }, scene);
      strip.position.set(v.x, groundY + 0.05, v.z);
      strip.rotation.y = meshYaw(v.yaw);
      parts.push(this.gatePart(strip, mat));

      this.gates.push({ index: cp.index, material: mat, parts });
    });

    const f = level.finish;
    const finishMat = this.gateMaterial("finish", "#ffd166");
    for (const side of [-1, 1]) {
      const post = MeshBuilder.CreateBox(`fin-post-${side}`, {
        width: 0.66, height: 6, depth: 0.66,
      }, scene);
      const at = rotateY(side * (f.hx - 0.4), 0, f.yaw, offset);
      post.position.set(f.x + at.x, level.finishGroundY + 3, f.z + at.z);
      post.rotation.y = meshYaw(f.yaw);
      this.gatePart(post, finishMat);
    }
    const banner = MeshBuilder.CreateBox("fin-banner", {
      width: f.hx * 2, height: 1.3, depth: 0.6,
    }, scene);
    banner.position.set(f.x, level.finishGroundY + 6.3, f.z);
    banner.rotation.y = meshYaw(f.yaw);
    this.gatePart(banner, finishMat);

    const finishStrip = MeshBuilder.CreateBox("fin-strip", {
      width: f.hx * 2, height: 0.1, depth: 1.4,
    }, scene);
    finishStrip.position.set(f.x, level.finishGroundY + 0.05, f.z);
    finishStrip.rotation.y = meshYaw(f.yaw);
    this.gatePart(finishStrip, finishMat);
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
    for (const prop of this.props) {
      if (prop.kind === "breaker") {
        prop.mesh.setEnabled(!breakerBroken(phase, prop.slot, tick));
        continue;
      }
      const here = pickupAvailable(prop.pickup!, tick, phase);
      prop.mesh.setEnabled(here);
      if (here) {
        prop.mesh.position.y = prop.baseY + Math.sin(tick * 0.09) * 0.16;
        prop.mesh.rotation.y = tick * 0.045;
      }
    }

    for (const d of this.dynamics) {
      const pose = poseAt(d.ob, tick, phase, this.pose);
      const mesh = d.mesh;
      mesh.position.set(pose.x, pose.y, pose.z);

      // Babylon applies Z, then X, then Y, so roll happens inside yaw: exactly
      // the order hazardHit() undoes them in.
      mesh.rotation.y = meshYaw(pose.yaw);
      mesh.rotation.z = pose.roll;

      if (d.arm) {
        // Local +Y of the arm points from the head back up to the pivot, which
        // is exactly what rotation.z = roll produces - inside the yaw, so a
        // pendulum on a bent section swings in the plane its housing faces.
        mesh.rotation.z = pose.roll;
        d.arm.rotation.y = mesh.rotation.y;
        d.arm.rotation.z = pose.roll;
        d.arm.position.set(
          (d.ob.px + pose.x) / 2,
          (d.ob.py + pose.y) / 2,
          (d.ob.pz + pose.z) / 2,
        );
      }

      // A crumble platform that has dropped is still drawn, falling away - the
      // gap it leaves reads much better than a mesh that simply vanishes.
      mesh.setEnabled(pose.active || d.ob.kind === "crumble");
    }
  }

  /**
   * Draw the rope from a runner's hand to the anchor they are hanging from.
   *
   * `null` puts it away. The cylinder's local +Y is its axis, so the rotation
   * is simply "take up onto the rope direction" - no euler bookkeeping, and no
   * disagreement with the simulation, which does not care how it is drawn.
   */
  setTether(anchor: Anchor | null, hx: number, hy: number, hz: number) {
    const rope = this.rope;
    if (!rope) { return; }
    if (!anchor) { rope.setEnabled(false); return; }

    const dx = anchor.x - hx, dy = anchor.y - hy, dz = anchor.z - hz;
    const length = Math.hypot(dx, dy, dz);
    if (length < 1e-3) { rope.setEnabled(false); return; }

    rope.setEnabled(true);
    rope.position.set(hx + dx / 2, hy + dy / 2, hz + dz / 2);
    rope.scaling.set(1, length, 1);
    Quaternion.FromUnitVectorsToRef(
      Vector3.Up(),
      new Vector3(dx / length, dy / length, dz / length),
      rope.rotationQuaternion!,
    );
  }

  /** Swell whichever anchor a press would take, and only that one. */
  setAim(id: number) {
    if (id === this.aimed) { return; }
    const previous = this.anchorMeshes.get(this.aimed);
    if (previous) { previous.scaling.setAll(1); }
    const next = this.anchorMeshes.get(id);
    if (next) { next.scaling.setAll(1.7); }
    this.aimed = id;
  }

  /** Show where a Recall would put the runner, or `null` to hide it. */
  setGhost(x: number | null, y = 0, z = 0) {
    const ghost = this.ghost;
    if (!ghost) { return; }
    if (x === null) { ghost.setEnabled(false); return; }
    ghost.setEnabled(true);
    ghost.position.set(x, y + 0.86, z);
  }

  /** World-space position of a checkpoint arch, for HUD direction hints. */
  checkpointAt(index: number): Vector3 | null {
    const cp = this.level.checkpoints[index];
    return cp ? new Vector3(cp.volume.x, cp.volume.y, cp.volume.z) : null;
  }
}
