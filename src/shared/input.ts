/**
 * Wire-input normalization shared by the authoritative room and Stage-0 tests.
 *
 * Network schemas decode untrusted values. This function makes every field the
 * simulation reads finite and within the documented range before an input is
 * buffered, which prevents a malformed packet from poisoning rollback state.
 */
import { PITCH_MAX, PITCH_MIN } from "./constants.js";

export interface MutableRaceInput {
  moveX: number;
  moveZ: number;
  yaw: number;
  pitch: number;
  jump: boolean;
  action: boolean;
  alt: boolean;
  use: boolean;
  respawn: boolean;
}

function axis(value: unknown): -1 | 0 | 1 {
  const numberValue = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return numberValue > 0 ? 1 : numberValue < 0 ? -1 : 0;
}

/** Coerce one decoded packet to the finite, replay-safe simulation contract. */
export function sanitizeRaceInput(frame: MutableRaceInput): void {
  frame.moveX = axis(frame.moveX);
  frame.moveZ = axis(frame.moveZ);
  frame.yaw = Number.isFinite(frame.yaw) ? frame.yaw : 0;
  frame.pitch = Number.isFinite(frame.pitch) ? Math.min(PITCH_MAX, Math.max(PITCH_MIN, frame.pitch)) : 0;
  frame.jump = !!frame.jump;
  frame.action = !!frame.action;
  frame.alt = !!frame.alt;
  frame.use = !!frame.use;
  frame.respawn = !!frame.respawn;
}
