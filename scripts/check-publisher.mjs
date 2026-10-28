import assert from "node:assert/strict";
import path from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";

// Drives the publisher's composer with a mocked API: what each mix of text and media can reach, and what it queues.
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
    const presets = page.getByRole("navigation", { name: "Presets" });
    await presets.getByRole("button", { name: "Text" }).waitFor();
    assert.deepEqual(await presets.getByRole("button").allTextContents(), ["Text", "Photo", "Video", "Short video"]);
    const pressed = () => presets.locator('[aria-pressed="true"]').allTextContents();
    const checked = () =>
      page
        .locator(".publisher-destinations label")
        .filter({ has: page.locator("input:checked") })
        .allTextContents();
    const reason = (name) =>
      page.locator(".publisher-destinations label", { hasText: name }).locator("small").textContent();
    const attach = (files) => page.locator('input[type="file"]').setInputFiles(files);
    const photos = (count) =>
      Array.from({ length: count }, (_, i) => ({ name: `photo-${i + 1}.png`, mimeType: "image/png", buffer: png }));
    const video = { name: "clip.mp4", mimeType: "video/mp4", buffer: Buffer.from("not decodable") };
    const title = page.getByRole("textbox", { name: /^Title/ });
    const shot = async (name) => {
      if (!shots) return;
      await page.waitForTimeout(300); // let chip transitions settle
      await page.screenshot({ path: path.join(shots, `${name}-${mobile ? "mobile" : "desktop"}.png`), fullPage: true });
    };

    // Text only: the Text preset reaches Bluesky and X; media-only destinations say why they sit out.
    assert.deepEqual(await pressed(), ["Text"]);
    assert.equal(await title.count(), 0);
    await page.getByRole("textbox", { name: "Post" }).fill("Hello from the composer");
    assert.equal(await page.locator(".publisher-count").textContent(), "23 / 280 · X / Twitter");
    assert.equal(await reason("Grain"), "needs photos");
    assert.equal(await reason("Instagram"), "needs media");
    assert.equal(await reason("YouTube"), "needs a video");
    await page.reload();
    await presets.getByRole("button", { name: "Text" }).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "Post" }).inputValue(), "Hello from the composer");
    await shot("text");
    await page.getByRole("button", { name: "Publish to 2 places" }).click();
    const text = await queued(page);
    assert.equal(text.kind, "text");
    assert.deepEqual(text.media, []);
    assert.deepEqual(text.platforms, ["bluesky", "twitter"]);

    // The same preset with five photos: X takes four, so Bluesky alone gets them, each described; no title needed.
    await page.getByRole("textbox", { name: "Post" }).fill("Five photos");
    await attach(photos(5));
    assert.equal(await reason("X / Twitter"), "takes up to 4 photos");
    const descriptions = page.getByRole("textbox", { name: "Description (Grain / Bluesky)" });
    assert.equal(await descriptions.count(), 5);
    for (let i = 0; i < 5; i++) await descriptions.nth(i).fill(`Photo ${i + 1} described`);
    assert.equal(await title.count(), 0);
    await shot("text-photos");
    await page.getByRole("button", { name: "Publish to 1 place" }).click();
    const textPhotos = await queued(page);
    assert.equal(textPhotos.kind, "photo");
    assert.deepEqual(textPhotos.platforms, ["bluesky"]);
    assert.equal(textPhotos.caption, "Five photos");
    assert.deepEqual(
      textPhotos.alts,
      Array.from({ length: 5 }, (_, i) => `Photo ${i + 1} described`),
    );

    // The Photo preset includes Grain, which publishes a title, so one is asked for.
    await presets.getByRole("button", { name: "Photo" }).click();
    await attach(photos(2));
    await page.getByRole("button", { name: "Publish to 2 places" }).click();
    await page.getByRole("alert").getByText("Add a title for Grain.").waitFor();
    await title.fill("Two photos");
    await page.getByRole("button", { name: "Publish to 2 places" }).click();
    const photo = await queued(page);
    assert.deepEqual(photo.platforms.toSorted(), ["grain", "instagram"]);
    assert.equal(photo.title, "Two photos");

    // A video on the Short video preset: Grain sits out, and YouTube and Xiaohongshu need a title.
    await presets.getByRole("button", { name: "Short video" }).click();
    await attach(video);
    await page.locator(".publisher-previews video").waitFor(); // the duration is read first
    assert.equal(await reason("Grain"), "needs photos");
    assert.deepEqual(await checked(), ["Bluesky", "X / Twitter", "Xiaohongshu", "YouTube", "TikTok"]);
    await page.getByRole("textbox", { name: "Video description (Bluesky)" }).fill("A short clip");
    await title.fill("A clip");
    await shot("video");
    await page.getByRole("button", { name: "Queue post" }).click();
    const clip = await queued(page);
    assert.equal(clip.kind, "video");
    assert.equal(clip.alt, "A short clip");
    assert.deepEqual(clip.platforms.toSorted(), ["bluesky", "tiktok", "twitter", "xiaohongshu", "youtube"]);

    // Photos and a video together are refused; removing media returns to a text post.
    await attach([...photos(1), video]);
    await page.getByText("Attach up to 10 photos (30 MB each) or one video (90 MB).").waitFor();
    await attach(photos(1));
    await page.getByRole("button", { name: "Remove media" }).click();
    assert.equal(await reason("Grain"), "needs photos");
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("Publisher composer passed on desktop and mobile.");
} finally {
  await browser.close();
  await server.close();
}
