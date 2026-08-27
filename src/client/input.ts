/**
 * Keyboard and mouse, turned into the two axes + yaw the wire carries.
 *
 * Yaw lives here rather than in the camera because it is genuinely an input:
 * the simulation needs it to resolve camera-relative movement, and it has to be
 * the *same* yaw the server sees, so it is sampled once per fixed step and sent.
 */

import { clamp, wrapAngle } from "../shared/math.js";

const PITCH_MIN = -0.42;
const PITCH_MAX = 1.02;

export class Input {
  /** Camera heading, radians. Forward is `(sin yaw, cos yaw)`. */
  yaw = 0;
  /** Camera elevation, radians. Presentation only - never sent. */
  pitch = 0.30;

  private held = new Set<string>();
  private canvas: HTMLCanvasElement;
  private sensitivity = 0.0023;
  private locked = false;
  private respawnLatch = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    addEventListener("keydown", (e) => {
      if (e.repeat) { return; }
      const key = e.key.toLowerCase();
      this.held.add(key);
      // Space scrolls the page and R reloads with a modifier; neither is wanted.
      if (key === " " || key === "tab") { e.preventDefault(); }
      if (key === "r" && !e.ctrlKey && !e.metaKey) { this.respawnLatch = true; }
    });

    addEventListener("keyup", (e) => this.held.delete(e.key.toLowerCase()));

    // A tab that loses focus must not leave keys stuck down.
    addEventListener("blur", () => this.held.clear());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { this.held.clear(); }
    });

    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === this.canvas;
    });

    addEventListener("mousemove", (e) => {
      if (!this.locked) { return; }
      this.yaw = wrapAngle(this.yaw + e.movementX * this.sensitivity);
      this.pitch = clamp(this.pitch + e.movementY * this.sensitivity, PITCH_MIN, PITCH_MAX);
    });

    canvas.addEventListener("mousedown", () => { void this.lock(); });
  }

  async lock() {
    if (this.locked) { return; }
    try {
      await this.canvas.requestPointerLock();
    } catch {
      // Browsers rate-limit re-locking after an Escape; the next click works.
    }
  }

  get pointerLocked() { return this.locked; }

  /** -1, 0 or 1 - opposite keys cancel, so diagonals stay exact. */
  private axis(negative: string[], positive: string[]): -1 | 0 | 1 {
    const back = negative.some((k) => this.held.has(k));
    const forward = positive.some((k) => this.held.has(k));
    if (back === forward) { return 0; }
    return back ? -1 : 1;
  }

  get moveX() { return this.axis(["a", "arrowleft"], ["d", "arrowright"]); }
  get moveZ() { return this.axis(["s", "arrowdown"], ["w", "arrowup"]); }
  get jump() { return this.held.has(" ") || this.held.has("space"); }

  /**
   * True exactly once per press. Respawn is a one-shot action, and letting it
   * ride on the held state would re-trigger it every tick the key is down.
   */
  takeRespawn(): boolean {
    if (!this.respawnLatch) { return false; }
    this.respawnLatch = false;
    return true;
  }
}
