/**
 * The mutator deck.
 *
 * Fourteen sections times a dozen modifiers is a far larger space than fourteen
 * sections, which makes this the highest value-per-line feature in the plan.
 *
 * Two rules keep it safe, and both are structural rather than a matter of care:
 *
 * 1. **Nothing is rolled at runtime.** A round's mutators come out of the seed,
 *    or are handed in whole by the room. Either way both ends compute the same
 *    list before the course is built.
 * 2. **Anything a mutator varies lives on the `Level`.** A mutator that reached
 *    into `constants.ts` would change the server's number and not the client's,
 *    because the client compiled its own copy in. `Tuning` exists for exactly
 *    this, and the migration that created it was the first task of the stage.
 */

import { mulberry32 } from "./math.js";
import type { Tuning } from "./level.js";
import type { Verb } from "./sections/types.js";

export type MutatorId =
  | "lowgravity" | "rushhour" | "suddendeath" | "greasy" | "chainreaction"
  | "notether" | "fog" | "marathon" | "sprint" | "mirror" | "crowded" | "oneshot";

export interface MutatorDef {
  id: MutatorId;
  name: string;
  /** One line for the lobby, which is where these are announced. */
  note: string;
  /** Mutators this cannot be drawn alongside. Symmetric; declared once. */
  clashes?: readonly MutatorId[];
}

export const MUTATORS: readonly MutatorDef[] = [
  { id: "lowgravity", name: "Low gravity", note: "Everything hangs" },
  {
    id: "rushhour", name: "Rush hour", note: "Every moving part, a quarter faster",
    // A shortened sightline and a shortened telegraph are the same cut twice.
    clashes: ["fog"],
  },
  { id: "suddendeath", name: "Sudden death", note: "No checkpoints. One fall ends it" },
  { id: "greasy", name: "Greasy", note: "Nothing stops when you do" },
  { id: "chainreaction", name: "Chain reaction", note: "The Chain builds and breaks twice as fast" },
  { id: "notether", name: "No tether", note: "The rope stays home" },
  { id: "fog", name: "Fog", note: "You will see it late" },
  { id: "marathon", name: "Marathon", note: "Eight sections" , clashes: ["sprint"] },
  { id: "sprint", name: "Sprint", note: "Four sections, double points", clashes: ["marathon"] },
  { id: "mirror", name: "Mirror", note: "The course you know, the other way round" },
  { id: "crowded", name: "Crowded", note: "Everybody shoves twice as hard" },
  { id: "oneshot", name: "One shot", note: "An influence charge each, runners included" },
];

const BY_ID = new Map(MUTATORS.map((m) => [m.id, m]));

export const mutatorById = (id: string) => BY_ID.get(id as MutatorId);

/** Can these two be in play together? Declared on one and honoured on both. */
export function compatible(a: MutatorId, b: MutatorId): boolean {
  if (a === b) { return false; }
  return !(BY_ID.get(a)?.clashes?.includes(b) || BY_ID.get(b)?.clashes?.includes(a));
}

/**
 * The one or two mutators a seed is worth.
 *
 * On its own stream, deliberately: the course draw must not shift depending on
 * how many mutators came out, or two clients that disagreed about the deck for
 * even a moment would build different courses.
 */
export function drawMutators(seed: number): MutatorId[] {
  const rand = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  // A third of rounds run clean. Variety needs a baseline to vary from.
  if (rand() < 0.34) { return []; }

  const first = MUTATORS[Math.floor(rand() * MUTATORS.length)].id;
  if (rand() < 0.55) { return [first]; }

  const partners = MUTATORS.filter((m) => compatible(first, m.id));
  if (partners.length === 0) { return [first]; }
  const second = partners[Math.floor(rand() * partners.length)].id;
  return [first, second].sort();
}

/** Drop anything that clashes with something already in the list. */
export function sanitizeMutators(ids: readonly string[]): MutatorId[] {
  const out: MutatorId[] = [];
  for (const raw of ids) {
    const id = raw as MutatorId;
    if (!BY_ID.has(id)) { continue; }
    if (out.every((held) => compatible(held, id))) { out.push(id); }
  }
  return out.sort();
}

/** How the deck bends the numbers both ends read off the level. */
export function applyTuning(tuning: Tuning, ids: readonly MutatorId[]): Tuning {
  for (const id of ids) {
    switch (id) {
      case "lowgravity": tuning.gravity *= 0.7; break;
      case "greasy": tuning.groundFriction *= 0.5; break;
      case "crowded": tuning.pushStrength *= 2; break;
      case "chainreaction":
        tuning.chainDecayTicks = Math.round(tuning.chainDecayTicks * 0.5);
        tuning.chainGain = 2;
        break;
      default: break;
    }
  }
  return tuning;
}

/** Sections in the course, counting the opener, the rest beat and the Climb. */
export function sectionCount(ids: readonly MutatorId[]): number {
  if (ids.includes("marathon")) { return 8; }
  if (ids.includes("sprint")) { return 4; }
  return 7;
}

/** Verbs the deck withholds. */
export function withheldVerbs(ids: readonly MutatorId[]): readonly Verb[] {
  return ids.includes("notether") ? ["tether"] : [];
}

/** Series points multiplier. Sprint is short, so it is worth double. */
export const seriesMultiplier = (ids: readonly MutatorId[]) =>
  ids.includes("sprint") ? 2 : 1;

export const mutatorNotes = (ids: readonly MutatorId[]) =>
  ids.map((id) => {
    const def = BY_ID.get(id)!;
    return `${def.name}: ${def.note}`;
  });
