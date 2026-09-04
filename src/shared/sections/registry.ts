/**
 * The section pool.
 *
 * Order matters only for readability: the generator picks by role and weight,
 * never by index. Adding a section here is the whole of "adding a section" -
 * nothing else in the codebase names one.
 *
 * | Role     | Sections                                                        |
 * | -------- | --------------------------------------------------------------- |
 * | opener   | Gauntlet, Straightaway, Gallery                                   |
 * | middle   | Drift, Pendulum Pass, Carousel, Works, Spiral, Sieve, Chasm,       |
 * |          | Watchtower, Cascade, Turnstile                                    |
 * | rest     | Straightaway, Turnstile                                           |
 * | climb    | Climb                                                             |
 *
 * Two entries deviate from the pool table in the spec, both because the table
 * as written dead-ends the generator:
 *
 * - **Turnstile also rests.** The spec's own text calls it "a good rest beat
 *   despite the difficulty tag". Without it, a course that opens on the
 *   Straightaway has no rest section left to pick.
 * - **`roles` is a set, not a value.** The pool table already lists the
 *   Straightaway under two roles.
 */

import { carousel, climb, spiral } from "./vault.js";
import { cascade, drift, sieve } from "./impact.js";
import { gauntlet, turnstile, watchtower } from "./carve.js";
import { chasm, pendulum } from "./tether.js";
import { gallery } from "./salvo.js";
import { straightaway } from "./rest.js";
import { works } from "./works.js";
import type { SectionDef } from "./types.js";

export const SECTIONS: readonly SectionDef[] = [
  gauntlet,
  drift,
  pendulum,
  carousel,
  works,
  climb,
  spiral,
  sieve,
  gallery,
  chasm,
  watchtower,
  cascade,
  turnstile,
  straightaway,
];

export const sectionById = (id: string): SectionDef | undefined =>
  SECTIONS.find((s) => s.id === id);
