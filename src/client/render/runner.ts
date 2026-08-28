/**
 * The runner — an aviator kid assembled from primitives and posed by hand.
 *
 * Why build the character rather than import one: the course is flat-shaded
 * neon boxes, every runner has to be tinted with its own identity colour at
 * runtime, and up to six of them animate off a 30 Hz state stream that carries
 * position and nothing else. A rig built here inherits the palette for free,
 * adds no download to a game whose whole level is generated from one integer,
 * and is posed from three numbers — ground speed, vertical speed, and whether
 * the feet are down. No skeleton, no clips, no retargeting.
 *
 * The trade is that the pose is code, not animation data, so it lives or dies
 * on the joint hierarchy below:
 *
 *   root      world position, yaw, and the jump squash/stretch
 *    frame    the one place the design scale is applied
 *     hips    vertical bob and the pelvis half of the contra-body twist
 *      legL/legR   swing from the hip
 *      chest       run lean and the counter-twist
 *       armL/armR  swing from the shoulder
 *       scarf      trails on speed
 *       neck       keeps the face level while the chest leans
 *
 * Every literal is authored in a 1.72-unit-tall design space and scaled by `S`,
 * so the whole character follows PLAYER_HEIGHT if that constant ever moves.
 * Nothing reaches past PLAYER_RADIUS either: the capsule is what the simulation
 * actually collides, and art that pokes out of it would be lying about where
 * the runner is.
 */

import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";

import type { Stage } from "./scene.js";
import { PLAYER_HEIGHT, RUN_SPEED, JUMP_SPEED } from "../../shared/constants.js";
import { clamp, damp, lerp } from "../../shared/math.js";

/** Design space -> world. Everything below is written for a 1.72-tall runner. */
const S = PLAYER_HEIGHT / 1.72;

/** Height of the hip joint. Legs hang from it, the chest stacks up from it. */
const HIP_Y = 0.66;

// Shared trim. Leather-dark gear and skin read the same on all six runners, so
// only the jacket, helmet and scarf carry the player's colour.
const GEAR = "#3a3550";
const SKIN = "#e8b98f";
const EYE = "#191828";

export class Runner {
  /** Parent for world placement: position, yaw and squash/stretch go here. */
  readonly root: TransformNode;

  private hips: TransformNode;
  private chest: TransformNode;
  private neck: TransformNode;
  private legL: TransformNode;
  private legR: TransformNode;
  private armL: TransformNode;
  private armR: TransformNode;
  private scarf: TransformNode;

  private parts: Mesh[] = [];
  /** The big silhouette pieces. Only these go in the shadow map. */
  private casters: Mesh[] = [];
  /** Meshes wearing the player's colour, re-tinted if the slot changes. */
  private tinted: Mesh[] = [];
  /** Meshes wearing the pale accent shade of the player's colour. */
  private accented: Mesh[] = [];

  private stage: Stage;
  /** Run-cycle phase, in radians. One full turn is two strides. */
  private gait = 0;
  private idle = 0;
  /** Smoothed 0..1 blends toward the airborne and finished poses. */
  private air = 0;
  private cheer = 0;

  constructor(stage: Stage, id: string, colour: number, self: boolean) {
    this.stage = stage;
    const scene = stage.scene;

    const gear = stage.flatMaterial("gear", GEAR);
    const skin = stage.flatMaterial("skin", SKIN, 0.22);
    const eye = stage.flatMaterial("eye", EYE);
    const main = stage.playerMaterial(colour, self);
    const accent = stage.visorMaterial(colour);

    this.root = new TransformNode(`p-${id}`, scene);

    const frame = new TransformNode(`p-${id}-frame`, scene);
    frame.parent = this.root;
    frame.scaling.setAll(S);

    this.hips = new TransformNode(`p-${id}-hips`, scene);
    this.hips.parent = frame;
    this.hips.position.y = HIP_Y;

    // ------------------------------------------------------------------ legs
    for (const side of [-1, 1]) {
      const hip = new TransformNode(`p-${id}-hip${side}`, scene);
      hip.parent = this.hips;
      hip.position.x = 0.135 * side;

      const leg = MeshBuilder.CreateCapsule(`p-${id}-leg${side}`, {
        height: 0.46, radius: 0.105, tessellation: 8, capSubdivisions: 3,
      }, scene);
      leg.position.y = -0.25;
      this.attach(leg, hip, main, { cast: true, tint: "main" });

      // Chunky boots. They carry most of the lower silhouette, so the leg
      // itself can stay thin without the runner reading as a stick figure.
      const boot = MeshBuilder.CreateBox(`p-${id}-boot${side}`, {
        width: 0.26, height: 0.17, depth: 0.36,
      }, scene);
      boot.position.set(0, -0.575, 0.05);
      this.attach(boot, hip, gear, { cast: true });

      if (side < 0) { this.legL = hip; } else { this.legR = hip; }
    }

    // ----------------------------------------------------------------- torso
    this.chest = new TransformNode(`p-${id}-chest`, scene);
    this.chest.parent = this.hips;

    // Tapered and flattened front-to-back: a plain cylinder reads as a barrel,
    // and the shoulders need to be the widest part for the jacket to work.
    const torso = MeshBuilder.CreateCylinder(`p-${id}-torso`, {
      height: 0.5, diameterTop: 0.5, diameterBottom: 0.4, tessellation: 12,
    }, scene);
    torso.position.y = 0.25;
    torso.scaling.z = 0.82;
    this.attach(torso, this.chest, main, { cast: true, tint: "main" });

    const belt = MeshBuilder.CreateBox(`p-${id}-belt`, {
      width: 0.46, height: 0.09, depth: 0.42,
    }, scene);
    belt.position.y = 0.09;
    this.attach(belt, this.chest, gear);

    // The diagonal harness. Deeper than the torso so it shows front and back.
    const harness = MeshBuilder.CreateBox(`p-${id}-harness`, {
      width: 0.085, height: 0.44, depth: 0.46,
    }, scene);
    harness.position.y = 0.29;
    harness.rotation.z = 0.42;
    this.attach(harness, this.chest, gear);

    // ------------------------------------------------------------------ arms
    for (const side of [-1, 1]) {
      const shoulder = new TransformNode(`p-${id}-sh${side}`, scene);
      shoulder.parent = this.chest;
      shoulder.position.set(0.265 * side, 0.44, 0);

      // A pad over the joint, so the arm does not visibly hinge out of a hole.
      const pad = MeshBuilder.CreateSphere(`p-${id}-pad${side}`, {
        diameter: 0.19, segments: 8,
      }, scene);
      this.attach(pad, shoulder, main, { tint: "main" });

      const arm = MeshBuilder.CreateCapsule(`p-${id}-arm${side}`, {
        height: 0.4, radius: 0.083, tessellation: 8, capSubdivisions: 3,
      }, scene);
      arm.position.y = -0.2;
      this.attach(arm, shoulder, main, { tint: "main" });

      const glove = MeshBuilder.CreateBox(`p-${id}-glove${side}`, {
        width: 0.135, height: 0.135, depth: 0.155,
      }, scene);
      glove.position.y = -0.44;
      this.attach(glove, shoulder, gear);

      if (side < 0) { this.armL = shoulder; } else { this.armR = shoulder; }
    }

    // ----------------------------------------------------------------- scarf
    const collar = MeshBuilder.CreateTorus(`p-${id}-collar`, {
      diameter: 0.4, thickness: 0.16, tessellation: 12,
    }, scene);
    collar.position.y = 0.48;
    collar.scaling.z = 0.9;
    this.attach(collar, this.chest, accent, { tint: "accent" });

    this.scarf = new TransformNode(`p-${id}-scarf`, scene);
    this.scarf.parent = this.chest;
    this.scarf.position.set(0, 0.5, -0.11);

    const tail = MeshBuilder.CreateBox(`p-${id}-tail`, {
      width: 0.19, height: 0.36, depth: 0.055,
    }, scene);
    tail.position.y = -0.18;
    this.attach(tail, this.scarf, accent, { tint: "accent" });

    // ------------------------------------------------------------------ head
    this.neck = new TransformNode(`p-${id}-neck`, scene);
    this.neck.parent = this.chest;
    this.neck.position.y = 0.52;

    const head = MeshBuilder.CreateSphere(`p-${id}-head`, {
      diameter: 0.56, segments: 12,
    }, scene);
    head.position.y = 0.21;
    head.scaling.set(1, 0.95, 0.92);
    this.attach(head, this.neck, skin, { cast: true });

    // Sliced rather than a full sphere: the cut leaves the face open below the
    // brow, which is the whole reason the character reads as a face at all.
    const helmet = MeshBuilder.CreateSphere(`p-${id}-helmet`, {
      diameter: 0.62, segments: 12, slice: 0.46,
    }, scene);
    helmet.position.set(0, 0.225, -0.012);
    helmet.scaling.set(1.03, 1, 1.05);
    this.attach(helmet, this.neck, main, { cast: true, tint: "main" });

    for (const side of [-1, 1]) {
      const cup = MeshBuilder.CreateCylinder(`p-${id}-cup${side}`, {
        height: 0.1, diameter: 0.23, tessellation: 10,
      }, scene);
      cup.rotation.z = Math.PI / 2;
      cup.position.set(0.275 * side, 0.165, -0.012);
      this.attach(cup, this.neck, gear);
    }

    // Goggles, pushed up onto the forehead. The strap rides the helmet; the
    // lenses sit proud of it and catch the glow layer.
    const strap = MeshBuilder.CreateTorus(`p-${id}-strap`, {
      diameter: 0.62, thickness: 0.05, tessellation: 14,
    }, scene);
    strap.position.y = 0.34;
    strap.rotation.x = -0.1;
    this.attach(strap, this.neck, gear);

    for (const side of [-1, 1]) {
      const rim = MeshBuilder.CreateCylinder(`p-${id}-rim${side}`, {
        height: 0.055, diameter: 0.2, tessellation: 12,
      }, scene);
      rim.rotation.x = Math.PI / 2;
      rim.position.set(0.105 * side, 0.345, 0.3);
      this.attach(rim, this.neck, gear);

      const lens = MeshBuilder.CreateCylinder(`p-${id}-lens${side}`, {
        height: 0.07, diameter: 0.17, tessellation: 12,
      }, scene);
      lens.rotation.x = Math.PI / 2;
      lens.position.set(0.105 * side, 0.345, 0.315);
      this.attach(lens, this.neck, accent, { tint: "accent" });
    }

    for (const side of [-1, 1]) {
      const pupil = MeshBuilder.CreateSphere(`p-${id}-eye${side}`, {
        diameter: 0.105, segments: 8,
      }, scene);
      pupil.scaling.set(1, 1.1, 0.55);
      pupil.position.set(0.095 * side, 0.15, 0.245);
      this.attach(pupil, this.neck, eye);

      // Angled down toward the nose. Two boxes, and the runner looks determined
      // instead of blank — by far the cheapest expression available.
      const brow = MeshBuilder.CreateBox(`p-${id}-brow${side}`, {
        width: 0.09, height: 0.026, depth: 0.032,
      }, scene);
      brow.position.set(0.1 * side, 0.225, 0.243);
      brow.rotation.z = -0.34 * side;
      this.attach(brow, this.neck, eye);
    }

    for (const mesh of this.casters) { stage.castsAndReceives(mesh, true, false); }
  }

  private attach(
    mesh: Mesh,
    parent: TransformNode,
    material: StandardMaterial,
    opts: { cast?: boolean; tint?: "main" | "accent" } = {},
  ) {
    mesh.material = material;
    mesh.parent = parent;
    mesh.isPickable = false;
    this.parts.push(mesh);
    if (opts.cast) { this.casters.push(mesh); }
    if (opts.tint === "main") { this.tinted.push(mesh); }
    if (opts.tint === "accent") { this.accented.push(mesh); }
    return mesh;
  }

  /** Re-tint in place when a player's colour slot changes. */
  setColour(colour: number, self: boolean) {
    const main = this.stage.playerMaterial(colour, self);
    const accent = this.stage.visorMaterial(colour);
    for (const mesh of this.tinted) { mesh.material = main; }
    for (const mesh of this.accented) { mesh.material = accent; }
  }

  setVisibility(v: number) {
    for (const mesh of this.parts) { mesh.visibility = v; }
  }

  /**
   * Drive the whole rig from the little the network actually gives us.
   *
   * `speed` is horizontal ground speed, `vy` vertical velocity; between them
   * they decide stride length, lean, how hard the scarf trails and whether the
   * legs are cycling or tucked.
   */
  pose(dt: number, speed: number, vy: number, airborne: boolean, finished: boolean) {
    const run = clamp(speed / RUN_SPEED, 0, 1.15);
    // Cadence rises with speed: ~2 strides/sec at a sprint. The floor term
    // keeps the phase creeping while idle so there is no jolt on the first step.
    this.gait += (0.8 + run * 11.2) * dt;
    this.idle += dt;

    this.air = damp(this.air, airborne && !finished ? 1 : 0, 16, dt);
    this.cheer = damp(this.cheer, finished ? 1 : 0, 6, dt);

    const ground = 1 - this.air;
    const swing = Math.sin(this.gait) * run;
    const breath = Math.sin(this.idle * 1.9) * (1 - run);
    // +1 at the top of a jump, -1 at terminal velocity.
    const rise = clamp(vy / JUMP_SPEED, -1, 1);

    // Legs: a negative pitch swings a hanging limb forward.
    const tuck = 0.5 + rise * 0.5;
    this.legL.rotation.x = lerp(-swing * 0.95, -tuck, this.air);
    this.legR.rotation.x = lerp(swing * 0.95, tuck * 0.45, this.air);
    this.legL.rotation.z = this.air * 0.16;
    this.legR.rotation.z = this.air * -0.2;

    // Hips: two rises per stride, plus half the contra-body twist.
    const bounce = Math.abs(Math.sin(this.gait));
    this.hips.position.y = HIP_Y + (bounce - 0.5) * 0.075 * run * ground;
    this.hips.rotation.y = swing * 0.1 * ground;
    this.hips.rotation.z = swing * 0.05 * ground;

    // Chest: leans into the run, straightens in the air, arches on a win.
    const lean = lerp(0.05 + run * 0.3, 0.1 - rise * 0.22, this.air);
    this.chest.rotation.x = lerp(lean, -0.16, this.cheer);
    this.chest.rotation.y = -swing * 0.17 * ground;
    this.chest.position.y = breath * 0.012;

    // Arms: counter the legs on the ground, go up in the air and stay up on a
    // win. A pitch past vertical is what puts a hanging arm overhead.
    const reach = 2.05 + rise * 0.3;
    this.armL.rotation.x = lerp(lerp(swing * 0.85, reach, this.air), 2.5, this.cheer);
    this.armR.rotation.x = lerp(lerp(-swing * 0.85, reach - 0.18, this.air), 2.5, this.cheer);
    const splay = 0.13 + run * 0.09 + this.air * 0.35 + this.cheer * 0.45;
    this.armL.rotation.z = -splay;
    this.armR.rotation.z = splay;

    // Head: cancels most of the chest lean so the face keeps pointing where the
    // player is actually looking, then leads the twist by a few degrees.
    this.neck.rotation.x = -this.chest.rotation.x * 0.8 - this.air * 0.1;
    this.neck.rotation.y = swing * 0.09 * ground;
    this.neck.rotation.z = Math.sin(this.gait * 2) * 0.035 * run;

    // Scarf: streams back on speed, flutters off the stride at its own rate so
    // it never locks to the footfalls.
    this.scarf.rotation.x =
      0.3 + run * 1.05 + this.air * 0.4 + Math.sin(this.gait * 1.7) * 0.16 * run;
    this.scarf.rotation.z = Math.sin(this.gait * 1.3) * 0.2 * run + breath * 0.05;
  }

  dispose() {
    // The shadow generator holds its render list by reference; disposed meshes
    // left in it would pile up over a long session of players coming and going.
    for (const mesh of this.casters) { this.stage.shadows.removeShadowCaster(mesh); }
    this.root.dispose();
  }
}
