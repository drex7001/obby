/**
 * Runner avatars and their projected nameplates.
 *
 * Note the yaw convention differs from the course's: a player's `yaw` is the
 * CAMERA heading, whose forward is `(sin yaw, cos yaw)` - the same mapping
 * Babylon's `rotation.y` uses. So avatars take yaw straight, while course
 * geometry needs `meshYaw()`. Two conventions, deliberately, because the
 * simulation uses each one where it is natural.
 */

import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";

import { PLAYER_COLOURS, type Stage } from "./scene.js";
import { PLAYER_HEIGHT, PLAYER_RADIUS } from "../../shared/constants.js";
import { clamp } from "../../shared/math.js";

/** The projection call wants a world matrix; our points are already in world space. */
const IDENTITY = Matrix.Identity();

export interface AvatarView {
  sessionId: string;
  name: string;
  colour: number;
  x: number; y: number; z: number;
  yaw: number;
  vy: number;
  respawning: boolean;
  finished: boolean;
  rank: number;
  connected: boolean;
  self: boolean;
}

interface Avatar {
  body: Mesh;
  visor: Mesh;
  plate: HTMLDivElement;
  colour: number;
}

export class Avatars {
  private stage: Stage;
  private plateHost: HTMLElement;
  private avatars = new Map<string, Avatar>();
  private scratch = new Vector3();

  constructor(stage: Stage, plateHost: HTMLElement) {
    this.stage = stage;
    this.plateHost = plateHost;
  }

  private create(view: AvatarView): Avatar {
    const scene = this.stage.scene;

    const body = MeshBuilder.CreateCapsule(`p-${view.sessionId}`, {
      height: PLAYER_HEIGHT,
      radius: PLAYER_RADIUS,
      tessellation: 14,
      capSubdivisions: 5,
    }, scene);
    body.material = this.stage.playerMaterial(view.colour, view.self);
    body.isPickable = false;
    this.stage.castsAndReceives(body, true, false);

    // A wedge on the front so which way a runner is facing is legible even at
    // the far end of the course.
    const visor = MeshBuilder.CreateBox(`v-${view.sessionId}`, {
      width: 0.46, height: 0.2, depth: 0.34,
    }, scene);
    visor.material = this.stage.visorMaterial(view.colour);
    visor.isPickable = false;
    visor.parent = body;
    visor.position.set(0, PLAYER_HEIGHT * 0.22, PLAYER_RADIUS * 0.92);

    const plate = document.createElement("div");
    plate.className = "plate";
    const pip = document.createElement("span");
    pip.className = "pip";
    pip.style.background = PLAYER_COLOURS[view.colour % PLAYER_COLOURS.length];
    const label = document.createElement("span");
    label.textContent = view.name;
    plate.append(pip, label);
    this.plateHost.appendChild(plate);

    const avatar: Avatar = { body, visor, plate, colour: view.colour };
    this.avatars.set(view.sessionId, avatar);
    return avatar;
  }

  private destroy(sessionId: string) {
    const avatar = this.avatars.get(sessionId);
    if (!avatar) { return; }
    avatar.body.dispose();
    avatar.plate.remove();
    this.avatars.delete(sessionId);
  }

  /** Reconcile the avatar set with `views`, then place everything. */
  update(views: AvatarView[], showSelf: boolean) {
    const live = new Set<string>();

    for (const view of views) {
      live.add(view.sessionId);
      let avatar = this.avatars.get(view.sessionId);
      if (!avatar) {
        avatar = this.create(view);
      } else if (avatar.colour !== view.colour) {
        avatar.body.material = this.stage.playerMaterial(view.colour, view.self);
        avatar.colour = view.colour;
      }

      const visible = view.connected && (showSelf || !view.self);
      avatar.body.setEnabled(visible);
      if (!visible) { avatar.plate.style.display = "none"; continue; }

      // The capsule's origin is its centre; the simulation's is the feet.
      avatar.body.position.set(view.x, view.y + PLAYER_HEIGHT / 2, view.z);
      avatar.body.rotation.y = view.yaw;

      // Squash and stretch, driven straight off vertical speed. Cheap, and it
      // does more for how a jump reads than any amount of extra geometry.
      const stretch = clamp(view.vy * 0.014, -0.14, 0.2);
      avatar.body.scaling.set(1 - stretch * 0.5, 1 + stretch, 1 - stretch * 0.5);

      if (view.respawning) {
        // Materialising back in at a checkpoint.
        avatar.body.scaling.scaleInPlace(0.55);
        avatar.body.visibility = 0.45;
      } else {
        avatar.body.visibility = 1;
      }

      this.placePlate(avatar, view);
    }

    for (const sessionId of [...this.avatars.keys()]) {
      if (!live.has(sessionId)) { this.destroy(sessionId); }
    }
  }

  private placePlate(avatar: Avatar, view: AvatarView) {
    const scene = this.stage.scene;
    const camera = this.stage.camera;

    this.scratch.set(view.x, view.y + PLAYER_HEIGHT + 0.42, view.z);
    const projected = Vector3.Project(
      this.scratch,
      // Identity world: the point is already in world space.
      IDENTITY,
      scene.getTransformMatrix(),
      camera.viewport.toGlobal(
        this.stage.engine.getRenderWidth(),
        this.stage.engine.getRenderHeight(),
      ),
    );

    const behind = projected.z > 1 || projected.z < 0;
    const distance = Vector3.Distance(camera.position, this.scratch);
    if (behind || view.self || distance > 95) {
      avatar.plate.style.display = "none";
      return;
    }

    avatar.plate.style.display = "";
    // Divide out the render scaling so the plate lands on the CSS pixel grid.
    const scale = this.stage.engine.getHardwareScalingLevel();
    avatar.plate.style.transform =
      `translate(-50%, -100%) translate(${projected.x * scale}px, ${projected.y * scale}px)`;
    avatar.plate.style.opacity = String(clamp(1.25 - distance / 95, 0.15, 1));
  }

  clear() {
    for (const sessionId of [...this.avatars.keys()]) { this.destroy(sessionId); }
  }
}
