import assert from "node:assert/strict";
import path from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";

// Drives the publisher's content tabs with a mocked API: what each tab asks for and what it queues.
const root = process.cwd();
const shots = process.env.SCREENSHOT_DIR;
const server = await createServer({
  configFile: false,
  root: path.join(root, "scripts/browser-fixtures"),
  resolve: { alias: [{ find: "@", replacement: path.join(root, "src") }] },
  esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 8797, fs: { allow: [root] } },
});
await server.listen();
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
// 1×1 PNG: enough for previews and uploads.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
const queued = (page) =>
  page
    .waitForFunction(() => window.publisherRequests.some((r) => r.path === "jobs"))
    .then(() =>
      page.evaluate(() => {
        const job = window.publisherRequests.filter((r) => r.path === "jobs").at(-1).body;
        window.publisherRequests.length = 0;
        return job;
      }),
    );
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
      isMobile: mobile,
      hasTouch: mobile,
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // Dark is the page default; mobile covers the light theme.
    await page.goto(`http://127.0.0.1:8797/publisher.html?theme=${mobile ? "light" : "dark"}`);
    const kinds = page.getByRole("navigation", { name: "Content type" });
    await kinds.getByRole("button", { name: "Photo" }).waitFor();
    assert.deepEqual(await kinds.getByRole("button").allTextContents(), ["Text", "Photo", "Video", "Short video"]);
    const pressed = () => kinds.locator('[aria-pressed="true"]').allTextContents();
    const checked = () =>
      page
        .locator(".publisher-destinations label")
        .filter({ has: page.locator("input:checked") })
        .allTextContents();
    const shot = async (name) => {
      if (!shots) return;
      await page.waitForTimeout(300); // let tab transitions settle
      await page.screenshot({ path: path.join(shots, `${name}-${mobile ? "mobile" : "desktop"}.png`), fullPage: true });
    };

    // Text: no media or title, a counter for the strictest destination, and a draft that survives a reload.
    await kinds.getByRole("button", { name: "Text" }).click();
    assert.equal(await page.locator('input[type="file"]').count(), 0);
    assert.equal(await page.getByRole("textbox", { name: "Title" }).count(), 0);
    await page.getByRole("textbox", { name: "Post" }).fill("Hello from the text tab");
    assert.equal(await page.locator(".publisher-count").textContent(), "23 / 280");
    await page.reload();
    await kinds.getByRole("button", { name: "Text" }).click();
    assert.equal(await page.getByRole("textbox", { name: "Post" }).inputValue(), "Hello from the text tab");
    assert.deepEqual(await pressed(), ["Text"]);
    await shot("text");
    await page.getByRole("button", { name: "Publish to 2 places" }).click();
    const text = await queued(page);
    assert.equal(text.kind, "text");
    assert.deepEqual(text.media, []);
    assert.equal(text.title, "");
    assert.deepEqual(text.platforms, ["bluesky", "twitter"]);

    // Photo: five photos, each with its own description.
    await kinds.getByRole("button", { name: "Photo" }).click();
    assert.deepEqual(await pressed(), ["Photo"]);
    await page
      .locator('input[type="file"]')
      .setInputFiles(
        Array.from({ length: 5 }, (_, i) => ({ name: `photo-${i + 1}.png`, mimeType: "image/png", buffer: png })),
      );
    const descriptions = page.getByRole("textbox", { name: "Description (Grain / Bluesky)" });
    assert.equal(await descriptions.count(), 5);
    for (let i = 0; i < 5; i++) await descriptions.nth(i).fill(`Photo ${i + 1} described`);
    await page.getByRole("textbox", { name: "Title" }).fill("Five photos");
    await shot("photo");
    await page.getByRole("button", { name: "Publish to 2 places" }).click();
    const photo = await queued(page);
    assert.equal(photo.kind, "photo");
    assert.equal(photo.media.length, 5);
    assert.deepEqual(
      photo.alts,
      Array.from({ length: 5 }, (_, i) => `Photo ${i + 1} described`),
    );

    // Short video: one video, up to three minutes, with a video description.
    await kinds.getByRole("button", { name: "Short video" }).click();
    await page.getByText("One video · up to 3 minutes · 90 MB").waitFor();
    await page.getByRole("textbox", { name: "Video description (Bluesky)" }).waitFor();
    assert.deepEqual(await pressed(), ["Short video"]);
    assert.deepEqual(await checked(), ["Bluesky", "X / Twitter", "Xiaohongshu", "YouTube", "TikTok"]);
    await shot("short");
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("Publisher content tabs passed on desktop and mobile.");
} finally {
  await browser.close();
  await server.close();
}
