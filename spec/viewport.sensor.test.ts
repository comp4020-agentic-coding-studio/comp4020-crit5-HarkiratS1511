// SENSOR (see spec/README.md's contract-vs-sensor split): this asserts a
// standard that holds regardless of the week's brief, so it carries forward
// unchanged into every future repo. It must therefore stay brief-agnostic —
// no assertions here about text, headings, or copy.
//
// Why this file exists (CLAUDE.md, "What earlier builds taught the harness"
// > Assignment 1): the rest of spec/ runs against static dist/ HTML in
// JSDOM, which cannot see interaction, audio, layout, or overflow. A green
// `pnpm check` proved the hooks existed while the phone layout was still
// broken and a control was burying content. Anything a visitor *sees at a
// viewport* has to be verified by driving the built site in a real
// (headless) browser — this does that at exactly the two viewports the
// deployed site is marked at: 390x844 (phone) and 1920x1080 (desktop).
//
// It serves dist/ itself, under the base path read out of astro.config.ts
// (never hardcoded): a wrong `base` 404s every asset on the live
// "<user>.github.io/<repo>/" URL while looking perfect when served from "/"
// locally, which is exactly the failure this exists to catch. Serving at
// root would defeat the point of the sensor.
//
// Assumes `dist/` already exists — building is the `check` script's job, not
// this file's.
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DIST = resolve("dist");
const ASTRO_CONFIG = resolve("astro.config.ts");
// Gitignored (see .gitignore): these are for a human to look at, not to ship.
const SCREENSHOT_DIR = resolve("spec/screenshots/viewport");

// The two viewports the deployed site is actually marked at.
const VIEWPORTS = [
  { label: "phone-390x844", width: 390, height: 844 },
  { label: "desktop-1920x1080", width: 1920, height: 1080 },
] as const;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
};

// Read `base` out of astro.config.ts instead of hardcoding it, so this file
// works unchanged in next week's repo. Falls back to "/" if there's no Astro
// config to read (still a useful local-overflow check, just not a base-path
// one) or if the config can't be read for any reason.
async function readBasePath(): Promise<string> {
  if (!existsSync(ASTRO_CONFIG)) return "/";
  try {
    const mod = await import(ASTRO_CONFIG);
    const base = (mod.default ?? mod)?.base as string | undefined;
    if (!base) return "/";
    return base.endsWith("/") ? base : `${base}/`;
  } catch {
    return "/";
  }
}

// A minimal static server that serves dist/ under `basePath` — the same
// shape a GitHub Pages project site serves under "/<repo>/". Anything
// outside that prefix 404s, exactly like production, so a wrong base path
// reproduces here instead of only on the live URL.
function serveDistUnderBase(basePath: string): Promise<{ server: Server; origin: string }> {
  return new Promise((resolveServer, rejectServer) => {
    const server = createServer((req, res) => {
      void (async () => {
        try {
          const requestUrl = new URL(req.url ?? "/", "http://localhost");
          const pathname = decodeURIComponent(requestUrl.pathname);
          if (!pathname.startsWith(basePath)) {
            res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found (outside base path)");
            return;
          }
          let relative = pathname.slice(basePath.length);
          if (relative === "" || relative.endsWith("/")) relative += "index.html";
          // astro.config.ts sets build.format "file", so /page builds to
          // dist/page.html; try that shape too before giving up.
          const candidates = [join(DIST, relative), join(DIST, `${relative}.html`)];
          const filePath = candidates.find((candidate) => existsSync(candidate));
          if (!filePath) {
            res.writeHead(404, { "Content-Type": "text/plain" }).end(`Not found: ${pathname}`);
            return;
          }
          const body = await readFile(filePath);
          const type = MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
          res.writeHead(200, { "Content-Type": type }).end(body);
        } catch (error) {
          res.writeHead(500, { "Content-Type": "text/plain" }).end(String(error));
        }
      })();
    });
    server.once("error", rejectServer);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolveServer({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

// Load Playwright lazily and defensively: a bare environment (package not
// installed, or its Chromium binary/OS libraries missing) must not hard-fail
// this file — see the per-test skip below.
let chromiumLaunchError: string | undefined;
let chromium: typeof import("playwright").chromium | undefined;
try {
  ({ chromium } = await import("playwright"));
} catch (error) {
  chromiumLaunchError = `the "playwright" package failed to load (${(error as Error).message}). Run \`pnpm add -D playwright\`.`;
}

let server: Server | undefined;
let origin = "";
let basePath = "/";
let browser: Browser | undefined;
// Set (non-empty) whenever the sensor can't run in this environment; every
// test checks it and skips instead of failing so the rest of the suite
// still runs green in a bare environment.
let unavailableReason: string | undefined = chromiumLaunchError;

beforeAll(async () => {
  if (!existsSync(DIST)) {
    unavailableReason ??= `dist/ not found at ${DIST} — run \`pnpm build\` first (the \`check\` script does this).`;
    return;
  }

  basePath = await readBasePath();
  ({ server, origin } = await serveDistUnderBase(basePath));

  if (unavailableReason || !chromium) {
    unavailableReason ??= 'the "playwright" package did not export `chromium`.';
    return;
  }

  try {
    browser = await chromium.launch();
  } catch (error) {
    // Playwright's top line is usually a generic "target closed"; the useful
    // detail (e.g. a missing shared library) is further down its log.
    const lines = (error as Error).message.split("\n").map((line) => line.trim());
    const detail = lines.find((line) => /error while loading shared|not found|missing|cannot open/i.test(line));
    unavailableReason =
      `Chromium's browser binary is unavailable in this environment (${detail ?? lines[0]}). ` +
      "Run `pnpm exec playwright install chromium` (add `--with-deps` if that names missing " +
      "shared libraries) and re-run `pnpm check:viewport`.";
  }
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((res) => (server ? server.close(() => res()) : res()));
});

describe("viewport sensor (real browser against the built site, real base path)", () => {
  for (const viewport of VIEWPORTS) {
    it(`no horizontal overflow and a clean load at ${viewport.label}`, async (ctx) => {
      if (unavailableReason) {
        console.warn(`[viewport sensor] SKIPPED at ${viewport.label}: ${unavailableReason}`);
        ctx.skip();
        return;
      }

      const page = await browser!.newPage({
        viewport: { width: viewport.width, height: viewport.height },
      });

      const consoleErrors: string[] = [];
      const failedRequests: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });
      page.on("pageerror", (error) => consoleErrors.push(`uncaught exception: ${error.message}`));
      page.on("requestfailed", (request) => {
        failedRequests.push(`${request.method()} ${request.url()} — ${request.failure()?.errorText ?? "failed"}`);
      });
      page.on("response", (response) => {
        if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.url()}`);
      });

      const url = `${origin}${basePath}`;
      const response = await page.goto(url, { waitUntil: "networkidle" });
      expect(response?.ok(), `expected ${url} to load; got status ${response?.status()}`).toBe(true);

      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));

      await mkdir(SCREENSHOT_DIR, { recursive: true });
      const screenshotPath = join(SCREENSHOT_DIR, `${viewport.label}.png`);
      await page.screenshot({ path: screenshotPath });
      console.log(`[viewport sensor] wrote ${screenshotPath}`);

      await page.close();

      expect(
        overflow.scrollWidth,
        `horizontal overflow at ${viewport.label}: document.documentElement.scrollWidth ` +
          `(${overflow.scrollWidth}px) > window.innerWidth (${overflow.innerWidth}px) — ` +
          "something is wider than the viewport.",
      ).toBeLessThanOrEqual(overflow.innerWidth);

      expect(
        consoleErrors,
        `console errors at ${viewport.label}:\n${consoleErrors.join("\n")}`,
      ).toHaveLength(0);

      expect(
        failedRequests,
        `failed or 4xx/5xx network requests at ${viewport.label} (base path served was ` +
          `${JSON.stringify(basePath)} — check astro.config.ts "base" if these are all-404):\n` +
          failedRequests.join("\n"),
      ).toHaveLength(0);
    });
  }
});
