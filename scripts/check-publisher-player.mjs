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
const CLIP = "DJI_20261108122204_0086_D";

/**
 * A clip's player, opened from the Footage tab against the mocked API (scripts/browser-fixtures/archive.mjs): a clip in
 * the cloud opens from its row, its address keeping it open; it's found in its shoot day's listing and plays as it
 * opens where the browser plays HEVC; its transcript, beside it and as captions; the looks, checked on the WebGL canvas
 * against stand-in LUTs whose colours are known; Bring to Mac; and the Archive tab's old address. Playwright's Chromium
 * has no HEVC, so it first says so, and then, told it has, plays a WebM in the original's place.
 */
export async function checkPlayer(browser, { composer, dir, shots }) {
  const file = path.join(dir, "archive-original.webm");
  const source = "color=c=0x406080:s=320x180:r=10:d=4";
  execFileSync(ffmpeg, ["-y", "-f", "lavfi", "-i", source, "-c:v", "libvpx", "-b:v", "2M", file], { stdio: "ignore" });
  const original = readFileSync(file);
  const opened = archiveDays["2026-11-08"].find((clip) => clip.file === OPENED);

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
    // The original, read only where the browser can play it.
    const reads = [];
    await page.route(`**/api/publisher/archive/files/${opened.sha256}/**`, (route) => {
      reads.push(route.request().headers().range ?? "whole");
      return route.fulfill({ contentType: "video/webm", body: original });
    });
    await page.route("http://127.0.0.1:4777/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Grade</title>" }),
    );
    const theme = width > 700 ? "dark" : "light";
    await page.goto(`${composer}/footage?theme=${theme}`);
    // The tab bar has no Archive tab: its clips play here.
    const tabs = page.getByRole("navigation", { name: "Publisher sections" });
    await tabs.getByRole("button", { name: "Footage", pressed: true }).waitFor();
    assert.equal(await tabs.getByRole("button", { name: "Archive" }).count(), 0);
    const ledger = page.getByRole("region", { name: "Footage ledger" });
    const row = (clip) => ledger.getByRole("row").filter({ hasText: clip });
    const player = page.getByRole("dialog", { name: /^Clip 0086/ });

    // Only a clip in the cloud plays: its picture is a button. One on the camera or the Mac has Grade alone.
    await row("0086").getByRole("button", { name: "Play clip 0086" }).waitFor();
    await row("0258").getByRole("button", { name: "Play clip 0258" }).waitFor();
    for (const clip of ["0402", "0399", "IMG_4857"]) {
      assert.equal(await row(clip).getByRole("button", { name: /^Play/ }).count(), 0);
      assert.equal(await row(clip).getAttribute("data-plays"), null);
    }

    // A clip opens from anywhere on its row. This browser can't play HEVC: it says so, offers to try, and reads nothing.
    await row("0086").locator("td.dim").last().click();
    await page.waitForURL(new RegExp(`/footage\\?clip=${CLIP}$`));
    await player.getByText("This browser can't play HEVC, which the camera records.", { exact: false }).waitFor();
    assert.match(await player.locator("h2 small").textContent(), /^8 Nov 2026, 12:22:04 · 2\.86 GB · D-Log2$/);
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
    // A clip opens graded: in its own grade where it has one.
    await looks.getByRole("button", { name: "Its grade", pressed: true }).waitFor();
    await player.getByText("Its grade: Velvia, +0.5 stops, 5000 K, saturation 1.30.").waitFor();
    for (const look of ["Log", "Default look"])
      assert.equal(await looks.getByRole("button", { name: look }).isEnabled(), true);
    assert.deepEqual(reads, []);
    await page.keyboard.press("Escape");
    await page.waitForURL(/\/footage$/);
    await player.waitFor({ state: "detached" });

    // From its picture, and Back closes it.
    await row("0086").getByRole("button", { name: "Play clip 0086" }).click();
    await page.waitForURL(new RegExp(`/footage\\?clip=${CLIP}$`));
    await player.waitFor();
    await page.goBack();
    await page.waitForURL(/\/footage$/);
    await player.waitFor({ state: "detached" });
    assert.equal(await page.getByRole("dialog").count(), 0);

    // A clip its day's listing doesn't have says so, with nothing to try; a listing that can't be read, until it can.
    const listing = (answer) =>
      page.evaluate((answer) => {
        window.publisherAnswer = async (input, init, respond) => {
          const asked = new URL(String(input), location.href).pathname;
          if (!answer || asked !== "/api/publisher/archive/days/2026-11-11") return respond(input, init);
          return Response.json(answer, { status: answer.error ? 503 : 200 });
        };
      }, answer);
    const other = page.getByRole("dialog", { name: /^Clip 0258/ });
    await listing({ day: "2026-11-11", at: null, clips: [] });
    await row("0258").getByRole("button", { name: "Play clip 0258" }).click();
    await other.getByText("It isn't in the cloud.").waitFor();
    assert.equal(await other.locator(".publisher-archive-overlay button").count(), 0);
    await other.getByRole("button", { name: "Close" }).click();
    await other.waitFor({ state: "detached" });
    await listing({ error: "The archive is unavailable" });
    await row("0258").getByRole("button", { name: "Play clip 0258" }).click();
    await other.getByText("Couldn't read it from the archive.").waitFor();
    await listing(null);
    await other.getByRole("button", { name: "Try again" }).click();
    await other.getByText("This browser can't play HEVC", { exact: false }).waitFor();
    await other.getByText("No transcript is filed for it.").waitFor();
    await page.keyboard.press("Escape");
    await other.waitFor({ state: "detached" });

    // Where HEVC plays: opened from its address, it plays with nothing to press, graded on the GPU.
    await page.addInitScript(() => {
      const can = HTMLMediaElement.prototype.canPlayType;
      HTMLMediaElement.prototype.canPlayType = function (type) {
        return /hvc1|hev1/.test(type) ? "probably" : can.call(this, type);
      };
    });
    await page.goto(`${composer}/footage?clip=${CLIP}&theme=${theme}`);
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
    await looks.getByRole("button", { name: "Log" }).click();
    await player.getByText("As shot, in D-Log2: flat until it's graded.").waitFor();
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
    if (shots) await page.screenshot({ path: path.join(shots, `footage-player-${name}.png`) });

    // Bring to Mac: the Grade tab's cloud list, on this clip. It says what it does, with no tooltip to say it again.
    const bring = player.getByRole("button", { name: "Bring to Mac" });
    assert.equal(await bring.getAttribute("title"), null);
    await bring.click();
    await page.waitForURL(/\/publisher\.html\/grade/);
    assert.equal(
      await page.locator('iframe[title="Grade app"]').getAttribute("src"),
      `http://127.0.0.1:4777/?theme=${theme}#clip=${OPENED}`,
    );
    // Closing the player stops the read, and the Footage tab it was in doesn't open it again.
    assert.equal(await page.locator(".publisher-archive-stage video").count(), 0);
    await tabs.getByRole("button", { name: "Footage" }).click();
    await page.waitForURL(/\/footage$/);
    await row("0086").waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0);
    await page.goBack();
    await page.waitForURL(/\/grade/);
    await page.goBack();
    await page.waitForURL(/\/footage$/);
    await row("0086").waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0);

    // The Archive tab's old address opens the Footage tab, on the same clip.
    await page.goto(`${composer}/archive?day=2026-11-08&clip=${CLIP}&theme=${theme}`);
    await page.waitForURL(new RegExp(`/footage\\?clip=${CLIP}&day=2026-11-08$`));
    await pause.waitFor();
    await page.keyboard.press("Escape");
    await page.waitForURL(/\/footage$/);
    await page.goto(`${composer}/archive?day=2026-11-08&theme=${theme}`);
    await page.waitForURL(/\/footage$/);
    await row("0086").waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
  }
}
