import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpeg from "ffmpeg-static";
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
// Real clips, so the composer reads their shape. WebM because Playwright's Chromium has no H.264 decoder,
// and written to a file because the duration is only stored when ffmpeg can seek back.
const clips = mkdtempSync(path.join(tmpdir(), "publisher-clips-"));
const realClip = (name, source, codec = "libvpx") => {
  const file = path.join(clips, `${name}.webm`);
  execFileSync(ffmpeg, ["-y", "-f", "lavfi", "-i", source, "-c", codec, file], { stdio: "ignore" });
  return { name: `${name}.webm`, mimeType: "video/webm", buffer: readFileSync(file) };
};
const wideClip = realClip("wide", "color=c=gray:s=320x180:r=1:d=2");
const tallClip = realClip("tall", "color=c=gray:s=180x320:r=1:d=2");
const longClip = realClip("long", "color=c=gray:s=320x180:r=1:d=181");
// Loads fine but has no picture, so its width and height read as 0.
const blankClip = realClip("blank", "anullsrc=d=2", "libopus");
// Counted once the job has gone out and before queued() empties the log.
const uploadsBeforeJob = async (page) => {
  await page.waitForFunction(() => window.publisherRequests.some((r) => r.path === "jobs"));
  return page.evaluate(() => window.publisherRequests.filter((r) => r.path === "media").length);
};
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
    // Crosspost reaches destinations the post hasn't; Xiaohongshu asks for its Chinese version first.
    const crosspost = panel.getByRole("group", { name: "Crosspost to" });
    assert.equal(await crosspost.locator("label", { hasText: "YouTube" }).locator("small").textContent(), "needs a video");
    await crosspost.locator("label", { hasText: "X / Twitter" }).getByRole("checkbox").check();
    await crosspost.locator("label", { hasText: "Xiaohongshu" }).getByRole("checkbox").check();
    const crossChinese = crosspost.getByRole("group", { name: "Xiaohongshu · Chinese" });
    await crossChinese.getByRole("button", { name: "Translate" }).click();
    await crossChinese.getByRole("button", { name: "Translate again" }).waitFor();
    await crosspost.getByRole("button", { name: "Crosspost to 2 places" }).click();
    await page.waitForFunction(() => window.publisherRequests.some((r) => r.path === "crosspost"));
    const crossposted = await page.evaluate(() => window.publisherRequests.find((r) => r.path === "crosspost").body);
    assert.deepEqual(crossposted.platforms, ["twitter", "xiaohongshu"]);
    assert.deepEqual(crossposted.zh, { title: "波哥大短片", text: "周末的波哥大。", topics: ["波哥大", "旅行"] });
    assert.equal(crossposted.title, undefined);
    await grainRow.getByRole("link").hover();
    await shot("history");
    await art.getByRole("button", { name: "Close" }).click();
    assert.equal(await panel.getAttribute("data-open"), "false");
    // A post that went out without a confirmed link can be recorded from the link the owner finds.
    const earlier = history.locator(".publisher-history-item", { hasText: "An earlier text post" });
    await earlier.getByRole("button", { name: "Manage" }).click();
    page.once("dialog", (dialog) => dialog.accept("https://x.com/kualta/status/123"));
    await earlier.getByRole("button", { name: "Mark as published" }).click();
    await page.waitForFunction(() => window.publisherRequests.some((r) => r.path === "mark-published"));
    const marked = await page.evaluate(() => window.publisherRequests.find((r) => r.path === "mark-published").body);
    assert.equal(marked.platform, "twitter");
    assert.equal(marked.url, "https://x.com/kualta/status/123");
    await earlier.getByRole("button", { name: "Close" }).click();
    // Stop releases a destination that's waiting or publishing, without waiting for it to time out.
    const clipRow = history.locator(".publisher-history-item", { hasText: "A clip" });
    await clipRow.getByRole("button", { name: "Manage" }).click();
    await clipRow.getByRole("button", { name: "Stop publishing to YouTube" }).waitFor();
    await clipRow.getByRole("button", { name: "Stop publishing to TikTok" }).click();
    await page.waitForFunction(() => window.publisherRequests.some((r) => r.path === "stop"));
    assert.deepEqual(await page.evaluate(() => window.publisherRequests.find((r) => r.path === "stop").body), {
      job: "00000000-0000-4000-8000-000000000003",
      platform: "tiktok",
    });
    await clipRow.getByRole("button", { name: "Close" }).click();

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
    const descriptions = page.getByRole("textbox", { name: "Description (Grain / Bluesky / Lens)" });
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
    const asShort = shareTo.getByRole("checkbox", { name: "Post as a Short" });
    assert.equal(await asShort.count(), 0); // this browser can't read its shape
    assert.equal(await reason("Grain"), "needs photos");
    assert.equal(await reason("Instagram"), "Reel");
    assert.deepEqual(await checked(), ["InstagramReel", "Bluesky", "X / Twitter", "Xiaohongshu", "YouTube", "TikTok"]);
    await page.getByRole("textbox", { name: "Video description (Bluesky / Lens)" }).fill("A short clip");
    await title.fill("A clip");
    await presets.getByRole("button", { name: "Photo", exact: true }).click();
    assert.deepEqual(await checked(), ["InstagramReel"]);
    await presets.getByRole("button", { name: "Long video", exact: true }).click();
    assert.deepEqual(await checked(), ["YouTube"]);
    assert.equal(await title.inputValue(), "A clip");
    assert.equal(await page.getByRole("textbox", { name: "Video description (Bluesky / Lens)" }).inputValue(), "A short clip");
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
    assert.equal("youtubeShort" in clip, false);

    // A horizontal clip under Short-form: ticked, named a Short under YouTube, and asked for in the job.
    const youtubeRow = page.locator(".publisher-destinations label", { hasText: "YouTube" });
    const youtubeFormat = () => youtubeRow.locator("small").allTextContents();
    const shortForm = presets.getByRole("button", { name: "Short-form video" });
    const longVideo = presets.getByRole("button", { name: "Long video", exact: true });
    const tooLong = shareTo.getByText("Over 3 minutes, so YouTube gets this as a regular video.");
    // Queueing clears the draft just after the request, and media attached before that would add to the old clip.
    const queueClip = async () => {
      await page.getByRole("button", { name: "Queue post" }).click();
      const job = await queued(page);
      await page.locator(".publisher-previews").waitFor({ state: "detached" });
      return job;
    };
    await attach(wideClip);
    await asShort.waitFor();
    assert.equal(await asShort.isChecked(), true);
    assert.deepEqual(await youtubeFormat(), ["Short"]);
    await shot("short-checkbox");
    // The owner's answer lasts until the preset changes, then the new preset's default applies.
    await asShort.uncheck();
    assert.deepEqual(await youtubeFormat(), []);
    await longVideo.click();
    assert.equal(await asShort.isChecked(), false);
    assert.deepEqual(await youtubeFormat(), []);
    await shortForm.click();
    assert.equal(await asShort.isChecked(), true);
    // No YouTube, no question.
    await youtubeRow.getByRole("checkbox").uncheck();
    assert.equal(await asShort.count(), 0);
    assert.deepEqual(await youtubeFormat(), []);
    await youtubeRow.getByRole("checkbox").check();
    assert.equal(await asShort.isChecked(), true);
    await title.fill("A wide clip");
    await chinese.getByRole("button", { name: "Translate" }).click();
    await chinese.getByRole("button", { name: "Translate again" }).waitFor();
    const wideShort = await queueClip();
    assert.equal(wideShort.youtubeShort, true);
    assert.equal(wideShort.platforms.includes("tiktok"), true);

    // Under Long video it starts unticked, and an unticked box asks for nothing.
    await longVideo.click();
    await attach(wideClip);
    await asShort.waitFor();
    assert.equal(await asShort.isChecked(), false);
    await title.fill("A regular wide clip");
    assert.equal("youtubeShort" in (await queueClip()), false);

    // Ticked by hand it's a Short; an unconfirmed queue response freezes the box along with the rest of the draft.
    await attach(wideClip);
    await asShort.check();
    assert.deepEqual(await youtubeFormat(), ["Short"]);
    await title.fill("A chosen wide clip");
    await page.evaluate(() => {
      const fetch = window.fetch;
      window.fetch = async (input, init) => {
        if (!String(input).endsWith("/jobs")) return fetch(input, init);
        window.fetch = fetch;
        return Response.json({ error: "Test queue response failure" }, { status: 500 });
      };
    });
    await page.getByRole("button", { name: "Queue post" }).click();
    await page.getByRole("alert").getByText("Test queue response failure").waitFor();
    assert.equal(await asShort.isDisabled(), true);
    await page.getByRole("button", { name: "Retry queue request" }).click();
    const chosen = await queued(page);
    await page.locator(".publisher-previews").waitFor({ state: "detached" });
    assert.equal(chosen.youtubeShort, true);
    assert.deepEqual(chosen.platforms, ["youtube"]);

    // A vertical clip is already a Short, so there's nothing to choose.
    await attach(tallClip);
    await page.locator(".publisher-previews video").waitFor();
    assert.equal(await asShort.count(), 0);
    assert.deepEqual(await youtubeFormat(), ["Short"]);
    await title.fill("A tall clip");
    assert.equal("youtubeShort" in (await queueClip()), false);

    // Over 3 minutes can never be a Short: no box, and Short-form says what will happen instead.
    await attach(longClip);
    await page.locator(".publisher-previews video").waitFor();
    assert.equal(await asShort.count(), 0);
    assert.equal(await tooLong.count(), 0);
    assert.deepEqual(await youtubeFormat(), []);
    await shortForm.click();
    await tooLong.waitFor();
    assert.equal(await asShort.count(), 0);
    assert.equal(await reason("Bluesky"), "takes videos up to 3 minutes");
    await shot("short-too-long");
    await youtubeRow.getByRole("checkbox").uncheck();
    assert.equal(await tooLong.count(), 0);
    await youtubeRow.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Remove media" }).click();
    assert.equal(await tooLong.count(), 0);

    // A file the browser opens without finding a picture has no shape either: not a Short, and nothing to choose.
    await attach(blankClip);
    await page.locator(".publisher-previews video").waitFor();
    assert.equal(await asShort.count(), 0);
    assert.deepEqual(await youtubeFormat(), []);
    await page.getByRole("button", { name: "Remove media" }).click();

    // Picked media adds up. Photos with a video make one post for Instagram and X; the rest sit out.
    const attached = (count) =>
      page.waitForFunction((n) => document.querySelectorAll(".publisher-previews figure").length === n, count);
    await attach(photos(1));
    await descriptions.nth(0).fill("Kept as more media is added");
    await attach(photos(1));
    await attached(2);
    assert.equal(await descriptions.count(), 2);
    assert.equal(await descriptions.nth(0).inputValue(), "Kept as more media is added");
    await attach(video);
    await attached(3);
    assert.equal(await reason("Bluesky"), "takes photos or one video");
    assert.equal(await reason("YouTube"), "takes one video");
    assert.deepEqual(await checked(), ["Instagram", "X / Twitter"]);
    await attach(photos(8));
    await page.getByText("Attach up to 10 photos and videos: photos up to 30 MB, videos up to 90 MB.").waitFor();
    await attached(3);
    await shot("mixed");
    await page.getByRole("button", { name: /^(Publish to 2 places|Queue post)$/ }).click();
    const mix = await queued(page);
    assert.equal(mix.kind, "mixed");
    assert.deepEqual(mix.mediaKinds, ["photo", "photo", "video"]);
    assert.deepEqual(mix.platforms.toSorted(), ["instagram", "twitter"]);

    // One item can be removed on its own; Remove media returns to a text post.
    await attach([...photos(1), video]);
    await page.getByRole("button", { name: "Remove clip.mp4" }).click();
    await attached(1);
    assert.equal(await descriptions.count(), 1);
    await page.getByRole("button", { name: "Remove media" }).click();
    assert.equal(await reason("Grain"), "needs photos");

    // Files dropped on the composer attach like the buttons do.
    const dropped = await page.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["x"], "dropped.png", { type: "image/png" }));
      return transfer;
    });
    await page.locator(".publisher-composer").dispatchEvent("drop", { dataTransfer: dropped });
    await page.getByRole("textbox", { name: "Description (Grain / Bluesky / Lens)" }).waitFor();
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

  // A draft from the terminal opens prefilled and locked until its video arrives, then publishes without re-uploading.
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const draftUrl = "http://127.0.0.1:8797/publisher.html?draft=00000000-0000-4000-8000-00000000d1af";
  const videoId = "00000000-0000-4000-8000-00000000d1d0";
  let releaseVideo;
  const videoHeld = new Promise((resolve) => (releaseVideo = resolve));
  await page.route(`**/api/publisher/media/${videoId}`, async (route) => {
    await videoHeld;
    await route.fulfill({ contentType: tallClip.mimeType, body: tallClip.buffer });
  });
  await page.goto(draftUrl);
  const publish = page.locator(".publish-button");
  await page.getByRole("button", { name: "Loading video…" }).waitFor();
  assert.equal(await publish.isDisabled(), true);
  assert.equal(await page.getByRole("textbox", { name: "Post" }).isDisabled(), true);
  releaseVideo();
  await page.locator(".publisher-previews video").waitFor();
  await page.getByRole("button", { name: "Queue post" }).waitFor();
  assert.deepEqual(
    await page.getByRole("navigation", { name: "Presets" }).locator('[aria-pressed="true"]').allTextContents(),
    ["Short-form video"],
  );
  assert.equal(await page.getByRole("textbox", { name: /^Title ·/ }).inputValue(), "Rendered film");
  assert.equal(await page.getByRole("textbox", { name: "Post" }).inputValue(), "A film about films");
  assert.equal(await page.getByRole("textbox", { name: "Video description (Bluesky / Lens)" }).inputValue(), "Titles fade over a dark stage");
  assert.equal(await page.getByRole("textbox", { name: "Tags" }).inputValue(), "film motion");
  assert.equal(await page.getByRole("textbox", { name: /^Short version/ }).inputValue(), "A film");
  const chinese = page.getByRole("group", { name: "Xiaohongshu · Chinese" });
  assert.equal(await chinese.getByRole("textbox", { name: "Title" }).inputValue(), "短片");
  assert.equal(await chinese.getByRole("textbox", { name: "Topics" }).inputValue(), "短片 动画");
  // Nothing has been queued by opening it; that takes the click.
  assert.equal(await page.evaluate(() => window.publisherRequests.some((r) => r.path === "jobs")), false);
  await publish.click();
  assert.equal(await uploadsBeforeJob(page), 0);
  await page.waitForFunction(() =>
    window.publisherRequests.some((r) => r.path.startsWith("drafts/") && r.method === "DELETE"),
  );
  const job = await queued(page);
  assert.equal(job.kind, "video");
  assert.deepEqual(job.media, [videoId]);
  assert.deepEqual(job.platforms, ["instagram", "youtube", "xiaohongshu", "tiktok", "twitter", "bluesky"]);
  assert.equal(job.title, "Rendered film");
  assert.deepEqual(job.tags, ["film", "motion"]);
  assert.equal(job.alt, "Titles fade over a dark stage");
  assert.deepEqual(job.zh, { title: "短片", text: "一部关于电影的短片。", topics: ["短片", "动画"] });
  await page.getByRole("status").getByText("Queued. Your laptop will publish each destination once.").waitFor();
  assert.equal(new URL(page.url()).searchParams.has("draft"), false);
  assert.equal(await page.locator(".publisher-previews video").count(), 0);
  // A draft that's gone says so, and leaves the composer usable.
  await page.goto("http://127.0.0.1:8797/publisher.html?draft=00000000-0000-4000-8000-000000000bad");
  await page.getByRole("alert").getByText("This draft has expired or was already posted").waitFor();
  assert.equal(await page.getByRole("textbox", { name: "Post" }).isDisabled(), false);
  assert.deepEqual(errors, []);

  // Farcaster and Lens can be chosen, say when they can't take a post, and wait for their accounts like the rest.
  await page.goto("http://127.0.0.1:8797/publisher.html?connecting=lens");
  const accounts = page.getByRole("region", { name: "Publishing accounts" });
  const lensAccount = accounts.locator(".publisher-account", { hasText: "Lens" });
  await lensAccount.getByText("Connecting…").waitFor();
  assert.equal(
    await lensAccount.getByRole("link", { name: "https://hey.xyz/settings/manager" }).getAttribute("href"),
    "https://hey.xyz/settings/manager",
  );
  await lensAccount.getByText("0x1111111111111111111111111111111111111111", { exact: false }).waitFor();
  await lensAccount.getByRole("button", { name: "Cancel" }).waitFor();
  assert.equal(await lensAccount.getByRole("button", { name: "Finish sign-in" }).count(), 0);
  if (shots) await page.screenshot({ path: path.join(shots, "lens-connecting.png"), fullPage: true });
  await page.goto("http://127.0.0.1:8797/publisher.html?connecting=farcaster");
  const farcasterAccount = accounts.locator(".publisher-account", { hasText: "Farcaster" });
  await farcasterAccount.getByText("Approve the posting key in the Chrome window").waitFor();
  assert.equal(await farcasterAccount.getByRole("button", { name: "Finish sign-in" }).count(), 0);

  await page.goto("http://127.0.0.1:8797/publisher.html");
  const destination = (name) => page.locator(".publisher-destinations label", { hasText: name });
  await page.getByRole("navigation", { name: "Presets" }).getByRole("button", { name: "Text post", exact: true }).click();
  await destination("Farcaster").locator("input").check();
  await destination("Lens").locator("input").check();
  await page.getByRole("textbox", { name: "Post" }).fill("Hello from the protocols");
  await page.getByRole("textbox", { name: "Tags" }).fill("#film");
  await page.getByText("Waiting for Farcaster, Lens sign-in.").waitFor();
  const threePhotos = Array.from({ length: 3 }, (_, i) => ({ name: `p${i}.png`, mimeType: "image/png", buffer: png }));
  await page.locator('input[type="file"][accept="image/*"]').setInputFiles(threePhotos);
  assert.equal(await destination("Farcaster").locator("small").textContent(), "takes up to 2 photos");
  assert.equal(await destination("Lens").locator("input").isChecked(), true);
  await page.getByRole("button", { name: "Remove media" }).click();
  assert.equal(await destination("Farcaster").locator("input").isChecked(), true);
  await page.getByText("What each platform gets").click();
  const lensVersion = page.locator(".publisher-variants section", { hasText: "Lens" });
  assert.equal(await lensVersion.locator("small").textContent(), "Hidden tags: #film");
  assert.equal(await page.locator(".publisher-variants section", { hasText: "Farcaster" }).locator("small").count(), 0);
  await page.getByRole("button", { name: "Queue post" }).click();
  const protocols = await queued(page);
  assert.deepEqual(protocols.platforms, ["bluesky", "twitter", "farcaster", "lens"]);
  assert.equal(protocols.metadata.farcaster, "remove-all");
  assert.deepEqual(errors, []);
  await context.close();

  // A Chinese version goes to Xiaohongshu in place of the video; every other destination keeps the original.
  const chineseContext = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
  const zhPage = await chineseContext.newPage();
  const zhErrors = [];
  zhPage.on("pageerror", (error) => zhErrors.push(error.message));
  const chineseVideoId = "00000000-0000-4000-8000-00000000d1d1";
  await zhPage.route(`**/api/publisher/media/${videoId}`, (route) =>
    route.fulfill({ contentType: tallClip.mimeType, body: tallClip.buffer }),
  );
  await zhPage.route(`**/api/publisher/media/${chineseVideoId}`, (route) =>
    route.fulfill({ contentType: wideClip.mimeType, body: wideClip.buffer }),
  );
  const zhQueued = () => queued(zhPage);
  const zhButton = zhPage.getByRole("button", { name: "Chinese version", exact: true });
  await zhPage.goto("http://127.0.0.1:8797/publisher.html");
  const zhPresets = zhPage.getByRole("navigation", { name: "Presets" });
  await zhPresets.getByRole("button", { name: "Short-form video" }).click();
  // Nothing to translate yet, so no button without a video.
  await zhPage.locator('input[type="file"][accept="image/*"]').setInputFiles({
    name: "photo.png",
    mimeType: "image/png",
    buffer: png,
  });
  await zhPage.getByRole("group", { name: "Xiaohongshu · Chinese" }).waitFor();
  assert.equal(await zhButton.count(), 0);
  await zhPage.getByRole("button", { name: "Remove media" }).click();
  await zhPage.locator('input[type="file"][accept="video/*"]').first().setInputFiles(tallClip);
  await zhPage.locator(".publisher-previews video").first().waitFor();
  await zhPage.getByRole("textbox", { name: /^Title ·/ }).fill("Two versions");
  await zhPage.getByRole("textbox", { name: "Post" }).fill("The original");
  const zhFields = zhPage.getByRole("group", { name: "Xiaohongshu · Chinese" });
  await zhFields.getByRole("textbox", { name: "Title" }).fill("两个版本");
  await zhFields.getByRole("textbox", { name: "Text" }).fill("中文版。");
  // Clicking it opens a video picker of its own.
  const [zhChooser] = await Promise.all([zhPage.waitForEvent("filechooser"), zhButton.click()]);
  assert.equal(zhChooser.isMultiple(), false);
  await zhChooser.setFiles(wideClip);
  const zhPreview = zhFields.locator(".publisher-previews video");
  await zhPreview.waitFor();
  assert.equal(await zhButton.count(), 0);
  // Each version has its own preview.
  assert.equal(await zhPage.locator(".publisher-previews video").count(), 2);
  await zhFields.getByText("Xiaohongshu gets this video.").waitFor();
  await zhPage.locator(".publisher-variants summary").click();
  await zhPage.locator(".publisher-variants section", { hasText: "Xiaohongshu" }).getByText("Video: the Chinese version").waitFor();
  assert.equal(await zhPage.locator(".publisher-variants section", { hasText: "TikTok" }).getByText("Video: the Chinese version").count(), 0);
  if (shots) {
    await zhPage.waitForTimeout(300);
    await zhPage.screenshot({ path: path.join(shots, "chinese-version-desktop.png"), fullPage: true });
  }
  await zhPage.evaluate(() => (window.publisherRequests.length = 0));
  await zhPage.getByRole("button", { name: "Queue post" }).click();
  assert.equal(await uploadsBeforeJob(zhPage), 2);
  const zhJob = await zhQueued();
  assert.equal(zhJob.kind, "video");
  assert.equal(zhJob.media.length, 1);
  assert.equal(typeof zhJob.zh.video, "string");
  assert.notEqual(zhJob.zh.video, zhJob.media[0]);
  assert.equal(zhJob.zh.title, "两个版本");
  await zhPage.getByRole("status").getByText("Queued. Your laptop will publish each destination once.").waitFor();
  assert.equal(await zhPage.locator(".publisher-previews video").count(), 0);

  // Removed, it isn't sent, and leaving Xiaohongshu out leaves it out of the post too.
  await zhPage.locator('input[type="file"][accept="video/*"]').first().setInputFiles(tallClip);
  await zhPage.locator(".publisher-previews video").first().waitFor();
  await zhPage.getByRole("textbox", { name: /^Title ·/ }).fill("Two versions");
  await zhFields.getByRole("textbox", { name: "Title" }).fill("两个版本");
  await zhFields.getByRole("textbox", { name: "Text" }).fill("中文版。");
  const [zhAgain] = await Promise.all([zhPage.waitForEvent("filechooser"), zhButton.click()]);
  await zhAgain.setFiles(wideClip);
  await zhPreview.waitFor();
  await zhPage.getByRole("button", { name: "Remove the Chinese version" }).click();
  await zhButton.waitFor();
  await zhPage.getByRole("button", { name: "Queue post" }).click();
  assert.equal((await zhQueued()).zh.video, undefined);
  await zhPage.getByRole("status").getByText("Queued.", { exact: false }).waitFor();
  await zhPage.locator('input[type="file"][accept="video/*"]').first().setInputFiles(tallClip);
  await zhPage.locator(".publisher-previews video").first().waitFor();
  await zhPage.getByRole("textbox", { name: /^Title ·/ }).fill("Two versions");
  await zhFields.getByRole("textbox", { name: "Title" }).fill("两个版本");
  await zhFields.getByRole("textbox", { name: "Text" }).fill("中文版。");
  const [zhThird] = await Promise.all([zhPage.waitForEvent("filechooser"), zhButton.click()]);
  await zhThird.setFiles(wideClip);
  await zhPreview.waitFor();
  await zhPage.locator(".publisher-destinations label", { hasText: "Xiaohongshu" }).getByRole("checkbox").uncheck();
  await zhPage.evaluate(() => (window.publisherRequests.length = 0));
  await zhPage.getByRole("button", { name: "Queue post" }).click();
  assert.equal(await uploadsBeforeJob(zhPage), 1);
  const withoutXhs = await zhQueued();
  assert.equal(withoutXhs.zh, undefined);
  assert.deepEqual(zhErrors, []);
  await chineseContext.close();

  // A draft from the terminal can carry both, and neither is uploaded again.
  const draftContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const draftPage = await draftContext.newPage();
  await draftPage.route(`**/api/publisher/media/${videoId}`, (route) =>
    route.fulfill({ contentType: tallClip.mimeType, body: tallClip.buffer }),
  );
  await draftPage.route(`**/api/publisher/media/${chineseVideoId}`, (route) =>
    route.fulfill({ contentType: wideClip.mimeType, body: wideClip.buffer }),
  );
  await draftPage.goto("http://127.0.0.1:8797/publisher.html?draft=00000000-0000-4000-8000-00000000d1b0");
  await draftPage.locator(".publisher-zh-video video").waitFor();
  await draftPage.getByRole("button", { name: "Queue post" }).click();
  assert.equal(await uploadsBeforeJob(draftPage), 0);
  const twoVersions = await queued(draftPage);
  assert.deepEqual(twoVersions.media, [videoId]);
  assert.equal(twoVersions.zh.video, chineseVideoId);
  await draftContext.close();
  console.log("Publisher composer passed on desktop and mobile.");
} finally {
  rmSync(clips, { recursive: true, force: true });
  await browser.close();
  await server.close();
}
