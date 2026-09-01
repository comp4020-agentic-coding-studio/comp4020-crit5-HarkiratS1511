import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const REPO = new URL("..", import.meta.url).pathname;
const BASE = "/comp4020-crit5-HarkiratS1511";
const DIST = join(REPO, "dist");
const OUT = process.env.SHOT_DIR;
const HOLD = Number(process.env.HOLD_MS ?? 120);
const SKIP = process.env.SKIP_GAP === undefined ? -1 : Number(process.env.SKIP_GAP);
const TAG = process.env.TAG ?? "";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (!p.startsWith(BASE)) { res.writeHead(404); return res.end("outside base"); }
    p = p.slice(BASE.length) || "/";
    if (p.endsWith("/")) p += "index.html";
    const file = join(DIST, normalize(p));
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404); res.end("nf"); }
});
await new Promise((r) => server.listen(0, r));
const url = `http://127.0.0.1:${server.address().port}${BASE}/`;

const log = [];
const samples = [];
const say = (m) => { log.push(m); console.log(m); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__inkDebug !== undefined, { timeout: 5000 });

const read = () => page.evaluate(() => {
  const d = window.__inkDebug;
  const s = d.state;
  return {
    phase: s.phase, ink: s.ink, maxInk: s.maxInk, elapsed: s.elapsed,
    levelIndex: s.levelIndex, ghost: s.ghost ? { x: s.ghost.pos.x, y: s.ghost.pos.y, goneFor: s.ghost.goneFor } : null,
    x: s.runner.pos.x, y: s.runner.pos.y, grounded: s.runner.grounded,
    chaserX: s.chaser.pos.x, strokes: s.strokes.length,
    finishX: s.level.finishX, t: d.transform,
    ground: s.level.groundSegments.map((g) => [g.a.x, g.a.y, g.b.x, g.b.y]),
  };
});

const shot = async (name) => { await page.screenshot({ path: join(OUT, TAG + name + ".png") }); };

const st0 = await read();
await shot("01-opening");
say(`opening: level=${st0.levelIndex} x=${st0.x.toFixed(0)} ink=${st0.ink.toFixed(0)} scale=${st0.t.scale.toFixed(3)} ghost=${st0.ghost ? `x=${st0.ghost.x.toFixed(0)}` : "none"}`);

// Derive gaps from ground segments.
const surfaceY = (x, ground) => {
  let best = null;
  for (const [ax, ay, bx, by] of ground) {
    const lo = Math.min(ax, bx), hi = Math.max(ax, bx);
    if (x < lo || x > hi) continue;
    const span = bx - ax;
    const y = ay + (by - ay) * (Math.abs(span) < 1e-6 ? 0 : (x - ax) / span);
    if (best === null || y < best) best = y;
  }
  return best;
};
const gaps = [];
{
  let open = null;
  for (let x = 0; x <= st0.finishX; x += 2) {
    const solid = surfaceY(x, st0.ground) !== null;
    if (!solid && open === null) open = x;
    if (solid && open !== null) { gaps.push({ from: open, to: x }); open = null; }
  }
}
say(`gaps: ${gaps.length} -> ${gaps.map((g) => `${g.from}-${g.to}`).join(" ")}`);

const toScreen = (wx, wy, t) => ({ x: (wx - t.camera) * t.scale, y: (wy - t.cameraY) * t.scale });

let midDrawShot = false, chaserShot = false;
for (const [gi, gap] of gaps.entries()) {
  // Wait until the gap is close enough to draw for.
  for (;;) {
    const s = await read();
    if (s.phase !== "running") break;
    if (s.x >= gap.from - 260) break;
    samples.push(`${s.elapsed.toFixed(2)} x=${s.x.toFixed(0)} y=${s.y.toFixed(0)} g=${s.grounded ? 1 : 0} cg=${(s.x - s.chaserX).toFixed(0)}`);
    await page.waitForTimeout(30);
  }
  let s = await read();
  if (s.phase !== "running") break;
  if (gi === SKIP) {
    say(`gap ${gap.from}-${gap.to}: DELIBERATELY NOT DRAWN`);
    for (let k = 0; k < 60; k++) {
      const q = await read();
      if (q.phase !== "running") break;
      await page.waitForTimeout(25);
    }
    const q = await read();
    say(`after skipped gap: phase=${q.phase} y=${q.y.toFixed(0)}`);
    if (q.phase !== "running") break;
    continue;
  }

  const yF = surfaceY(gap.from - 8, s.ground), yT = surfaceY(gap.to + 8, s.ground);
  if (yF === null || yT === null) continue;

  const a = toScreen(gap.from - 8, yF - 4, s.t);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.waitForTimeout(HOLD);

  if (!midDrawShot) { await shot("02-mid-draw-slowmo"); midDrawShot = true; say("captured mid-draw (slow motion active)"); }

  // Interpolate in WORLD space and re-project each step: mouse.move's own
  // stepping works in screen space, and the camera scrolls mid-drag, which
  // bends a straight line into a hook.
  const wx0 = gap.from - 8, wy0 = yF - 4, wx1 = gap.to + 8, wy1 = yT - 4;
  for (let k = 1; k <= 10; k++) {
    const f = k / 10;
    const t = (await read()).t;
    const q = toScreen(wx0 + (wx1 - wx0) * f, wy0 + (wy1 - wy0) * f, t);
    await page.mouse.move(q.x, q.y);
  }
  await page.mouse.up();

  s = await read();
  say(`gap ${gap.from}-${gap.to}: strokes=${s.strokes} ink=${s.ink.toFixed(0)} x=${s.x.toFixed(0)} chaserGap=${(s.x - s.chaserX).toFixed(0)} phase=${s.phase}`);
  if (!chaserShot && s.x - s.chaserX < 900) { await shot("03-chaser-close"); chaserShot = true; say("captured chaser in view"); }
  if (s.phase !== "running") break;
}

for (let i = 0; i < 400; i++) {
  const s = await read();
  if (s.phase !== "running") break;
  await page.waitForTimeout(50);
}
// Sample the final seconds so a stall is visible, and dump the real strokes.
const trace = await page.evaluate(() => {
  const s = window.__inkDebug.state;
  return {
    strokes: s.strokes.map((st) => st.points.map((p) => [Math.round(p.x), Math.round(p.y)])),
  };
});
say("committed strokes: " + JSON.stringify(trace.strokes));
const end = await read();
// Capture during the impact hold, then again once the end screen has settled.
await shot(end.phase === "won" ? "04a-impact-won" : "04a-impact-lost");
await page.waitForTimeout(2200);
await shot(end.phase === "won" ? "04b-screen-won" : "04b-screen-lost");
say(`FINAL: phase=${end.phase} x=${end.x.toFixed(0)}/${end.finishX} ink=${end.ink.toFixed(0)} strokes=${end.strokes} elapsed=${end.elapsed.toFixed(1)}s`);
say("last samples:\n" + samples.slice(-22).join("\n"));
say(`console errors: ${errors.length}${errors.length ? " -> " + errors.slice(0, 3).join(" | ") : ""}`);

await browser.close();
server.close();
