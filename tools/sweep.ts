/**
 * Headless bot sweep.
 *
 *   npm run sweep                    # 200 seeds, hard bot, no enemies
 *   npm run sweep -- 1000 hard       # the full acceptance run
 *   npm run sweep -- 200 easy        # the easy-difficulty floor
 *   npm run sweep -- 200 hard 1      # with the enemy field live
 *
 * Reports the completion rate and, more usefully, the per-section rate: which
 * sections a bot reaches and fails to get through. That second number is the
 * one the section pool is meant to be held to.
 */

import { BOT_PROFILES, type BotProfile } from "../src/rooms/bot.js";
import { sweep } from "../src/rooms/sweep.js";
import { DEFAULT_VERBS } from "../src/shared/level.js";
import { TICK_RATE } from "../src/shared/constants.js";

const seeds = Number(process.argv[2] ?? 200);
const name = (process.argv[3] ?? "hard") as keyof typeof BOT_PROFILES;
const threats = process.argv[4] === "1";

const profile: BotProfile = BOT_PROFILES[name] ?? BOT_PROFILES.hard;
console.log(`sweeping ${seeds} seeds · ${profile.name} bot · threats ${threats ? "on" : "off"}`);

const started = Date.now();
const report = sweep(seeds, profile, { verbs: DEFAULT_VERBS, threats });
const elapsed = (Date.now() - started) / 1000;

console.log("");
console.log(`completion   ${(report.rate * 100).toFixed(1)}%  (${report.finished}/${report.seeds})`);
console.log(`median run   ${report.medianTicks < 0 ? "-" : (report.medianTicks / TICK_RATE).toFixed(1) + "s"}`);
console.log(`sweep took   ${elapsed.toFixed(1)}s  (${(elapsed / seeds * 1000).toFixed(1)} ms/seed)`);

console.log("");
console.log("section                reached  cleared   rate");
for (const s of report.sections) {
  const bar = s.rate >= 0.95 ? "" : s.rate >= 0.8 ? "  <-- soft" : "  <-- FAILS";
  console.log(
    `${s.id.padEnd(20)}   ${String(s.reached).padStart(6)}  ${String(s.cleared).padStart(7)}  ` +
    `${(s.rate * 100).toFixed(1).padStart(5)}%${bar}`,
  );
}

if (report.worst.length > 0) {
  console.log("");
  console.log("first few failures:");
  for (const r of report.worst) {
    console.log(
      `  seed ${String(r.seed).padStart(5)}  progress ${(r.progress * 100).toFixed(1).padStart(5)}%  ` +
      `cp ${r.checkpoint}  falls ${r.falls}  stuck in ${r.stuckIn}`,
    );
  }
}

// Non-zero on a bad sweep, so this can gate a build.
process.exit(report.rate >= 0.5 ? 0 : 1);
