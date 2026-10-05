import assert from "node:assert/strict";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { Miniflare } from "miniflare";
import { chromium } from "playwright";
const did = "did:plc:jhvnnnd3adml7t6anu3ay7ip";
const uri = `at://${did}/app.bsky.feed.post/fixture`;
const post = {
  uri,
  cid: "bafyreid3l3mpwbadpafmoajnc2ukaaf42cmnti6shcomrrqnqq4ctap5xy",
  indexedAt: new Date().toISOString(),
  author: { did, handle: "kualta.dev", displayName: "ku" },
  record: { $type: "app.bsky.feed.post", text: "Public permalink text", createdAt: new Date().toISOString() },
  embed: {
    $type: "app.bsky.embed.images#view",
    images: [
      {
        alt: "Fixture image",
        thumb: "https://cdn.bsky.app/fixture.jpg",
        fullsize: "https://cdn.bsky.app/fixture.jpg",
        aspectRatio: { width: 1, height: 1 },
      },
    ],
  },
};
let mode = "ok";
const assetRoot = resolve("dist/client");
const mime = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".json": "application/json",
};
const modules = (await readdir("dist/server", { recursive: true }))
  .filter((file) => file.endsWith(".mjs"))
  .sort((a, b) => (a === "entry.mjs" ? -1 : b === "entry.mjs" ? 1 : a.localeCompare(b)))
  .map((file) => ({ type: "ESModule", path: resolve("dist/server", file) }));
const mf = new Miniflare({
  modules,
  modulesRoot: resolve("dist/server"),
  compatibilityDate: "2026-05-18",
  compatibilityFlags: ["nodejs_compat"],
  kvNamespaces: ["SESSION", "ACTIVITY_CACHE"],
  d1Databases: ["NEWSLETTER_DB"],
  r2Buckets: ["PUBLISHER_MEDIA"],
  port: 8799,
  host: "127.0.0.1",
  serviceBindings: {
    ASSETS: async (request) => {
      const file = resolve(assetRoot, `.${new URL(request.url).pathname}`);
      if (!file.startsWith(assetRoot + sep)) return new Response("Missing", { status: 404 });
      try {
        return new Response(await readFile(file), {
          headers: { "content-type": mime[extname(file)] || "application/octet-stream" },
        });
      } catch {
        return new Response("Missing", { status: 404 });
      }
    },
  },
  outboundService: async (request) => {
    if (new URL(request.url).hostname === "public.api.bsky.app") {
      if (mode === "slow") await new Promise((resolve) => setTimeout(resolve, 10_000));
      if (mode === "failed") return new Response("Unavailable", { status: 503 });
      return Response.json({
        posts:
          mode === "missing"
            ? []
            : [
                mode === "labeled"
                  ? { ...post, labels: [{ src: did, uri, val: "porn", cts: new Date().toISOString() }] }
                  : mode === "gallery"
                    ? {
                        ...post,
                        embed: {
                          $type: "app.bsky.embed.gallery#view",
                          items: [1, 2, 3, 4, 5].map((i) => ({
                            $type: "app.bsky.embed.gallery#viewImage",
                            alt: `Gallery ${i}`,
                            thumbnail: "https://cdn.bsky.app/fixture.jpg",
                            fullsize: "https://cdn.bsky.app/fixture.jpg",
                            aspectRatio: { width: 1, height: 1 },
                          })),
                        },
                      }
                    : post,
              ],
      });
    }
    return new Response("Fixture blocked external call", { status: 503 });
  },
});
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
try {
  await mf.ready;
  for (const mobile of [false, true]) {
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
      isMobile: mobile,
      hasTouch: mobile,
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();
    await page.route("https://cdn.bsky.app/**", (route) =>
      route.fulfill({
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII=",
          "base64",
        ),
      }),
    );
    const url = `http://127.0.0.1:8799/post/${encodeURIComponent(did)}/fixture`;
    mode = "ok";
    const response = await page.goto(url, { waitUntil: "domcontentloaded" });
    assert.equal(response.status(), 200);
    await page.getByRole("button", { name: "Post options" }).waitFor();
    assert.match(await page.locator("body").textContent(), /Public permalink text/);
    assert.equal(
      await page.locator('link[rel="canonical"]').getAttribute("href"),
      `https://kualta.dev/post/${encodeURIComponent(did)}/fixture`,
    );
    assert.equal(
      await page.locator('meta[property="og:description"]').getAttribute("content"),
      "Public permalink text",
    );
    assert.equal(await page.locator('img[alt="Fixture image"]').count(), 1);
    const trigger = page.getByRole("button", { name: "Post options" });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    const card = page.locator(".site-bluesky-card");
    assert.equal(await card.locator("post-link-menu").count(), 1);
    const triggerBox = await trigger.boundingBox();
    const timeBox = await page.locator(".site-bluesky-time").boundingBox();
    assert.equal(triggerBox.width, 24);
    assert.equal(triggerBox.height, 24);
    assert(timeBox.x >= triggerBox.x + triggerBox.width);
    assert(timeBox.x - triggerBox.x - triggerBox.width <= 8);
    assert(Math.abs(timeBox.y + timeBox.height / 2 - triggerBox.y - triggerBox.height / 2) < 2);
    assert.equal(await page.locator(".post-menu-panel").getAttribute("popover"), "auto");
    if (process.env.SCREENSHOT_DIR) {
      await mkdir(process.env.SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: resolve(process.env.SCREENSHOT_DIR, `post-${mobile ? "mobile" : "desktop"}.png`) });
    }
    const box = await page.locator("main").boundingBox();
    const viewport = page.viewportSize();
    assert(Math.abs(box.x + box.width / 2 - viewport.width / 2) < 2);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await trigger.click();
    const panel = page.locator(".post-menu-panel");
    await panel.waitFor({ state: "visible" });
    const panelBox = await panel.boundingBox();
    const lightColor = await panel.evaluate(el => getComputedStyle(el).color);
    assert(panelBox.x >= 0 && panelBox.x + panelBox.width <= viewport.width);
    assert(panelBox.y >= 0 && panelBox.y + panelBox.height <= viewport.height);
    assert(await panel.evaluate(el => {
      const rect = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height - 10));
    }), "Native popover must not be clipped by the card");
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "hidden" });
    assert(await trigger.evaluate(el => el === document.activeElement));
    await trigger.click();
    await panel.waitFor({ state: "visible" });
    await page.mouse.click(1, 1);
    await panel.waitFor({ state: "hidden" });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await trigger.click();
    await panel.waitFor({ state: "visible" });
    assert.notEqual(await panel.evaluate(el => getComputedStyle(el).color), lightColor);
    await page.getByRole("button", { name: "Copy kualta.dev link" }).click();
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      `https://kualta.dev/post/${encodeURIComponent(did)}/fixture`,
    );
    const reload = await page.reload({ waitUntil: "domcontentloaded" });
    assert.equal(reload.status(), 200);
    mode = "gallery";
    assert.equal((await page.reload({ waitUntil: "domcontentloaded" })).status(), 200);
    assert.equal(await page.locator('img[alt^="Gallery"]').count(), 5);
    await page.locator("button[data-media-open]").first().click();
    const viewer = page.getByRole("dialog", { name: "Media viewer" });
    await viewer.waitFor({ state: "visible" });
    await viewer.locator('img[alt="Gallery 1"]').waitFor();
    await viewer.getByRole("button", { name: "Next media" }).click();
    await viewer.locator('img[alt="Gallery 2"]').waitFor();
    await viewer.getByRole("button", { name: "Previous media" }).click();
    await viewer.locator('img[alt="Gallery 1"]').waitFor();
    await viewer.getByRole("button", { name: "Close media viewer" }).click();
    await viewer.waitFor({ state: "hidden" });
    assert.equal(page.url(), url);
    mode = "labeled";
    assert.equal((await page.reload({ waitUntil: "domcontentloaded" })).status(), 200);
    assert.equal(await page.locator("[data-bluesky-fallback]").count(), 1);
    assert.equal(
      await page.locator('meta[property="og:description"]').getAttribute("content"),
      "A Bluesky post on kualta.dev",
    );
    assert.equal(await page.locator('meta[property="og:image"]').count(), 0);
    assert(!(await page.content()).includes("Public permalink text"));
    mode = "missing";
    assert.equal((await page.reload({ waitUntil: "domcontentloaded" })).status(), 404);
    assert.equal(await page.locator('meta[name="robots"]').getAttribute("content"), "noindex");
    mode = "failed";
    assert.equal((await page.reload({ waitUntil: "domcontentloaded" })).status(), 503);
    mode = "slow";
    const start = Date.now();
    assert.equal((await page.reload({ waitUntil: "domcontentloaded" })).status(), 503);
    const boundedMs = Date.now() - start;
    assert(boundedMs < 4500);
    console.log(
      JSON.stringify({
        mobile,
        directReload: true,
        centered: true,
        noHorizontalOverflow: true,
        publicImage: true,
        compactNativeMenu: true,
        menuLeftOfTimestamp: true,
        nativeEscapeAndLightDismiss: true,
        metadata: true,
        deleted404: true,
        failed503: true,
        slowUpstreamMs: boundedMs,
      }),
    );
    await context.close();
  }
  mode = "ok";
  process.argv[2] = "http://127.0.0.1:8799";
  await import("./check-home-scroll.mjs");
  await import("./check-activity-recovery.mjs");
} finally {
  await browser.close();
  await mf.dispose();
}
