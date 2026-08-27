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

/**
 * Chrome locks out `requestPointerLock()` for a moment after the user presses
 * Escape, and rejects silently while it does. A single retry inside the click's
 * transient-activation window is what turns "clicking does nothing" into
 * "clicking works".
 */
const RELOCK_RETRY_MS = 1400;

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
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners: Array<(locked: boolean) => void> = [];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    addEventListener("keydown", (e) => {
      if (e.repeat) { return; }
      const key = e.key.toLowerCase();
      this.held.add(key);
      // Space scrolls the page and Tab moves focus; neither is wanted in-game.
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
      const locked = document.pointerLockElement === this.canvas;
      if (locked === this.locked) { return; }
      this.locked = locked;
      if (!locked) {
        // Escape and Alt+Tab both drop the lock without delivering keyup, so
        // without this the player keeps sprinting while nobody is driving.
        this.held.clear();
      }
      for (const listener of this.listeners) { listener(locked); }
    });

    document.addEventListener("pointerlockerror", () => this.scheduleRetry());

    addEventListener("mousemove", (e) => {
      if (!this.locked) { return; }
      this.yaw = wrapAngle(this.yaw + e.movementX * this.sensitivity);
      this.pitch = clamp(this.pitch + e.movementY * this.sensitivity, PITCH_MIN, PITCH_MAX);
    });

    canvas.addEventListener("mousedown", () => { void this.lock(); });
  }

  /** Notified whenever the pointer is captured or released. */
  onLockChange(listener: (locked: boolean) => void) {
    this.listeners.push(listener);
  }

  get pointerLocked() { return this.locked; }

  /**
   * Request the pointer. Safe to call from any user gesture; a rejection is
   * almost always the post-Escape lock-out rather than a real failure, so it
   * retries once rather than leaving the player stuck with a dead camera.
   */
  async lock(): Promise<void> {
    if (this.locked) { return; }
    this.clearRetry();
    try {
      await this.canvas.requestPointerLock();
    } catch {
      this.scheduleRetry();
    }
  }

  private scheduleRetry() {
    if (this.locked || this.retryTimer !== null) { return; }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.locked) { return; }
      // Still inside the originating click's transient activation, so the
      // browser accepts this even though no new gesture has happened.
      try {
        const result = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
        void result?.catch?.(() => {});
      } catch {
        // Out of options; the resume overlay stays up and the next click tries.
      }
    }, RELOCK_RETRY_MS);
  }

  private clearRetry() {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /** -1, 0 or 1 - opposite keys cancel, so diagonals stay exact. */
  private axis(negative: string[], positive: string[]): -1 | 0 | 1 {
    const back = negative.some((k) => this.held.has(k));
    const forward = positive.some((k) => this.held.has(k));
    if (back === forward) { return 0; }
    return back ? -1 : 1;
  }

  // Movement is gated on actually holding the pointer. Without the mouse there
  // is no steering, and running blind off a ledge because a key was down when
  // the prompt appeared is worse than simply standing still.
  get moveX() { return this.locked ? this.axis(["a", "arrowleft"], ["d", "arrowright"]) : 0; }
  get moveZ() { return this.locked ? this.axis(["s", "arrowdown"], ["w", "arrowup"]) : 0; }
  get jump() { return this.locked && (this.held.has(" ") || this.held.has("space")); }

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
