/**
 * Feedback: particle bursts and a small synthesised sound set.
 *
 * Both are deliberately asset-free. The particles are a fixed pool of little
 * emissive boxes (which suits the chunky art direction better than a soft
 * sprite would), and the sounds are oscillator blips built at runtime - so the
 * whole game ships as code with nothing to load.
 *
 * Nothing here is ever driven from a rollback replay: the shared step only
 * calls `fx()` on live steps, so a re-simulated jump cannot re-trigger a sound.
 */

import { Color3 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";

import type { FxKind } from "../../shared/movement.js";
import type { Stage } from "./scene.js";

const POOL = 90;

interface Particle {
  mesh: Mesh;
  vx: number; vy: number; vz: number;
  life: number;
  max: number;
  spin: number;
}

const TONES: Record<FxKind, { freq: number; to: number; ms: number; type: OscillatorType; gain: number }> = {
  jump: { freq: 380, to: 620, ms: 110, type: "triangle", gain: 0.16 },
  land: { freq: 190, to: 120, ms: 90, type: "sine", gain: 0.2 },
  hit: { freq: 220, to: 70, ms: 250, type: "sawtooth", gain: 0.26 },
  respawn: { freq: 300, to: 760, ms: 260, type: "sine", gain: 0.2 },
  checkpoint: { freq: 620, to: 940, ms: 220, type: "triangle", gain: 0.24 },
  perfect: { freq: 760, to: 1180, ms: 130, type: "triangle", gain: 0.28 },
  fumble: { freq: 170, to: 80, ms: 210, type: "sawtooth", gain: 0.22 },
  heavy: { freq: 90, to: 42, ms: 360, type: "sawtooth", gain: 0.34 },
  hop: { freq: 510, to: 820, ms: 150, type: "triangle", gain: 0.22 },
};

const TINTS: Record<FxKind, string> = {
  jump: "#9fb4ff",
  land: "#8b96c4",
  hit: "#ff6b8a",
  respawn: "#6ee7ff",
  checkpoint: "#6ee787",
  perfect: "#fff1a6",
  fumble: "#ff9b78",
  heavy: "#ffcf72",
  hop: "#b9f6ff",
};

export class Fx {
  private stage: Stage;
  private pool: Particle[] = [];
  private cursor = 0;
  private audio: AudioContext | null = null;
  private master: GainNode | null = null;
  private materials = new Map<string, StandardMaterial>();

  constructor(stage: Stage) {
    this.stage = stage;

    const proto = MeshBuilder.CreateBox("fx-proto", { size: 0.2 }, stage.scene);
    proto.isPickable = false;
    proto.setEnabled(false);

    for (let i = 0; i < POOL; i++) {
      const mesh = proto.clone(`fx-${i}`);
      mesh.isPickable = false;
      mesh.setEnabled(false);
      this.pool.push({ mesh, vx: 0, vy: 0, vz: 0, life: 0, max: 1, spin: 0 });
    }
    proto.dispose();
  }

  /** Must be called from a user gesture, or the browser will not start audio. */
  enableAudio() {
    if (this.audio) { void this.audio.resume(); return; }
    try {
      this.audio = new AudioContext();
      this.master = this.audio.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.audio.destination);
    } catch {
      // No audio available; the game is perfectly playable without it.
      this.audio = null;
    }
  }

  private tint(kind: FxKind): StandardMaterial {
    const cached = this.materials.get(kind);
    if (cached) { return cached; }
    const base = Color3.FromHexString(TINTS[kind]);
    const mat = new StandardMaterial(`fx-mat-${kind}`, this.stage.scene);
    mat.diffuseColor = base;
    mat.emissiveColor = base.scale(0.9);
    mat.specularColor = Color3.Black();
    mat.disableLighting = true;
    this.materials.set(kind, mat);
    return mat;
  }

  /**
   * `distance` is how far the event was from the camera; far-off events skip
   * their sound so a six-player pile-up does not turn into noise.
   */
  burst(kind: FxKind, x: number, y: number, z: number, distance: number) {
    const count = kind === "hit" ? 14 : kind === "land" ? 6 : 10;
    const speed = kind === "hit" ? 7 : 4;
    const mat = this.tint(kind);

    for (let i = 0; i < count; i++) {
      const p = this.pool[this.cursor];
      this.cursor = (this.cursor + 1) % POOL;

      const theta = Math.random() * Math.PI * 2;
      const lift = kind === "land" ? 0.25 : 0.85;
      p.mesh.material = mat;
      p.mesh.position.set(x, y + 0.25, z);
      p.mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      const scale = 0.5 + Math.random() * 0.9;
      p.mesh.scaling.setAll(scale);
      p.mesh.setEnabled(true);

      p.vx = Math.cos(theta) * speed * (0.35 + Math.random() * 0.65);
      p.vz = Math.sin(theta) * speed * (0.35 + Math.random() * 0.65);
      p.vy = speed * lift * (0.4 + Math.random() * 0.8);
      p.max = 0.42 + Math.random() * 0.4;
      p.life = p.max;
      p.spin = (Math.random() - 0.5) * 14;
    }

    if (distance < 60) {
      this.tone(kind, Math.max(0.12, 1 - distance / 60));
    }
  }

  private tone(kind: FxKind, volume: number) {
    const ctx = this.audio;
    if (!ctx || !this.master) { return; }
    const spec = TONES[kind];
    const now = ctx.currentTime;
    const seconds = spec.ms / 1000;

    const osc = ctx.createOscillator();
    osc.type = spec.type;
    osc.frequency.setValueAtTime(spec.freq, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, spec.to), now + seconds);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(spec.gain * volume, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + seconds);

    osc.connect(gain).connect(this.master);
    osc.start(now);
    osc.stop(now + seconds + 0.02);
  }

  /** A short rising arpeggio for crossing the finish line. */
  fanfare() {
    const ctx = this.audio;
    if (!ctx || !this.master) { return; }
    [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
      const now = ctx.currentTime + i * 0.09;
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.22, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
      osc.connect(gain).connect(this.master);
      osc.start(now);
      osc.stop(now + 0.32);
    });
  }

  update(dt: number) {
    for (const p of this.pool) {
      if (p.life <= 0) { continue; }
      p.life -= dt;
      if (p.life <= 0) { p.mesh.setEnabled(false); continue; }

      p.vy -= 26 * dt;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;
      p.mesh.rotation.y += p.spin * dt;
      p.mesh.rotation.x += p.spin * 0.6 * dt;

      const k = p.life / p.max;
      p.mesh.scaling.setAll(Math.max(0.02, k * 1.1));
    }
  }
}
