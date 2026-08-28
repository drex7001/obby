/**
 * Runner avatars and their projected nameplates.
 *
 * The character itself lives in `runner.ts`; this file owns the set of them —
 * creating one per player in the room, placing it, feeding the pose, and
 * tearing it down when someone leaves.
 *
 * Note the yaw convention differs from the course's: a player's `yaw` is the
 * CAMERA heading, whose forward is `(sin yaw, cos yaw)` - the same mapping
 * Babylon's `rotation.y` uses. So avatars take yaw straight, while course
 * geometry needs `meshYaw()`. Two conventions, deliberately, because the
 * simulation uses each one where it is natural.
 */

import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";

import { PLAYER_COLOURS, type Stage } from "./scene.js";
import { Runner } from "./runner.js";
import { PLAYER_HEIGHT, RUN_SPEED } from "../../shared/constants.js";
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
  grounded: boolean;
  carving: boolean;
  respawning: boolean;
  finished: boolean;
  rank: number;
  connected: boolean;
  self: boolean;
}

interface Avatar {
  rig: Runner;
  plate: HTMLDivElement;
  colour: number;
  /** Last frame's position, so the rig can be posed from ground speed. */
  px: number;
  pz: number;
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
    const rig = new Runner(this.stage, view.sessionId, view.colour, view.self);

    const plate = document.createElement("div");
    plate.className = "plate";
    const pip = document.createElement("span");
    pip.className = "pip";
    pip.style.background = PLAYER_COLOURS[view.colour % PLAYER_COLOURS.length];
    const label = document.createElement("span");
    label.textContent = view.name;
    plate.append(pip, label);
    this.plateHost.appendChild(plate);

    const avatar: Avatar = {
      rig, plate, colour: view.colour, px: view.x, pz: view.z,
    };
    this.avatars.set(view.sessionId, avatar);
    return avatar;
  }

  private destroy(sessionId: string) {
    const avatar = this.avatars.get(sessionId);
    if (!avatar) { return; }
    avatar.rig.dispose();
    avatar.plate.remove();
    this.avatars.delete(sessionId);
  }

  /** Reconcile the avatar set with `views`, then place and pose everything. */
  update(views: AvatarView[], showSelf: boolean) {
    const live = new Set<string>();
    // Clamped so a stalled tab or a single long frame cannot fling the rig.
    const dt = clamp(this.stage.engine.getDeltaTime() / 1000, 1 / 240, 1 / 15);

    for (const view of views) {
      live.add(view.sessionId);
      let avatar = this.avatars.get(view.sessionId);
      if (!avatar) {
        avatar = this.create(view);
      } else if (avatar.colour !== view.colour) {
        avatar.rig.setColour(view.colour, view.self);
        avatar.colour = view.colour;
      }

      // Ground speed comes from the position delta rather than the wire: `vx`
      // and `vz` are not replicated, and a respawn teleport would read as a
      // sprint, so that frame is pinned to a standstill instead.
      const step = Math.hypot(view.x - avatar.px, view.z - avatar.pz);
      const speed = view.respawning ? 0 : clamp(step / dt, 0, RUN_SPEED * 1.4);
      avatar.px = view.x;
      avatar.pz = view.z;

      const visible = view.connected && (showSelf || !view.self);
      avatar.rig.root.setEnabled(visible);
      if (!visible) { avatar.plate.style.display = "none"; continue; }

      avatar.rig.root.position.set(view.x, view.y, view.z);
      avatar.rig.root.rotation.y = view.yaw;
      avatar.rig.pose(dt, speed, view.vy, !view.grounded, view.finished);

      // Squash and stretch, driven straight off vertical speed. Cheap, and it
      // does more for how a jump reads than any amount of extra geometry. The
      // rig's origin is at the feet, so the stretch grows upward from them.
      const stretch = clamp(view.vy * 0.014, -0.14, 0.2);
      const crouch = view.carving ? 0.5 : 1;
      avatar.rig.root.scaling.set(1 - stretch * 0.5, (1 + stretch) * crouch, 1 - stretch * 0.5);

      if (view.respawning) {
        // Materialising back in at a checkpoint.
        avatar.rig.root.scaling.scaleInPlace(0.55);
        avatar.rig.setVisibility(0.45);
      } else {
        avatar.rig.setVisibility(1);
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
