/**
 * Recall's history ring.
 *
 * A fixed ring of past `SimState` snapshots, one per world tick, kept by both
 * ends and synchronised by neither. It is never sent: the *result* of a restore
 * is ordinary simulated state that the reconciler already handles, and the ring
 * that produced it is a local detail on each side.
 *
 * The slots are indexed by **world tick**, not by insertion order, and each one
 * remembers which tick it holds. That is what makes recording idempotent under
 * rollback: a client replaying twenty unacknowledged inputs writes the same
 * twenty slots with the same twenty values, rather than shunting a queue along
 * and remembering a different past every time it re-simulates.
 *
 * Samples older than the replay window were written by the original prediction
 * and are never revisited, so a client that mispredicted has a slightly wrong
 * memory of where it was. That is precisely what the freeze is for: the server
 * restores from its own ring, and the correction lands while the player is not
 * moving.
 */

import { RECALL_HISTORY } from "./constants.js";

export interface RecallSample {
  /** World tick this slot holds, or -1 when it has never been written. */
  tick: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  grounded: boolean;
  groundId: number;
}

export type RecallRing = RecallSample[];

export function makeRecallRing(): RecallRing {
  const ring: RecallRing = new Array(RECALL_HISTORY);
  for (let i = 0; i < RECALL_HISTORY; i++) {
    ring[i] = {
      tick: -1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
      grounded: false, groundId: 0,
    };
  }
  return ring;
}

export function clearRecallRing(ring: RecallRing) {
  for (const slot of ring) { slot.tick = -1; }
}

/** Ring index for a world tick. Negative ticks are legal - see `tickBase`. */
function slotOf(tick: number): number {
  return ((tick % RECALL_HISTORY) + RECALL_HISTORY) % RECALL_HISTORY;
}

export function recordRecall(
  ring: RecallRing, tick: number,
  x: number, y: number, z: number,
  vx: number, vy: number, vz: number,
  grounded: boolean, groundId: number,
) {
  const slot = ring[slotOf(tick)];
  slot.tick = tick;
  slot.x = x; slot.y = y; slot.z = z;
  slot.vx = vx; slot.vy = vy; slot.vz = vz;
  slot.grounded = grounded;
  slot.groundId = groundId;
}

/**
 * The sample for exactly `tick`, or null if the ring never held it.
 *
 * The tick check is the whole safety story: a slot whose tick does not match is
 * a wrapped-around memory of a different moment, and restoring to it would put
 * a player two seconds into their own past with no warning.
 */
export function recallSampleAt(ring: RecallRing, tick: number): RecallSample | null {
  const slot = ring[slotOf(tick)];
  return slot.tick === tick ? slot : null;
}
