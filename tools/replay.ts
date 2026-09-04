/**
 * Record a race and prove it replays.
 *
 *   npm run replay                   # 20 seeds, recorded and verified
 *   npm run replay -- 60             # 60 seeds
 *   npm run replay -- 20 out.json    # also write the first recording out
 *   npm run replay -- --file r.json  # verify a recording from disk
 *
 * Exits non-zero on any divergence, so it can gate a build. That is the whole
 * value: it turns determinism from something the codebase relies on into
 * something it proves, and the first honest run of it on a new feature is
 * where drift nobody knew about surfaces.
 */

import { writeFileSync, readFileSync } from "node:fs";

import { BOT_PROFILES } from "../src/rooms/bot.js";
import { recordCourse } from "../src/rooms/sweep.js";
import { replayRecording, type RaceRecording } from "../src/rooms/replay.js";
import { DEFAULT_VERBS } from "../src/shared/level.js";

if (process.argv[2] === "--file") {
  const recording = JSON.parse(readFileSync(process.argv[3], "utf8")) as RaceRecording;
  const result = replayRecording(recording);
  console.log(result.ok
    ? `ok · ${result.ticks} ticks · ${result.stamps} stamps regenerated and matched`
    : `DIVERGED · ${result.divergence}`);
  process.exit(result.ok ? 0 : 1);
}

const seeds = Number(process.argv[2] ?? 20);
const out = process.argv[3];

let checked = 0;
let stamps = 0;
let bytes = 0;
const started = Date.now();

for (let seed = 1; seed <= seeds; seed++) {
  const { recording } = recordCourse(seed, BOT_PROFILES.fair, {
    verbs: DEFAULT_VERBS, threats: true,
  });
  if (seed === 1 && out) {
    writeFileSync(out, JSON.stringify(recording));
    console.log(`wrote ${out}`);
  }
  bytes += JSON.stringify(recording).length;

  const result = replayRecording(recording);
  if (!result.ok) {
    console.error(`seed ${seed} DIVERGED: ${result.divergence}`);
    process.exit(1);
  }
  checked++;
  stamps += result.stamps;
}

const elapsed = (Date.now() - started) / 1000;
console.log(
  `ok · ${checked} races replayed bit-identically · ${stamps} stamps matched · ` +
  `${(bytes / checked / 1024).toFixed(0)} KB per race · ${elapsed.toFixed(1)}s`,
);
