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
// History thumbnails load through <img>, so they're served by route rather than the fetch mock.
const thumbnail =
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#a7b8d9"/></svg>';
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
      reducedMotion: mobile ? "reduce" : "no-preference",
    });
    const page = await context.newPage();
    await page.route("**/api/publisher/media/**", (route) =>
      route.request().url().endsWith("/m-expired")
        ? route.fulfill({ status: 404, body: "Expired" })
        : route.fulfill({ contentType: "image/svg+xml", body: thumbnail }),
    );
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // Dark is the page default; mobile covers the light theme.
    await page.goto(`http://127.0.0.1:8797/publisher.html?theme=${mobile ? "light" : "dark"}`);
    const shareTo = page.getByRole("complementary", { name: "Share to" });
    const presets = shareTo.getByRole("navigation", { name: "Presets" });
    await presets.getByRole("button", { name: "Text post", exact: true }).waitFor();
    assert.deepEqual(await presets.getByRole("button").allTextContents(), [
      "Photo",
      "Long video",
      "Text post",
      "Short-form video",
    ]);
    assert.equal(await page.getByRole("navigation", { name: "Presets" }).count(), 1);
    assert.equal(await page.getByRole("textbox", { name: "Post" }).count(), 1);
    if (mobile)
      assert.equal(
        await presets
          .getByRole("button")
          .first()
          .evaluate((el) => getComputedStyle(el).transitionDuration),
        "0s",
      );
    const pressed = () => presets.locator('[aria-pressed="true"]').allTextContents();
    const checked = () =>
      page
        .locator(".publisher-destinations label")
        .filter({ has: page.locator("input:checked") })
        .allTextContents();
    const reason = (name) =>
      page.locator(".publisher-destinations label", { hasText: name }).locator("small").textContent();
    // Each toolbar button has its own picker; a lone video goes through the video one.
    const attach = (files) => {
      const video = !Array.isArray(files) && files.mimeType.startsWith("video/");
      return page.locator(`input[type="file"][accept="${video ? "video/*" : "image/*"}"]`).setInputFiles(files);
    };
    const photos = (count) =>
      Array.from({ length: count }, (_, i) => ({ name: `photo-${i + 1}.png`, mimeType: "image/png", buffer: png }));
    const video = { name: "clip.mp4", mimeType: "video/mp4", buffer: Buffer.from("not decodable") };
    // The post's own title; Xiaohongshu's Chinese title sits in its own section.
    const title = page.getByRole("textbox", { name: /^Title ·/ });
    const shot = async (name) => {
      if (!shots) return;
      await page.waitForTimeout(300); // let chip transitions settle
      await page.screenshot({ path: path.join(shots, `${name}-${mobile ? "mobile" : "desktop"}.png`), fullPage: true });
    };

    // History: posts grouped by day, one pill per destination, problems inline, actions behind Manage.
    const history = page.getByRole("region", { name: "Posting history" });
    await history.getByText("this, too, is modern art").waitFor();
    const days = await history.locator(".publisher-history-day").allTextContents();
    assert.deepEqual(days.slice(0, 2), ["Today", "Yesterday"]);
    assert.equal(days.length, 3);
    const art = history.locator(".publisher-history-item", { hasText: "this, too, is modern art" });
    assert.equal(
      await art.locator(".publisher-history-pills").getByRole("link", { name: "Grain" }).getAttribute("href"),
      "https://example.invalid/grain/post",
    );
    assert.equal(await art.locator('[data-tone="gone"]').textContent(), "BlueskyDeleted");
    await art.getByText("Instagram: Instagram asked to confirm the login", { exact: false }).waitFor();
    assert.equal(await art.locator(".publisher-history-thumb small").textContent(), "2");
    assert.equal(
      await art.locator(".publisher-history-thumb img").evaluate((img) => img.decode().then(() => true)),
      true,
    );
    await history
      .locator(".publisher-history-item", { hasText: "A clip" })
      .getByText("Video", { exact: true })
      .waitFor();
    assert.equal(await history.locator('.publisher-history-item[data-deleted="true"]').count(), 1);
    // Manage opens an animated panel: rows link to each post, show when they settled, and delete by icon.
    const panel = art.locator(".publisher-history-panel");
    assert.equal(await panel.getAttribute("data-open"), "false");
    await art.getByRole("button", { name: "Manage" }).click();
    assert.equal(await panel.getAttribute("data-open"), "true");
    const grainRow = panel.locator(".publisher-history-panel-row", { hasText: "Grain" });
    assert.equal(await grainRow.getByRole("link").getAttribute("href"), "https://example.invalid/grain/post");
    assert.match(await grainRow.locator("time").textContent(), /\d/);
    assert.equal(
      await panel.locator(".publisher-history-panel-row", { hasText: "Bluesky" }).getByRole("link").count(),
      0,
    );
    await art.getByRole("button", { name: "Delete from Grain" }).waitFor();
    await art.getByRole("button", { name: "Retry publishing" }).waitFor();
    await art.getByRole("button", { name: "Delete everywhere" }).waitFor();
    await grainRow.getByRole("link").hover();
    await shot("history");
    await art.getByRole("button", { name: "Close" }).click();
    assert.equal(await panel.getAttribute("data-open"), "false");

    // Text only: the Text preset reaches Bluesky and X; media-only destinations say why they sit out.
    assert.deepEqual(await pressed(), ["Text post"]);
    assert.equal(await title.count(), 0);
    await page.getByRole("textbox", { name: "Post" }).fill("Hello from the composer");
    assert.equal(await page.locator(".publisher-count").textContent(), "23 / 280 · X / Twitter");
    assert.equal(await reason("Grain"), "needs photos");
    assert.equal(await reason("Instagram"), "needs media");
    assert.equal(await reason("YouTube"), "needs a video");
    await page.reload();
    await presets.getByRole("button", { name: "Text post", exact: true }).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "Post" }).inputValue(), "Hello from the composer");
    await shot("text");
    await page.getByRole("button", { name: "Publish to 2 places" }).click();
    const text = await queued(page);
    assert.equal(text.kind, "text");
    assert.deepEqual(text.media, []);
    assert.deepEqual(text.platforms, ["bluesky", "twitter"]);

    // The same preset with five photos: X takes four, so Bluesky alone gets them, each described; no title needed.
    await page.getByRole("textbox", { name: "Post" }).fill("Five photos");
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.getByRole("button", { name: "Photos" }).click(),
    ]);
    assert.equal(chooser.isMultiple(), true);
    await chooser.setFiles(photos(5));
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
    await page.getByRole("textbox", { name: "Post" }).fill("Two photo caption");
    await descriptions.nth(0).fill("A description to keep");
    const date = page.getByRole("textbox", { name: "Date taken for photo-1.png", exact: true });
    await page.waitForFunction(() => !document.querySelector('input[type="datetime-local"]').disabled);
    await date.fill("2026-10-01T12:34:56");
    const previewURLs = await page.locator(".publisher-previews img").evaluateAll((imgs) => imgs.map((img) => img.src));
    await shareTo.getByText("Preset settings", { exact: true }).click();
    await shareTo.getByRole("textbox", { name: "Default caption" }).fill("Two photo caption");

    // Presets change destinations only, even when the draft matches a saved caption default.
    await presets.getByRole("button", { name: "Long video", exact: true }).focus();
    await page.keyboard.press("Enter");
    assert.deepEqual(await pressed(), ["Long video"]);
    assert.equal(await page.getByRole("textbox", { name: "Post" }).inputValue(), "Two photo caption");
    assert.deepEqual(await checked(), []);
    assert.equal(await page.locator(".publish-button").isDisabled(), true);
    await shareTo.getByText("None of the selected destinations take these photos.").waitFor();
    assert.equal(await title.count(), 0);
    await shareTo.getByRole("textbox", { name: "Default caption" }).fill("Video default");
    await presets.getByRole("button", { name: "Photo", exact: true }).focus();
    await page.keyboard.press("Space");
    assert.equal(await title.inputValue(), "Two photos");
    assert.equal(await descriptions.nth(0).inputValue(), "A description to keep");
    assert.equal(await date.inputValue(), "2026-10-01T12:34:56");
    assert.deepEqual(
      await page.locator(".publisher-previews img").evaluateAll((imgs) => imgs.map((img) => img.src)),
      previewURLs,
    );
    assert.deepEqual(await checked(), ["Grain", "Instagram"]);
    await page.keyboard.press("Tab");
    assert.equal(
      await presets
        .getByRole("button", { name: "Long video", exact: true })
        .evaluate((el) => el === document.activeElement),
      true,
    );
    assert.equal(
      await presets
        .getByRole("button", { name: "Long video", exact: true })
        .evaluate((el) => getComputedStyle(el).outlineStyle),
      "solid",
    );
    await page.getByRole("textbox", { name: "Post" }).fill("");
    await presets.getByRole("button", { name: "Long video", exact: true }).click();
    assert.equal(await page.getByRole("textbox", { name: "Post" }).inputValue(), "");
    await presets.getByRole("button", { name: "Text post", exact: true }).click();
    assert.deepEqual(await checked(), ["Bluesky", "X / Twitter"]);
    assert.equal(await descriptions.nth(0).inputValue(), "A description to keep");
    await presets.getByRole("button", { name: "Photo", exact: true }).click();
    assert.equal(await title.inputValue(), "Two photos");
    await page.getByRole("textbox", { name: "Post" }).fill("Two photo caption");
    await shareTo.getByText("Preset settings", { exact: true }).click();
    await shot("photo-preserved");
    await page.getByRole("button", { name: "Publish to 2 places" }).click();
    const photo = await queued(page);
    assert.deepEqual(photo.platforms.toSorted(), ["grain", "instagram"]);
    assert.equal(photo.title, "Two photos");
    assert.equal(photo.caption, "Two photo caption");
    assert.equal(photo.alts[0], "A description to keep");
    assert.equal(photo.datesTaken[0], new Date("2026-10-01T12:34:56").toISOString());

    // A video on the Short video preset: Grain sits out, and YouTube and Xiaohongshu need a title.
    await presets.getByRole("button", { name: "Short-form video" }).click();
    await attach(video);
    await page.locator(".publisher-previews video").waitFor(); // the duration is read first
    assert.equal(await reason("Grain"), "needs photos");
    assert.equal(await reason("Instagram"), "Reel");
    assert.deepEqual(await checked(), ["InstagramReel", "Bluesky", "X / Twitter", "Xiaohongshu", "YouTube", "TikTok"]);
    await page.getByRole("textbox", { name: "Video description (Bluesky)" }).fill("A short clip");
    await title.fill("A clip");
    await presets.getByRole("button", { name: "Photo", exact: true }).click();
    assert.deepEqual(await checked(), ["InstagramReel"]);
    await presets.getByRole("button", { name: "Long video", exact: true }).click();
    assert.deepEqual(await checked(), ["YouTube"]);
    assert.equal(await title.inputValue(), "A clip");
    assert.equal(await page.getByRole("textbox", { name: "Video description (Bluesky)" }).inputValue(), "A short clip");
    await presets.getByRole("button", { name: "Short-form video" }).click();
    // Tags are rendered per platform, and Xiaohongshu gets its Chinese version from Translate.
    await page.getByRole("textbox", { name: "Tags" }).fill("#bogota film");
    const chinese = page.getByRole("group", { name: "Xiaohongshu · Chinese" });
    await chinese.getByRole("button", { name: "Translate" }).click();
    await chinese.getByRole("button", { name: "Translate again" }).waitFor();
    assert.equal(await chinese.getByRole("textbox", { name: /^Title/ }).inputValue(), "波哥大短片");
    assert.equal(await chinese.getByRole("textbox", { name: "Topics" }).inputValue(), "波哥大 旅行");
    await page.getByText("What each platform gets").click();
    await shot("video");
    await page.getByRole("button", { name: "Queue post" }).click();
    const clip = await queued(page);
    assert.equal(clip.kind, "video");
    assert.equal(clip.alt, "A short clip");
    assert.deepEqual(clip.platforms.toSorted(), ["bluesky", "instagram", "tiktok", "twitter", "xiaohongshu", "youtube"]);
    assert.deepEqual(clip.tags, ["bogota", "film"]);
    assert.deepEqual(clip.zh, { title: "波哥大短片", text: "周末的波哥大。", topics: ["波哥大", "旅行"] });

    // Photos and a video together are refused; removing media returns to a text post.
    await attach(photos(1));
    await descriptions.nth(0).fill("Keep this if the next selection is invalid");
    await attach([...photos(1), video]);
    await page.getByText("Attach up to 10 photos (30 MB each) or one video (90 MB).").waitFor();
    assert.equal(await descriptions.nth(0).inputValue(), "Keep this if the next selection is invalid");
    assert.equal(await page.locator(".publisher-previews img").count(), 1);
    await attach(photos(11));
    assert.equal(await descriptions.nth(0).inputValue(), "Keep this if the next selection is invalid");
    await attach(photos(1));
    await page.getByRole("button", { name: "Remove media" }).click();
    assert.equal(await reason("Grain"), "needs photos");

    // Files dropped on the composer attach like the buttons do.
    const dropped = await page.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["x"], "dropped.png", { type: "image/png" }));
      return transfer;
    });
    await page.locator(".publisher-composer").dispatchEvent("drop", { dataTransfer: dropped });
    await page.getByRole("textbox", { name: "Description (Grain / Bluesky)" }).waitFor();
    await page.getByRole("button", { name: "Remove media" }).click();
    // Custom presets remain editable and survive a reload, alongside the active draft.
    await presets.getByRole("button", { name: "Text post", exact: true }).click();
    await shareTo.getByText("Preset settings", { exact: true }).click();
    await shareTo.getByRole("button", { name: "Duplicate", exact: true }).click();
    await shareTo.getByRole("textbox", { name: "Name", exact: true }).fill("My destinations");
    await page.locator(".publisher-destinations label", { hasText: "X / Twitter" }).getByRole("checkbox").uncheck();
    await page.getByRole("textbox", { name: "Post" }).fill("Custom preset draft");
    await page.reload();
    await presets.getByRole("button", { name: "My destinations", exact: true }).waitFor();
    assert.deepEqual(await pressed(), ["My destinations"]);
    assert.deepEqual(await checked(), ["Bluesky"]);
    assert.equal(await page.getByRole("textbox", { name: "Post" }).inputValue(), "Custom preset draft");
    if (mobile) {
      await presets.getByRole("button", { name: "Text post", exact: true }).tap();
      assert.deepEqual(await checked(), ["Bluesky", "X / Twitter"]);
    }
    for (const width of [320, 768]) {
      await page.setViewportSize({ width, height: 900 });
      await shot(`layout-${width}`);
      const overflow = await page.evaluate(() => ({
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        elements: [...document.querySelectorAll("body *")]
          .filter((el) => el.getBoundingClientRect().right > innerWidth)
          .map((el) => `${el.tagName}.${el.className}`),
      }));
      assert.equal(overflow.scrollWidth <= width, true, JSON.stringify(overflow));
    }
    // Upload errors keep an editable draft. An unconfirmed queue response freezes it for an identical retry.
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 });
    await presets.getByRole("button", { name: "Photo", exact: true }).click();
    await attach(photos(1));
    await title.fill("Retry title");
    await page.getByRole("textbox", { name: "Post" }).fill("Retry caption");
    await descriptions.nth(0).fill("Retry description");
    await page.waitForFunction(() => !document.querySelector('input[type="datetime-local"]').disabled);
    await page.evaluate(() => {
      const fetch = window.fetch;
      window.publisherAttempts = { uploads: 0, jobs: [] };
      window.fetch = async (input, init) => {
        if (String(input).endsWith("/media")) {
          window.publisherAttempts.uploads++;
          if (window.publisherAttempts.uploads === 1) {
            await new Promise((resolve) => {
              window.releaseUpload = resolve;
            });
            return Response.json({ error: "Test upload failure" }, { status: 500 });
          }
        }
        if (String(input).endsWith("/jobs")) {
          window.publisherAttempts.jobs.push(JSON.parse(init.body));
          if (window.publisherAttempts.jobs.length === 1)
            return Response.json({ error: "Test queue response failure" }, { status: 500 });
        }
        return fetch(input, init);
      };
    });
    await page.getByRole("button", { name: "Publish to 2 places" }).click();
    await page.waitForFunction(() => typeof window.releaseUpload === "function");
    assert.equal(await page.getByRole("button", { name: "Uploading…" }).isDisabled(), true);
    assert.equal(await presets.getByRole("button", { name: "Photo", exact: true }).isDisabled(), true);
    assert.equal(await title.isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Remove media" }).isDisabled(), true);
    await page.evaluate(() => window.releaseUpload());
    await page.getByRole("alert").getByText("Test upload failure").waitFor();
    assert.equal(await presets.getByRole("button", { name: "Photo", exact: true }).isEnabled(), true);
    assert.equal(await title.inputValue(), "Retry title");
    assert.equal(await descriptions.nth(0).inputValue(), "Retry description");
    await page.getByRole("button", { name: "Publish to 2 places" }).click();
    await page.getByRole("alert").getByText("Test queue response failure").waitFor();
    assert.equal(await presets.getByRole("button", { name: "Photo", exact: true }).isDisabled(), true);
    assert.equal(await title.isDisabled(), true);
    assert.equal(await title.inputValue(), "Retry title");
    await shot("queue-retry");
    await page.getByRole("button", { name: "Retry queue request" }).click();
    await queued(page);
    await page.getByRole("status").getByText("Queued. Your laptop will publish each destination once.").waitFor();
    const attempts = await page.evaluate(() => window.publisherAttempts);
    assert.equal(attempts.uploads, 2);
    assert.equal(attempts.jobs.length, 2);
    assert.deepEqual(attempts.jobs[0], attempts.jobs[1]);
    assert.equal(await page.locator(".publisher-previews img").count(), 0);
    assert.equal(await title.count(), 0);
    assert.equal(await page.getByRole("textbox", { name: "Post" }).inputValue(), "Two photo caption");
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("Publisher composer passed on desktop and mobile.");
} finally {
  await browser.close();
  await server.close();
}
