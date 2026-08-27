/** Verifies the pointer-lock recovery path and the render-clock alignment. */
import { chromium } from "playwright-core";

const URL = process.env.GAME_URL ?? "http://localhost:5173/";
const SHOTS = process.env.SHOT_DIR ?? ".";
const browser = await chromium.launch({
  channel: "chrome", headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.fill("#name-input", "Alpha");
await page.click("#join-btn");
await page.waitForFunction(() => typeof window.__gauntlet === "function", null, { timeout: 20000 });
await wait(1500);

const resumeShown = () => page.evaluate(() => !document.getElementById("resume").hidden);
const locked = () => page.evaluate(() => document.pointerLockElement !== null);

console.log("after join      -> locked:", await locked(), " resume prompt:", await resumeShown());

// Simulate Escape / Alt+Tab dropping the lock.
await page.evaluate(() => document.exitPointerLock());
await wait(600);
console.log("after lock lost -> locked:", await locked(), " resume prompt:", await resumeShown());
await page.screenshot({ path: `${SHOTS}/06-resume.png` });

// Keys must not stay stuck down while nobody is driving.
await page.keyboard.down("w");
await wait(200);
const movingWhileUnlocked = await page.evaluate(() => {
  const a = window.__gauntlet().self.z;
  return new Promise((r) => setTimeout(() => r(window.__gauntlet().self.z - a), 600));
});
await page.keyboard.up("w");
console.log("held W while unlocked -> travelled", movingWhileUnlocked.toFixed(3), "units");

// Clicking the prompt should ask for the pointer back.
await page.click("#resume-btn");
await wait(1800);
console.log("after click     -> locked:", await locked(), " resume prompt:", await resumeShown());

// --- render clock: obstacles must be drawn at the tick collision resolved at.
const samples = await page.evaluate(() => new Promise((resolve) => {
  const out = [];
  let n = 0;
  const tick = () => {
    const g = window.__gauntlet();
    out.push({ t: performance.now(), rendered: g.simTickRendered, state: g.self.simTick });
    if (++n < 40) requestAnimationFrame(tick); else resolve(out);
  };
  requestAnimationFrame(tick);
}));
let monotonic = true, maxLead = 0;
for (let i = 1; i < samples.length; i++) {
  if (samples[i].rendered < samples[i - 1].rendered - 1e-6) monotonic = false;
  maxLead = Math.max(maxLead, samples[i].state - samples[i].rendered);
}
const span = samples[samples.length - 1].rendered - samples[0].rendered;
const secs = (samples[samples.length - 1].t - samples[0].t) / 1000;
console.log("render clock: monotonic", monotonic,
  "| rate", (span / secs).toFixed(2), "ticks/s (want ~30)",
  "| lag behind sim", maxLead.toFixed(3), "ticks (want <=1)");

console.log("errors:", errors.length ? errors.join(" | ") : "none");
await browser.close();
