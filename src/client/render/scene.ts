/**
 * Babylon scene setup: engine, lighting, fog, and the material palette.
 *
 * Babylon's default coordinate system is left-handed with +X right, +Y up and
 * +Z forward, which is exactly the simulation's convention - so world positions
 * go straight from the shared step into a mesh with no conversion at all.
 *
 * Yaw is the one place they differ. The collision code's `toWorld` maps a box's
 * local +Z to world `(-sin y, cos y)`, while Babylon's `rotation.y` maps it to
 * `(sin y, cos y)`. Hence `meshYaw()` below - one negation, in one place.
 */

import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";

// Side-effect registrations. Tree-shaken builds of Babylon do not wire these
// scene components up unless they are imported explicitly.
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import "@babylonjs/core/Layers/effectLayerSceneComponent";
import "@babylonjs/core/Rendering/depthRendererSceneComponent";

/** Convert a simulation yaw into the Babylon mesh rotation that matches it. */
export const meshYaw = (simYaw: number) => -simYaw;

/** The six runner colours, in schema `colour` order. */
export const PLAYER_COLOURS = [
  "#ff5c7a", "#4ecdc4", "#ffd166", "#a78bfa", "#6ee787", "#ff9f45",
];

interface StyleDef {
  /** Base diffuse colour. */
  hex: string;
  /** Emissive strength, 0..1, applied as a tint of the base colour. */
  glow?: number;
  /** Specular highlight strength. */
  spec?: number;
  alpha?: number;
}

/**
 * How every course style reads on screen.
 *
 * The rule the whole palette follows: anything that can hurt you is warm and
 * glowing, anything you can stand on is cool and matte, and anything that
 * *changes* (checkpoints, plates, doors) is saturated so it draws the eye.
 */
const STYLES: Record<string, StyleDef> = {
  lobby: { hex: "#3d4468" },
  track: { hex: "#39406b" },
  pad: { hex: "#2f7a63", glow: 0.16 },
  bridge: { hex: "#474d7d" },
  lane: { hex: "#3a4170" },
  ramp: { hex: "#3b426d" },
  top: { hex: "#3f4675" },
  runout: { hex: "#2f7a63", glow: 0.2 },
  wall: { hex: "#252a49" },
  divider: { hex: "#2c3155", glow: 0.05 },

  mover: { hex: "#2e6f8e", glow: 0.3, spec: 0.3 },
  rotator: { hex: "#5a4a86", glow: 0.16 },
  crumble: { hex: "#a8763a", glow: 0.12 },
  pusher: { hex: "#b4485e", glow: 0.28 },
  door: { hex: "#c2703a", glow: 0.26 },
  swingbridge: { hex: "#3f8f6a", glow: 0.3 },
  gate: { hex: "#8a3f5a", glow: 0.3 },

  plate: { hex: "#6ee787", glow: 0.3 },
  "plate-dead": { hex: "#454a60", glow: 0 },

  bar: { hex: "#ff4b6e", glow: 0.4, spec: 0.28 },
  hammer: { hex: "#ff4062", glow: 0.4, spec: 0.28 },
  sweeper: { hex: "#ff8f2e", glow: 0.42, spec: 0.28 },

  // Non-collidable dressing.
  post: { hex: "#2b3052" },
  rope: { hex: "#5b6699", glow: 0.1 },
  grid: { hex: "#151a33" },
};

export class Stage {
  readonly engine: Engine;
  readonly scene: Scene;
  readonly camera: UniversalCamera;
  readonly shadows: ShadowGenerator;
  readonly sun: DirectionalLight;
  readonly glow: GlowLayer;

  private materials = new Map<string, StandardMaterial>();

  constructor(canvas: HTMLCanvasElement) {
    this.engine = new Engine(canvas, true, {
      antialias: true,
      stencil: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false,
    });
    this.engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, 2));

    this.scene = new Scene(this.engine);
    this.scene.clearColor = new Color4(0.035, 0.043, 0.086, 1);
    this.scene.ambientColor = new Color3(0.17, 0.19, 0.3);

    // Fog does the heavy lifting for depth on a 300-unit course: distant
    // sections fade into the void instead of reading as a flat wall of boxes.
    this.scene.fogMode = Scene.FOGMODE_EXP2;
    this.scene.fogColor = new Color3(0.05, 0.06, 0.12);
    this.scene.fogDensity = 0.0092;

    this.camera = new UniversalCamera("cam", new Vector3(0, 6, -22), this.scene);
    this.camera.minZ = 0.25;
    this.camera.maxZ = 460;
    this.camera.fov = 1.12;
    // The camera is driven entirely by our own follow rig.
    this.camera.inputs.clear();

    const sky = new HemisphericLight("sky", new Vector3(0.1, 1, 0.15), this.scene);
    sky.intensity = 0.46;
    sky.diffuse = new Color3(0.62, 0.68, 0.95);
    sky.groundColor = new Color3(0.16, 0.14, 0.3);

    this.sun = new DirectionalLight("sun", new Vector3(-0.45, -1, 0.4), this.scene);
    this.sun.intensity = 0.98;
    this.sun.diffuse = new Color3(1, 0.95, 0.86);
    // A directional light's shadow frustum is built around its position, so the
    // rig moves the light with the player and keeps the ortho box tight. One
    // 2k map over 300 units would be mush; over 70 it is crisp.
    this.sun.autoUpdateExtends = false;
    this.sun.shadowMinZ = 1;
    this.sun.shadowMaxZ = 130;
    this.sun.orthoLeft = -34;
    this.sun.orthoRight = 34;
    this.sun.orthoBottom = -30;
    this.sun.orthoTop = 30;

    this.shadows = new ShadowGenerator(2048, this.sun);
    this.shadows.usePercentageCloserFiltering = true;
    this.shadows.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
    this.shadows.darkness = 0.42;
    this.shadows.bias = 0.008;
    this.shadows.normalBias = 0.012;

    this.glow = new GlowLayer("glow", this.scene, { blurKernelSize: 26 });
    this.glow.intensity = 0.44;

    this.buildVoid();

    window.addEventListener("resize", () => this.engine.resize());
  }

  /**
   * A faint grid far below the course. Without it the void reads as a flat
   * backdrop and it becomes very hard to judge how far you are about to fall.
   */
  private buildVoid() {
    const grid = MeshBuilder.CreateGround("void", { width: 460, height: 700, subdivisions: 1 }, this.scene);
    grid.position.set(0, -26, 140);
    const mat = new StandardMaterial("void-mat", this.scene);
    mat.diffuseColor = Color3.FromHexString("#0d1128");
    mat.specularColor = Color3.Black();
    mat.emissiveColor = Color3.FromHexString("#080b1c");
    grid.material = mat;
    grid.isPickable = false;
    grid.receiveShadows = false;
    grid.freezeWorldMatrix();
  }

  /** Materials are shared per style so the scene stays at a handful of draw batches. */
  material(style: string): StandardMaterial {
    const cached = this.materials.get(style);
    if (cached) { return cached; }

    const def = STYLES[style] ?? { hex: "#4a5178" };
    const base = Color3.FromHexString(def.hex);
    const mat = new StandardMaterial(`mat-${style}`, this.scene);
    mat.diffuseColor = base;
    mat.emissiveColor = def.glow ? base.scale(def.glow) : Color3.Black();
    mat.specularColor = new Color3(1, 1, 1).scale(def.spec ?? 0.08);
    mat.specularPower = 48;
    mat.ambientColor = base.scale(0.4);
    if (def.alpha !== undefined) {
      mat.alpha = def.alpha;
      mat.backFaceCulling = false;
    }
    mat.freeze();
    this.materials.set(style, mat);
    return mat;
  }

  /**
   * A flat, shared material cached by key — the runner rig's leather, skin and
   * eyes are identical on every player, so six runners still cost three
   * materials rather than eighteen.
   */
  flatMaterial(key: string, hex: string, glow = 0, spec = 0.08): StandardMaterial {
    const id = `flat-${key}`;
    const cached = this.materials.get(id);
    if (cached) { return cached; }

    const base = Color3.FromHexString(hex);
    const mat = new StandardMaterial(id, this.scene);
    mat.diffuseColor = base;
    mat.emissiveColor = glow ? base.scale(glow) : Color3.Black();
    mat.specularColor = new Color3(1, 1, 1).scale(spec);
    mat.specularPower = 48;
    mat.ambientColor = base.scale(0.4);
    mat.freeze();
    this.materials.set(id, mat);
    return mat;
  }

  /** Bright opaque trim, one shade paler than the runner's own colour. */
  visorMaterial(colour: number): StandardMaterial {
    const key = `visor-${colour}`;
    const cached = this.materials.get(key);
    if (cached) { return cached; }
    const base = Color3.FromHexString(PLAYER_COLOURS[colour % PLAYER_COLOURS.length]);
    const mat = new StandardMaterial(key, this.scene);
    const pale = Color3.Lerp(base, new Color3(1, 1, 1), 0.72);
    mat.diffuseColor = pale;
    mat.emissiveColor = pale.scale(0.5);
    mat.specularColor = Color3.Black();
    this.materials.set(key, mat);
    return mat;
  }

  /** A per-player tinted material, cached by colour index. */
  playerMaterial(colour: number, self: boolean): StandardMaterial {
    const key = `player-${colour}-${self ? "self" : "other"}`;
    const cached = this.materials.get(key);
    if (cached) { return cached; }

    const base = Color3.FromHexString(PLAYER_COLOURS[colour % PLAYER_COLOURS.length]);
    const mat = new StandardMaterial(key, this.scene);
    mat.diffuseColor = base;
    mat.emissiveColor = base.scale(self ? 0.4 : 0.24);
    mat.specularColor = new Color3(0.6, 0.6, 0.7);
    mat.specularPower = 64;
    this.materials.set(key, mat);
    return mat;
  }

  /** Keep the shadow frustum wrapped around wherever the player currently is. */
  followShadows(target: Vector3) {
    this.sun.position.set(target.x + 30, target.y + 60, target.z - 26);
  }

  castsAndReceives(mesh: Mesh, cast = true, receive = true) {
    if (cast) { this.shadows.addShadowCaster(mesh, true); }
    mesh.receiveShadows = receive;
  }

  dispose() {
    this.scene.dispose();
    this.engine.dispose();
  }
}
