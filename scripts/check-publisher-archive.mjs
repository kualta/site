import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import ffmpeg from "ffmpeg-static";
import { archiveDays, CAMERA_KELVIN, GRADE, lookCube, OPENED } from "./browser-fixtures/archive.mjs";
import { composeLut, normalizeGrade, parseCube, sampleTetra } from "./grade/color.mjs";

const svg = (width, height) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#8a8f99"/></svg>`;
const near = (got, want, by, what) =>
  assert.ok(
    got.every((value, i) => Math.abs(value - want[i]) <= by),
    `${what}: ${got.join(",")}, wanted ${want.map(Math.round).join(",")} within ${by}`,
  );

/**
 * The Archive tab against the mocked API (scripts/browser-fixtures/archive.mjs): its shoot days and a page of clips at a
 * time; a clip's player, which reads nothing before Watch and says what watching costs; its transcript, beside it and
 * as captions; the looks, checked on the WebGL canvas against stand-in LUTs whose colours are known; and Bring to Mac.
 * Playwright's Chromium has no HEVC, so it first says so, and then, told it has, plays a WebM in the original's place.
 */
export async function checkArchive(browser, { composer, dir, shots }) {
  const file = path.join(dir, "archive-original.webm");
  const source = "color=c=0x406080:s=320x180:r=10:d=4";
  execFileSync(ffmpeg, ["-y", "-f", "lavfi", "-i", source, "-c:v", "libvpx", "-b:v", "2M", file], { stdio: "ignore" });
  const original = readFileSync(file);
  const day = archiveDays["2026-11-08"];
  const opened = day.find((clip) => clip.file === OPENED);

  // Nothing archived yet, the archive unreadable, and a day unreadable: each says so where its list would be.
  for (const [answers, where, text] of [
    [{ "archive/days": { days: [] } }, ".publisher-archive-day", /^Nothing is in the archive yet\./],
    [
      { "archive/days": { error: "The archive is unavailable" } },
      ".publisher-archive-days",
      "The archive is unavailable",
    ],
    [
      { "archive/days/2026-11-21": { error: "The day is unreadable" } },
      ".publisher-archive-head",
      "The day is unreadable",
    ],
  ]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript((answers) => {
      window.publisherAnswer = async (input, init, respond) => {
        const path = new URL(String(input), location.href).pathname.replace("/api/publisher/", "");
        const answer = answers[path];
        if (!answer) return respond(input, init);
        return Response.json(answer, { status: answer.error ? 503 : 200 });
      };
    }, answers);
    const page = await context.newPage();
    await page.goto(`${composer}/archive`);
    await page.locator(where).getByText(text).waitFor();
    // While it can't be read, the clips' places stay held.
    if (where === ".publisher-archive-head")
      assert.equal(await page.locator(".publisher-archive-clips").getAttribute("aria-busy"), "true");
    await context.close();
  }

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
    // The original, read only once Watch is pressed.
    const reads = [];
    await page.route(`**/api/publisher/archive/files/${opened.sha256}/**`, (route) => {
      reads.push(route.request().headers().range ?? "whole");
      return route.fulfill({ contentType: "video/webm", body: original });
    });
    await page.route("http://127.0.0.1:4777/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Grade</title>" }),
    );
    const theme = width > 700 ? "dark" : "light";
    await page.goto(`${composer}/archive?theme=${theme}`);
    const archive = page.getByRole("region", { name: "Archive", exact: true });
    const days = archive.getByRole("navigation", { name: "Shoot days" });
    const summary = archive.locator(".publisher-archive-head .publisher-note");
    const cards = archive.locator(".publisher-archive-clips > li:not(.publisher-archive-slot)");
    const pager = archive.locator(".publisher-archive-head");

    // The newest day first, open; each clip with what the ledger and the archive know of it.
    await days.getByRole("button", { name: /21 Nov 2026/, pressed: true }).waitFor();
    assert.deepEqual(
      (await days.getByRole("button").allTextContents()).map((text) => text.replace(",", "")),
      ["Sat 21 Nov 2026", "Wed 11 Nov 2026", "Sun 8 Nov 2026"],
    );
    await summary.filter({ hasText: "1 clip · 3.00 GB · 1 transcribed" }).waitFor();
    const first = archive.getByRole("button", { name: "Clip 0402, recorded 10:15:00" });
    assert.deepEqual(await first.locator(".line").allTextContents(), [
      "040210:15:00",
      "3.00 GB · D-Log2",
      "Transcript",
      "Also on camera · graded on Mac",
    ]);
    await first.locator(".publisher-archive-thumb img").waitFor();

    // A long day, a page of clips at a time, the page in the address.
    await days.getByRole("button", { name: /8 Nov 2026/ }).click();
    await page.waitForURL(/\?day=2026-11-08$/);
    const bytes = day.reduce((sum, clip) => sum + clip.size, 0);
    await summary
      .filter({ hasText: `30 clips · ${(bytes / 1e9).toFixed(2)} GB · ${day.filter((c) => c.vtt).length} transcribed` })
      .waitFor();
    assert.equal(await cards.count(), 24);
    await pager.getByText("1–24 of 30").waitFor();
    assert.equal(await pager.getByRole("button", { name: "Previous page" }).isDisabled(), true);
    await pager.getByRole("button", { name: "Next page" }).click();
    await pager.getByText("25–30 of 30").waitFor();
    await page.waitForURL(/page=2/);
    assert.equal(await cards.count(), 6);
    assert.equal(await pager.getByRole("button", { name: "Next page" }).isDisabled(), true);
    // The foot of the page has its own, which goes back up to the top of the clips.
    await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
    await archive.locator(".publisher-archive-foot").getByRole("button", { name: "Previous page" }).click();
    await pager.getByText("1–24 of 30").waitFor();
    assert.ok((await archive.locator(".publisher-archive-clips").boundingBox()).y >= 0);

    // A clip opens in its player, which reads nothing until Watch and says first what watching costs.
    await archive.getByRole("button", { name: "Clip 0086, recorded 12:22:04" }).click();
    await page.waitForURL(/clip=DJI_20261108122204_0086_D/);
    const player = page.getByRole("dialog", { name: /^Clip 0086/ });
    await player.getByText("This browser can't play HEVC, which the camera records.", { exact: false }).waitFor();
    await player.getByText(`Reads up to ${(opened.size / 1e9).toFixed(2)} GB, about $0.03, from Cloudflare`).waitFor();
    await player.getByRole("button", { name: "Try anyway" }).waitFor();
    const transcript = player.getByRole("complementary", { name: "Transcript" });
    assert.deepEqual(await transcript.getByRole("button").allTextContents(), [
      "0:00Okay, rolling.",
      "0:01This is the market at noon.",
      "0:02Let's walk.",
    ]);
    // A line picked before watching is where watching starts.
    await transcript.getByRole("button", { name: /market at noon/ }).click();
    await player.getByRole("button", { name: "Try anyway from 0:01" }).waitFor();
    const looks = player.getByRole("group", { name: "Look" });
    await looks.getByRole("button", { name: "Log", pressed: true }).waitFor();
    await player.getByText("As shot, in D-Log2: flat until it's graded.").waitFor();
    for (const look of ["Default look", "Its grade"])
      assert.equal(await looks.getByRole("button", { name: look }).isEnabled(), true);
    assert.deepEqual(reads, []);
    await page.keyboard.press("Escape");
    await page.waitForURL(/\?day=2026-11-08$/);

    // Where HEVC plays: opened from its address, watched, and graded on the GPU.
    await page.addInitScript(() => {
      const can = HTMLMediaElement.prototype.canPlayType;
      HTMLMediaElement.prototype.canPlayType = function (type) {
        return /hvc1|hev1/.test(type) ? "probably" : can.call(this, type);
      };
    });
    await page.goto(`${composer}/archive?day=2026-11-08&clip=DJI_20261108122204_0086_D&theme=${theme}`);
    await player.getByRole("button", { name: "Watch", exact: true }).click();
    const pause = player.getByRole("button", { name: "Pause" });
    await pause.waitFor();
    await page.waitForFunction(() => document.querySelector(".publisher-archive-stage video").currentTime > 0.3);
    await pause.click();
    assert.ok(reads.length > 0);
    const pixel = () =>
      page.evaluate(() => {
        const gl = document.querySelector(".publisher-archive-stage canvas");
        const copy = document.createElement("canvas");
        copy.width = gl.width;
        copy.height = gl.height;
        const draw = copy.getContext("2d");
        draw.drawImage(gl, 0, 0);
        return [...draw.getImageData(gl.width >> 1, gl.height >> 1, 1, 1).data.slice(0, 3)];
      });
    const input = await pixel();
    near(input, [0x40, 0x60, 0x80], 8, "As shot");

    await looks.getByRole("button", { name: "Default look" }).click();
    await player.getByText("D-Log2 through Colorful, live on this browser's GPU.").waitFor();
    // The stand-in default look is the negative.
    near(
      await pixel(),
      input.map((v) => 255 - v),
      2,
      "Default look",
    );

    await looks.getByRole("button", { name: "Its grade" }).click();
    await player.getByText("Its grade: Velvia, +0.5 stops, 5000 K, saturation 1.30.").waitFor();
    // Composed as the grade app composes it, from the camera's white balance in its export record.
    const velvia = parseCube(lookCube("fujifilm-velvia"));
    const graded = { size: 33, min: [0, 0, 0], max: [1, 1, 1] };
    graded.data = composeLut({
      profile: "dlog2",
      grade: normalizeGrade(GRADE),
      shotK: CAMERA_KELVIN,
      base: velvia,
      size: 33,
    });
    const want = sampleTetra(graded, ...input.map((v) => v / 255)).map((v) => v * 255);
    near(await pixel(), want, 4, "Its grade");
    // Chosen once, the look stays chosen for the next clip.
    assert.equal(await page.evaluate(() => localStorage.getItem("publisher.archiveLook")), "grade");

    // The transcript seeks, and the line said shows over the picture.
    await transcript.getByRole("button", { name: /Let's walk/ }).click();
    await transcript.locator('button[aria-current="true"]').filter({ hasText: "Let's walk." }).waitFor();
    await player.locator(".publisher-archive-caption").filter({ hasText: "Let's walk." }).waitFor();
    const at = await page.evaluate(() => document.querySelector(".publisher-archive-stage video").currentTime);
    assert.ok(at >= 2.4, `seeked to ${at}`);
    if (shots) await page.screenshot({ path: path.join(shots, `archive-player-${name}.png`) });

    // Bring to Mac: the Grade tab's Cloudflare list, on this clip.
    await player.getByRole("button", { name: "Bring to Mac" }).click();
    await page.waitForURL(/\/publisher\.html\/grade/);
    assert.equal(
      await page.locator('iframe[title="Grade app"]').getAttribute("src"),
      `http://127.0.0.1:4777/?theme=${theme}#clip=${OPENED}`,
    );
    // Closing the player stops the read.
    assert.equal(await page.locator(".publisher-archive-stage video").count(), 0);

    await page.goto(`${composer}/archive?day=2026-11-08&theme=${theme}`);
    await cards.first().waitFor();
    if (shots) await page.screenshot({ path: path.join(shots, `archive-${name}.png`), fullPage: true });
    assert.deepEqual(errors, []);
    await context.close();
  }
}
