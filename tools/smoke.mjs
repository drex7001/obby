/**
 * Browser smoke test.
 *
 * Drives two real Chrome clients against a running dev server, plays for a
 * while, and reports console errors alongside the simulation state each client
 * believes it is in. Its main job is catching the class of bug unit tests
 * cannot: a renderer that throws, prediction that diverges from the server, or
 * a match that never leaves the lobby.
 *
 * Start the server first (`npm run dev`), then:
 *   GAME_URL=http://localhost:5173/ npm run smoke
 *
 * Uses the system Chrome via playwright-core, so nothing is downloaded.
 */
import { chromium } from "playwright-core";

const URL = process.env.GAME_URL ?? "http://localhost:5173/";
const SHOTS = process.env.SHOT_DIR ?? ".";

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--disable-gpu-sandbox",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

const errors = [];

async function openClient(label, name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 } });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    const t = m.type();
    if (t === "error" || t === "warning") {
      const text = m.text();
      // Babylon chats about swiftshader; not interesting.
      if (/swiftshader|WebGL|GPU stall|Fallback/i.test(text)) return;
      errors.push(`[${label}] ${t}: ${text}`);
    }
  });
  page.on("pageerror", (e) => errors.push(`[${label}] pageerror: ${e.message}`));

  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.fill("#name-input", name);
  await page.click("#join-btn");
  await page.waitForFunction(() => typeof window.__gauntlet === "function", null, { timeout: 20000 });
  return page;
}

const snap = (page) => page.evaluate(() => window.__gauntlet());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function hold(page, keys, ms) {
  for (const k of keys) await page.keyboard.down(k);
  await wait(ms);
  for (const k of keys) await page.keyboard.up(k);
}

console.log("--- opening two clients ---");
const a = await openClient("A", "Alpha");
const b = await openClient("B", "Bravo");
await wait(2500);

console.log("A:", JSON.stringify(await snap(a)));
console.log("B:", JSON.stringify(await snap(b)));

// Two players present -> the room should be counting down, then racing.
await wait(6000);
const racing = await snap(a);
console.log("after countdown ->", racing.phase, "raceStartTick", racing.raceStartTick);
await a.screenshot({ path: `${SHOTS}/01-race-start.png` });

console.log("--- running forward ---");
await hold(a, ["w"], 4000);
const ran = await snap(a);
console.log("A after running:", JSON.stringify(ran));
await a.screenshot({ path: `${SHOTS}/02-running.png` });

// Both move, so player-vs-player and remote interpolation get exercised.
await Promise.all([hold(a, ["w"], 3000), hold(b, ["w", "d"], 3000)]);
await a.screenshot({ path: `${SHOTS}/03-two-players.png` });
console.log("A:", JSON.stringify(await snap(a)));
console.log("B:", JSON.stringify(await snap(b)));

console.log("--- jumping ---");
await page_jump(a);
async function page_jump(page) {
  for (let i = 0; i < 4; i++) {
    await page.keyboard.down("w");
    await page.keyboard.press("Space");
    await wait(500);
  }
  await page.keyboard.up("w");
}
const jumped = await snap(a);
console.log("A after jumps:", JSON.stringify(jumped));
await a.screenshot({ path: `${SHOTS}/04-jump.png` });

console.log("--- results screen ---");
await a.evaluate(() => {
  window.__ui.showResults([
    { sessionId: "1", name: "Alpha", colour: 0, rank: 1, progress: 1, finished: true, dnf: false, finishMs: 82340, self: true },
    { sessionId: "2", name: "Bravo", colour: 1, rank: 2, progress: 1, finished: true, dnf: false, finishMs: 89120, self: false },
    { sessionId: "3", name: "Charlie", colour: 2, rank: 3, progress: 1, finished: true, dnf: false, finishMs: 104870, self: false },
    { sessionId: "4", name: "Delta", colour: 3, rank: 4, progress: 0.62, finished: false, dnf: true, finishMs: 0, self: false },
  ], "Final standings");
  window.__ui.setResultsCountdown(7);
});
await wait(400);
await a.screenshot({ path: `${SHOTS}/05-results.png` });
await a.evaluate(() => window.__ui.hideResults());

console.log("--- errors ---");
if (errors.length === 0) console.log("none");
else errors.slice(0, 25).forEach((e) => console.log(e));

await browser.close();
