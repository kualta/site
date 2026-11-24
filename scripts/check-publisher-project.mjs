import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import ffmpeg from "ffmpeg-static";
import { FILM, FILM_OUTPUTS } from "./browser-fixtures/archive.mjs";

const svg = (width, height) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#8a8f99"/></svg>`;

/**
 * A film's page, opened from the footage table against the mocked API (scripts/browser-fixtures/archive.mjs): its
 * outputs from its manifest in the archive, the render and the Chinese render, each playing in place with Range and to
 * download, with its size and length; the post it went out as, with its analytics and platforms; and its clips, each
 * opening its player, Back coming back to the film. Its address keeps it open, and Back closes it. A film still on the
 * Mac says so. Playwright's Chromium has no H.264, so the renders are WebMs in their place.
 */
export async function checkProject(browser, { composer, dir, shots }) {
  const file = path.join(dir, "film-render.webm");
  const source = "color=c=0x707070:s=180x320:r=10:d=3";
  execFileSync(ffmpeg, ["-y", "-f", "lavfi", "-i", source, "-c:v", "libvpx", file], { stdio: "ignore" });
  const render = readFileSync(file);
  const fileUrl = (hash, name) => `/api/publisher/archive/files/${hash}/${name}`;

  for (const [width, name] of [
    [1280, "desktop"],
    [390, "mobile"],
  ]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/publisher/footage/thumbs/**", (route) =>
      route.fulfill({ contentType: "image/svg+xml", body: svg(64, 36) }),
    );
    await page.route("https://i.ytimg.com/**", (route) =>
      route.fulfill({ contentType: "image/svg+xml", body: svg(320, 180) }),
    );
    const reads = [];
    await page.route("**/api/publisher/archive/files/**", (route) => {
      reads.push({ path: new URL(route.request().url()).pathname, range: route.request().headers().range ?? null });
      return route.fulfill({ contentType: "video/webm", body: render });
    });
    const theme = width > 700 ? "dark" : "light";
    await page.goto(`${composer}/footage?theme=${theme}`);
    const ledger = page.getByRole("region", { name: "Footage ledger" });
    const row = (clip) => ledger.getByRole("row").filter({ hasText: clip });
    const film = page.getByRole("dialog", { name: /^013 · maybe-later/ });

    // A film's link in the table opens its page, and only that: not the player of the clip whose row it's in.
    await row("0086").getByRole("link", { name: "013 · maybe-later" }).click();
    await page.waitForURL(new RegExp(`/footage\\?project=${FILM}$`));
    await film.waitFor();
    assert.equal(await page.getByRole("dialog").count(), 1);
    await film.locator("h2 small").filter({ hasText: "Archived 20 Nov 2026" }).waitFor();

    // What it made, from its manifest: the render, then the Chinese render, each with its size and, once read, its
    // length, and a download named as the file was.
    const outputs = film.getByRole("region", { name: "Outputs" });
    const captions = outputs.locator("figcaption > span");
    await captions.filter({ hasText: "Chinese · 78 MB · 0:03" }).waitFor();
    assert.deepEqual(await captions.allTextContents(), ["Render · 77 MB · 0:03", "Chinese · 78 MB · 0:03"]);
    for (const [label, hash, file] of [
      ["Download Render", FILM_OUTPUTS.render, `${FILM}.mp4`],
      ["Download Chinese", FILM_OUTPUTS.zh, `${FILM}-zh.mp4`],
    ]) {
      const link = outputs.getByRole("link", { name: label });
      assert.equal(await link.getAttribute("href"), fileUrl(hash, file));
      assert.equal(await link.getAttribute("download"), file);
    }
    // Each plays in place, streamed from the archive a range at a time.
    for (const [output, hash, file] of [
      ["Render", FILM_OUTPUTS.render, `${FILM}.mp4`],
      ["Chinese", FILM_OUTPUTS.zh, `${FILM}-zh.mp4`],
    ]) {
      const video = outputs.locator(`video[aria-label="${output}"]`);
      await video.evaluate((element) => element.play());
      await page.waitForFunction(
        (label) => document.querySelector(`.publisher-project video[aria-label="${label}"]`).currentTime > 0,
        output,
      );
      await video.evaluate((element) => element.pause());
      assert.ok(
        reads.some((read) => read.path === fileUrl(hash, file) && read.range?.startsWith("bytes=")),
        `${output} wasn't read with Range: ${JSON.stringify(reads)}`,
      );
    }
    // Every read was of its outputs: none of the rest of the film, nor the clips' originals.
    assert.ok(reads.every((read) => [FILM_OUTPUTS.render, FILM_OUTPUTS.zh].some((hash) => read.path.includes(hash))));

    // The post it went out as: its numbers, where the table's film used to link, and where it went out.
    const post = film.getByRole("region", { name: "Post" });
    assert.match(
      await post.getByRole("link", { name: "Analytics" }).getAttribute("href"),
      /\/analytics\?post=00000000-0000-4000-8000-000000000008$/,
    );
    assert.deepEqual(await post.getByRole("listitem").allTextContents(), ["YouTube", "Instagram"]);
    assert.equal(
      await post.getByRole("link", { name: "YouTube" }).getAttribute("href"),
      "https://www.youtube.com/shorts/CJs864wmjB0",
    );
    // The clips it's cut from.
    const clips = film.getByRole("region", { name: /^Clips/ });
    assert.deepEqual(await clips.getByRole("button").allTextContents(), [
      "00868 Nov, 12:22 · 0:30",
      "025811 Nov, 16:12 · 0:30",
    ]);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (shots) await page.screenshot({ path: path.join(shots, `footage-project-${name}.png`) });

    // A clip opens its player in the film's place; Back comes back to the film, and Back again closes it.
    await clips.getByRole("button", { name: "Play clip 0086" }).click();
    await page.waitForURL(/\/footage\?clip=DJI_20261108122204_0086_D$/);
    await page.getByRole("dialog", { name: /^Clip 0086/ }).waitFor();
    await film.waitFor({ state: "detached" });
    await page.goBack();
    await page.waitForURL(new RegExp(`/footage\\?project=${FILM}$`));
    await film.waitFor();
    // Read once: it comes back as it was.
    assert.deepEqual(
      (await captions.allTextContents()).map((text) => text.split(" · ").slice(0, 2).join(" · ")),
      ["Render · 77 MB", "Chinese · 78 MB"],
    );
    await page.goBack();
    await page.waitForURL(/\/footage\?theme=\w+$/);
    await film.waitFor({ state: "detached" });
    assert.equal(await page.getByRole("dialog").count(), 0);

    // A film still on the Mac, opened by its address, says so, and Escape closes it.
    await page.goto(`${composer}/footage?project=014-walk&theme=${theme}`);
    const walk = page.getByRole("dialog", { name: /^014 · walk/ });
    await walk.getByText("Not archived yet", { exact: true }).waitFor();
    assert.equal(await walk.locator("h2 small").textContent(), "On the Mac");
    assert.equal(await walk.getByRole("region", { name: "Post" }).getByText("Not posted", { exact: true }).count(), 1);
    assert.equal(await walk.locator("video").count(), 0);
    if (shots) await page.screenshot({ path: path.join(shots, `footage-project-mac-${name}.png`) });
    await page.keyboard.press("Escape");
    await page.waitForURL(/\/footage$/);
    await walk.waitFor({ state: "detached" });
    assert.deepEqual(errors, []);
    await context.close();
  }
}
