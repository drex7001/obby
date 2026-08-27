/** Small, allocation-free math helpers shared by the simulation and the renderer. */

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) { a += Math.PI * 2; }
  return a - Math.PI;
}

/** Shortest signed angular difference from `a` to `b`. */
export const angleDelta = (a: number, b: number) => wrapAngle(b - a);

/** Triangle wave over [0,1] -> [0,1] -> [0,1]. Used for ping-pong motion. */
export function triangle(t: number): number {
  const x = t - Math.floor(t);
  return x < 0.5 ? x * 2 : 2 - x * 2;
}

/** Smoothstep-eased triangle wave — ping-pong with ease-in/out at each end. */
export function easedTriangle(t: number): number {
  const x = triangle(t);
  return x * x * (3 - 2 * x);
}

/**
 * Frame-rate independent exponential approach. `rate` is roughly "how much of the
 * remaining gap is closed per second".
 */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-rate * dt));
}

/**
 * mulberry32 — a tiny, fast, fully deterministic PRNG.
 *
 * Round variants are generated from a seed the server puts in the state, so every
 * client rebuilds the exact same course layout from the same integer.
 */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rotate (x, z) around the origin by `yaw` radians. */
export function rotateY(x: number, z: number, yaw: number, out: { x: number; z: number }) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  out.x = x * c - z * s;
  out.z = x * s + z * c;
  return out;
}

/** Inverse of {@link rotateY}. */
export function unrotateY(x: number, z: number, yaw: number, out: { x: number; z: number }) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  out.x = x * c + z * s;
  out.z = -x * s + z * c;
  return out;
}

export function formatClock(ms: number): string {
  if (!isFinite(ms) || ms < 0) { ms = 0; }
  const total = Math.floor(ms / 10);
  const centis = total % 100;
  const secs = Math.floor(total / 100) % 60;
  const mins = Math.floor(total / 6000);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(centis).padStart(2, "0")}`;
}

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
