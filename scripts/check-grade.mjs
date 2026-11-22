import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegStatic from "ffmpeg-static";
import { chromium } from "playwright";
import { gradeKey, writeCube } from "./grade/color.mjs";

// Drives the grade app against a throwaway library: one synthetic D-Log2 clip (a static colour field, so a paused
// preview and an exported frame show the same picture) and a non-linear stand-in base look. It grades the clip,
// reads the WebGL preview, exports through the UI, and checks the exported frame matches what the preview showed.
// Not run in CI (it needs WebGL); run it after changing scripts/grade.
const ffmpeg = process.env.FFMPEG_PATH || ffmpegStatic;
const shots = process.env.SCREENSHOT_DIR;
const port = 8798;
const root = mkdtempSync(path.join(tmpdir(), "grade-check-"));
const movies = path.join(root, "Movies");
const original = path.join(movies, "Original");
const exported = path.join(movies, "Exported");
const data = path.join(root, "data");
const name = "DJI_20260101120000_0001_D.MP4";
mkdirSync(original, { recursive: true });
mkdirSync(path.join(data, "luts"), { recursive: true });

// A static field: red across, green down, blue constant, as D-Log2 code values.
execFileSync(ffmpeg, [
  "-hide_banner", "-loglevel", "error", "-y",
  "-f", "lavfi", "-i", "color=c=black:s=640x360:r=24:d=2,format=rgb24,geq=r='40+X/W*180':g='40+Y/H*180':b='110'",
  "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
  "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "8", "-colorspace", "bt709", "-color_range", "tv",
  "-c:a", "aac", "-metadata", "com.dji.camera.ColorGammaSxS=D-Log2", "-metadata", "com.dji.camera.WhiteBalanceKelvin=5600",
  "-movflags", "use_metadata_tags", path.join(original, name),
]);
// A second, never-graded clip: "Re-export N changed" must leave it alone.
const other = "DJI_20260101120500_0002_D.MP4";
execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", path.join(original, name), "-c", "copy", "-map_metadata", "0", "-movflags", "use_metadata_tags", path.join(original, other)]);

// A smooth non-linear base look standing in for the ACES conversion.
const size = 33;
const base = new Float32Array(size ** 3 * 3);
for (let b = 0, i = 0; b < size; b++)
  for (let g = 0; g < size; g++)
    for (let r = 0; r < size; r++) {
      const [x, y, z] = [r, g, b].map((v) => v / (size - 1));
      base[i++] = Math.min(1, x ** 0.7 * 1.05);
      base[i++] = 0.6 * y + 0.4 * y * y;
      base[i++] = Math.sin(z * 1.3) / Math.sin(1.3);
    }
writeFileSync(path.join(data, "luts/dlog2-to-rec709-aces2.cube"), writeCube(size, base, "check base"));

// The sound of two clips offloaded before, and a stand-in for the Whisper that transcribes it, which waits for `go`.
const cache = path.join(root, "cache");
mkdirSync(path.join(cache, "audio/2025-12-31"), { recursive: true });
for (const n of [1, 2]) writeFileSync(path.join(cache, `audio/2025-12-31/DJI_2025123112000${n}_000${n}_D.MP4.m4a`), "sound");
const uvx = path.join(root, "uvx");
const go = path.join(root, "go");
writeFileSync(uvx, `#!/bin/sh\nwhile [ ! -e "${go}" ]; do [ -e "${uvx}" ] || exit 1; sleep 0.1; done\necho "error: no GPU" >&2\nexit 1\n`, { mode: 0o755 });

// A stand-in for the site's archive, holding a shoot day of 227 clips offloaded before: two are real ones, the first
// graded before it went, with its graded copy; one's bytes stop partway.
const cloud = { blobs: new Map(), manifests: {}, held: null, down: false };
const cloudDay = "2025-12-30";
const cloudClip = (n) => `DJI_20251230${String(100000 + n)}_${String(n).padStart(4, "0")}_D`;
const [gone, partial, second, missing] = [101, 102, 103, 227].map((n) => `${cloudClip(n)}.MP4`);
const file = (project, at, bytes) => {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  cloud.blobs.set(sha256, bytes);
  cloud.manifests[project] ??= { archivedAt: "2025-12-31T00:00:00.000Z", files: [] };
  cloud.manifests[project].files.push({ path: at, sha256, size: bytes.length, mtime: Date.parse("2025-12-30T10:00:00Z") });
  return sha256;
};
for (let n = 1; n <= 227; n++) {
  const at = `assets/${cloudClip(n)}.MP4`;
  if (at.endsWith(gone) || at.endsWith(second)) file(`_originals-${cloudDay}`, at, readFileSync(path.join(original, name)));
  else if (at.endsWith(partial)) cloud.held = file(`_originals-${cloudDay}`, at, Buffer.alloc(1_000_000, "held"));
  else file(`_originals-${cloudDay}`, at, Buffer.from(`clip ${n}`));
}
file(`_originals-${cloudDay}`, `transcripts/${gone.replace(".MP4", ".vtt")}`, Buffer.from("WEBVTT"));
file(`_graded-${cloudDay}`, `assets/${gone.replace(".MP4", ".mp4")}`, Buffer.from("a graded copy"));
const archive = createServer((req, res) => {
  const at = decodeURIComponent(req.url.replace("/api/publisher/helper/archive/", "").split("?")[0]);
  const reply = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (cloud.down) return req.socket.destroy();
  if (req.method !== "GET") return req.resume().on("end", () => reply(200, { ok: true }));
  if (at === "projects") return reply(200, { projects: Object.entries(cloud.manifests).map(([project, { archivedAt }]) => ({ name: project, archivedAt })) });
  if (at.startsWith("projects/")) return reply(200, cloud.manifests[at.slice("projects/".length)]);
  const blob = cloud.blobs.get(at.replace("blobs/", ""));
  if (!blob) return reply(404, { error: "Not found" });
  res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": blob.length });
  if (at === `blobs/${cloud.held}`) res.write(blob.subarray(0, 420_000));
  else res.end(blob);
});
await new Promise((resolve) => archive.listen(0, "127.0.0.1", resolve));
mkdirSync(path.join(root, "publisher"));
writeFileSync(path.join(root, "publisher/config.json"), JSON.stringify({ origin: `http://127.0.0.1:${archive.address().port}`, token: "t" }));
writeFileSync(path.join(data, "grades.json"), JSON.stringify({ version: 1, clips: { [gone]: { base: "aces", exposure: 0.4, kelvin: null, tint: 0, contrast: 1, saturation: 1 } } }));

const server = spawn(process.execPath, ["scripts/grade/server.mjs"], {
  env: { ...process.env, GRADE_ROOT: movies, GRADE_DATA: data, GRADE_CACHE: cache, GRADE_CAMERA: path.join(root, "no-camera"), GRADE_PORT: String(port), GRADE_UVX: uvx, GRADE_PUBLISHER: path.join(root, "publisher"), GRADE_KEEP_FREE: "1000000" },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve, reject) => {
  server.stdout.on("data", (c) => String(c).includes("grade:") && resolve());
  server.on("exit", (code) => reject(new Error(`server exited ${code}`)));
});

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  const row = page.getByRole("button", { name: /0001/ });
  await row.getByText("Not graded").waitFor({ timeout: 30_000 });
  // Previews are made on request: wait for this one to arrive and draw.
  await page.waitForFunction(() => document.getElementById("empty").hidden, null, { timeout: 60_000 });
  await page.waitForTimeout(1200);
  if (shots) await page.screenshot({ path: path.join(shots, "grade-1-opened.png") });

  // What Whisper is doing has its own room in the bar: saying it, or not, moves nothing.
  const transcribing = page.locator("#transcribing");
  await page.getByText("Transcribing 1 of 2", { exact: true }).waitFor({ timeout: 5_000 });
  const places = () =>
    page.evaluate(() =>
      ["footage-link", "transcribing", "export", "export-more"].map((id) => {
        const { x, width } = document.getElementById(id).getBoundingClientRect();
        return [id, x, width];
      }),
    );
  const saying = await places();
  const fits = await transcribing.evaluate((el) => {
    const { textContent } = el;
    el.textContent = "Transcribing 88 of 88";
    const room = el.scrollWidth <= el.clientWidth;
    el.textContent = textContent;
    return room;
  });
  assert.ok(fits, "two-digit counts fit the room");
  writeFileSync(go, "");
  await page.getByText("2 not transcribed", { exact: true }).waitFor({ timeout: 10_000 });
  assert.equal(await transcribing.getAttribute("title"), "no GPU");
  assert.deepEqual(await places(), saying, "failing moves nothing");
  await transcribing.evaluate((el) => {
    el.textContent = "";
  });
  assert.deepEqual(await places(), saying, "nor does saying nothing");

  const setRange = (id, value) =>
    page.evaluate(([id, value]) => {
      const el = document.getElementById(id);
      el.value = String(value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, [id, value]);
  await setRange("c-exposure", 0.75);
  await setRange("c-kelvin", 4800);
  await setRange("c-saturation", 1.3);
  await page.waitForFunction(() => document.getElementById("n-exposure").value === "+0.75");
  await row.getByText("Grade not exported").waitFor({ timeout: 5_000 });
  await page.waitForTimeout(1500);
  if (shots) await page.screenshot({ path: path.join(shots, "grade-2-graded.png") });

  // The preview's own pixels, at the clip's own size (the preview plays the original).
  const preview = await page.evaluate(() => {
    const c = document.getElementById("canvas");
    const t = document.createElement("canvas");
    t.width = c.width;
    t.height = c.height;
    const ctx = t.getContext("2d");
    ctx.drawImage(c, 0, 0);
    return { w: c.width, h: c.height, px: Array.from(ctx.getImageData(0, 0, c.width, c.height).data) };
  });
  assert.equal(preview.w, 640, "the preview draws the original at its own size");

  const grades = JSON.parse(readFileSync(path.join(data, "grades.json"), "utf8"));
  assert.equal(grades.clips[name].exposure, 0.75, "the grade is saved");

  await page.getByRole("button", { name: "Export", exact: true }).click();
  await row.getByText("Graded", { exact: true }).waitFor({ timeout: 120_000 });
  if (shots) await page.screenshot({ path: path.join(shots, "grade-3-exported.png") });

  const record = () => JSON.parse(readFileSync(path.join(data, "exports.json"), "utf8")).clips[name];
  assert.equal(record().key, gradeKey(record().grade), "the record's key matches its grade");
  assert.equal(record().grade.kelvin, 4800);
  assert.deepEqual(readdirSync(exported), ["DJI_20260101120000_0001_D.mp4"], "Exported holds the export and nothing else");

  const frame = execFileSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-ss", "1", "-i", path.join(movies, record().file), "-frames:v", "1",
    // accurate_rnd: swscale's default 8-bit YUV→RGB path reads limited range about 2 levels low.
    "-vf", `scale=${preview.w}:${preview.h}:in_color_matrix=bt709:in_range=tv:flags=accurate_rnd+full_chroma_int,format=rgb24`, "-f", "rawvideo", "-",
  ], { maxBuffer: 64 * 1024 * 1024 });
  // Compare 8×8 patch means of `rgb` (preview-sized RGB) with the preview, on a grid away from the edges. Where a
  // channel clips steeply, chroma resampling moves the edge a pixel, so the check holds the mean and the 95th
  // percentile, not the single worst patch.
  const compare = (label, rgb) => {
    const diffs = [];
    for (let y = 24; y < preview.h - 24; y += 24)
      for (let x = 24; x < preview.w - 24; x += 24)
        for (let k = 0; k < 3; k++) {
          let a = 0;
          let b = 0;
          for (let dy = 0; dy < 8; dy++)
            for (let dx = 0; dx < 8; dx++) {
              a += preview.px[((y + dy) * preview.w + x + dx) * 4 + k];
              b += rgb[((y + dy) * preview.w + x + dx) * 3 + k];
            }
          diffs.push(Math.abs(a - b) / 64);
        }
    diffs.sort((a, b) => a - b);
    const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length;
    const p95 = diffs[Math.floor(diffs.length * 0.95)];
    console.log(`preview vs ${label} over ${diffs.length} patch channels: mean ${mean.toFixed(2)}, 95% within ${p95.toFixed(2)}, worst ${diffs.at(-1).toFixed(2)} of 255`);
    assert.ok(mean <= 1.5 && p95 <= 4, `the preview matches the ${label}`);
  };
  compare("export", frame);

  // Export frame (in the menu): a PNG of the frame on screen, the same picture as the preview.
  const more = page.getByRole("button", { name: "More ways to export" });
  await more.click();
  await page.getByRole("button", { name: /^Export frame/ }).click();
  await page.getByText(/Saved frame/).waitFor({ timeout: 30_000 });
  const frameFile = readdirSync(exported).find((f) => f.startsWith("DJI_20260101120000_0001_D_f"));
  assert.ok(frameFile, "the frame is saved in Exported");
  const still = execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", path.join(exported, frameFile), "-vf", "format=rgb24", "-f", "rawvideo", "-"], { maxBuffer: 64 * 1024 * 1024 });
  compare("exported frame", still);

  // Quality below 100% shows on Export and says what the selection would come to.
  await more.click();
  await setRange("quality", 50);
  const note = await page.locator("#quality-size").textContent();
  assert.match(note, /^≈ \d.* (KB|MB|GB) for this clip$/, `the menu shows the size (${note})`);
  assert.equal(await page.locator("#export-quality").textContent(), "50%");
  await setRange("quality", 100);
  assert.ok(await page.locator("#export-quality").isHidden(), "full quality needs no badge");
  if (shots) await page.screenshot({ path: path.join(shots, "grade-4-menu.png") });
  // The offload's switches: what each has to do.
  assert.equal(await page.locator("#offload-transcripts").textContent(), "Nothing to send");
  assert.equal(await page.locator("#offload-camera").textContent(), "Not plugged in");
  assert.match(await page.locator("#offload-mac").textContent(), /^2 clips · .* to send$/);
  assert.match(await page.locator("#offload-exports").textContent(), /^1 clip · .* to send$/);
  assert.ok(await page.getByRole("button", { name: "Start Camera → Mac" }).isDisabled(), "nothing to take off no camera");
  // A shoot day is kept, and let go again.
  const days = page.getByRole("group", { name: "Days kept on the camera and this Mac" });
  await days.getByRole("checkbox", { name: /2026-01-01/ }).check();
  await page.waitForFunction(() => document.getElementById("offload-kept").textContent === "2 clips", null, { timeout: 5_000 });
  assert.equal(await page.locator("#offload-mac").textContent(), "Nothing to send");
  assert.deepEqual(JSON.parse(readFileSync(path.join(data, "keep.json"), "utf8")).days, ["2026-01-01"]);
  await days.getByRole("checkbox", { name: /2026-01-01/ }).uncheck();
  await page.waitForFunction(() => document.getElementById("offload-kept").textContent === "None", null, { timeout: 5_000 });
  // When the camera's copies go is remembered.
  await page.getByRole("button", { name: "Once in Cloudflare" }).click();
  await page.waitForFunction(() => document.querySelector('[data-clear-after="sent"]').getAttribute("aria-pressed") === "true");
  assert.deepEqual(JSON.parse(readFileSync(path.join(data, "offload.json"), "utf8")), { clearCardAfter: "sent" });

  // Change the exported clip's grade: the menu's re-export takes that one clip and nothing else.
  await setRange("c-exposure", 0.5);
  await page.getByRole("button", { name: "Re-export 1 changed" }).waitFor({ timeout: 10_000 });
  await page.getByRole("button", { name: "Re-export 1 changed" }).click();
  const queued = await page.evaluate(async () => {
    const j = (await (await fetch("/api/jobs")).json()).export;
    return [j.current?.name, ...j.queue.map((q) => q.name)].filter(Boolean);
  });
  assert.deepEqual(queued.length ? queued : [name], [name], `only the changed clip is re-exported (queued: ${queued.join(", ")})`);
  await row.getByText("Graded", { exact: true }).waitFor({ timeout: 120_000 });
  assert.ok(!existsSync(path.join(exported, "DJI_20260101120500_0002_D.mp4")), "the never-graded clip was left alone");
  assert.equal(record().grade.exposure, 0.5);

  // Deflicker: Off, Light or Strong, saved with the grade and counted in its key; the panel says it's export only.
  const deflicker = page.getByRole("group", { name: "Deflicker" });
  const level = (text) => deflicker.getByRole("button", { name: text, exact: true });
  const pressed = async () => (await deflicker.locator('[aria-pressed="true"]').textContent()).trim();
  const saved = (n = name) => JSON.parse(readFileSync(path.join(data, "grades.json"), "utf8")).clips[n] ?? {};
  const savedSoon = (check, what) => page.waitForTimeout(700).then(() => assert.ok(check(), what));
  assert.equal(await pressed(), "Off");
  await page.getByText("Applies on export; the preview doesn't show it.").waitFor();
  await level("Light").click();
  await row.getByText("Changed since export").waitFor({ timeout: 5_000 });
  await savedSoon(() => saved().deflicker === "light", "Light is saved with the grade");
  if (shots) await page.screenshot({ path: path.join(shots, "grade-5-deflicker.png") });
  // Arrows step through the choices, as on a slider.
  await page.keyboard.press("ArrowRight");
  assert.equal(await pressed(), "Strong");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await pressed(), "Off");
  await savedSoon(() => !("deflicker" in saved()), "Off leaves no deflicker in the grade");
  // Back off, the grade is the exported one again.
  await row.getByText("Graded", { exact: true }).waitFor({ timeout: 5_000 });
  // Several clips: the panel shows the primary's and says Mixed; a choice sets it on all, the group's Reset clears it.
  await level("Light").click();
  await page.getByRole("button", { name: /0002/ }).click({ modifiers: ["Shift"] });
  const mixed = page.locator('.ctl[data-field="deflicker"] .mixed');
  await mixed.waitFor({ state: "visible", timeout: 5_000 });
  assert.equal(await pressed(), "Off", "the panel shows the primary clip's");
  await level("Strong").click();
  await mixed.waitFor({ state: "hidden", timeout: 5_000 });
  await savedSoon(() => saved().deflicker === "strong" && saved(other).deflicker === "strong", "Strong is set on both clips");
  await page.locator('[data-reset-group="light"]').click();
  assert.equal(await pressed(), "Off");
  await savedSoon(() => !("deflicker" in saved()) && !("deflicker" in saved(other)), "the Light group's Reset turns it off");

  // Cloudflare: the picker lists the day whose clips are there and not here; its clips come back one at a time, into
  // their own day, with the grade they had, and nothing in the list or the bar moves as they do.
  const picker = page.locator("#shoot");
  const option = picker.locator(`option[value="cloud:${cloudDay}"]`);
  await option.waitFor({ state: "attached", timeout: 10_000 });
  assert.equal(await option.textContent(), `${cloudDay} · 227 clips`);
  assert.equal(await option.evaluate((el) => el.parentElement.label), "Cloudflare");
  await picker.selectOption(`cloud:${cloudDay}`);
  const cloudRow = (file) => page.locator(`.cloud-clip[data-stem="${file.replace(/\.MP4$/, "")}"]`);
  const copy = (file, what) => cloudRow(file).locator(`[data-what="${what}"] button`);
  await copy(gone, "original").waitFor({ timeout: 10_000 });
  assert.equal(await page.locator(".cloud-clip").count(), 227);
  assert.equal(await page.locator("#cloud-count").textContent(), "227 not here");
  assert.equal(await page.locator("#cloud-graded").textContent(), "1 · 1 KB");
  assert.ok(await page.locator("#clip-list").isHidden(), "the clip list makes way");
  assert.ok(await page.locator("#export").isDisabled(), "nothing here to export");
  assert.equal(await cloudRow(gone).locator(".when").textContent(), "10:01 · transcript");
  // Where things are, the rows from the top of their list, however it's scrolled.
  const cloudPlaces = () =>
    page.evaluate(() => {
      const list = document.getElementById("cloud-list").getBoundingClientRect();
      return [...document.querySelectorAll("#cloud-head > *, .cloud-clip, .cloud-file button, #export, #shoot, .frame")].map((el) => {
        const { x, y, width, height } = el.getBoundingClientRect();
        return [el.id || el.className, x, el.closest("#cloud-list") ? y - list.y : y, width, height].join(" ");
      });
    });
  const unmoved = async (what) => {
    const now = await cloudPlaces();
    assert.deepEqual(now.filter((at, i) => at !== before[i]), [], `${what} moves nothing`);
  };
  const before = await cloudPlaces();
  // Every label fits, at the widths the bin has, however much there is to bring.
  for (const width of [1000, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    const cut = await page.evaluate(() => {
      const size = document.getElementById("cloud-original");
      const { textContent } = size;
      size.textContent = "227 · 118.0 GB";
      const labels = document.querySelectorAll("#cloud-head span, #cloud-head button, #cloud-head output, .cloud-file *");
      const over = [...labels].filter((el) => el.offsetHeight > 24 || (el.clientWidth && el.scrollWidth > el.clientWidth));
      const texts = over.map((el) => el.textContent);
      size.textContent = textContent;
      return texts;
    });
    assert.deepEqual(cut, [], `nothing is cut at ${width} px`);
  }
  if (shots) await page.screenshot({ path: path.join(shots, "grade-6-cloud.png") });

  // One that stalls, and one waiting behind it: the share, then stopped, and nothing of either kept.
  await copy(partial, "original").click();
  await copy(partial, "original").getByText("42%").waitFor({ timeout: 10_000 });
  await copy(missing, "original").click();
  await copy(missing, "original").getByText("Queued").waitFor({ timeout: 5_000 });
  await page.getByText(/^Bringing 1 of 2 · 0102 · 420 KB of 1\.0 MB/).waitFor({ timeout: 5_000 });
  await unmoved("a clip coming");
  if (shots) await page.screenshot({ path: path.join(shots, "grade-7-bringing.png") });
  await page.getByRole("button", { name: "Stop bringing" }).click();
  await copy(partial, "original").getByText("Bring", { exact: true }).waitFor({ timeout: 5_000 });
  await copy(missing, "original").getByText("Bring", { exact: true }).waitFor({ timeout: 5_000 });
  assert.ok(await page.getByRole("button", { name: "Stop bringing" }).isHidden());
  await unmoved("stopping");
  assert.deepEqual(readdirSync(original).sort(), [other, name].sort(), "a stopped clip leaves nothing");

  // One that comes: it's the clip it was, in its own day, and its grade still applies.
  await copy(gone, "original").click();
  await copy(gone, "original").getByText("Grade", { exact: true }).waitFor({ timeout: 10_000 });
  assert.deepEqual(readFileSync(path.join(original, gone)), readFileSync(path.join(original, name)));
  assert.equal(await page.locator("#cloud-count").textContent(), "227 not here", "its graded copy isn't here yet");
  await page.locator("#bring-graded").click();
  await copy(gone, "graded").getByText("Here", { exact: true }).waitFor({ timeout: 10_000 });
  assert.equal(await page.locator("#cloud-count").textContent(), "226 not here");
  assert.equal(await page.locator("#cloud-graded").textContent(), "All here");
  assert.equal(readFileSync(path.join(exported, gone.replace(".MP4", ".mp4")), "utf8"), "a graded copy");
  await unmoved("a clip come");
  const keptNow = () => page.evaluate(async () => (await (await fetch("/api/offload/keep")).json()).clips);
  assert.deepEqual(await keptNow(), [gone, gone.replace(".MP4", ".mp4")].sort(), "what's brought back is kept out of offload");
  await copy(gone, "original").click();
  const broughtRow = page.locator(`.clip[data-name="${gone}"]`);
  await broughtRow.waitFor({ timeout: 10_000 });
  assert.equal(await picker.inputValue(), `mac:${cloudDay}`);
  assert.equal(await broughtRow.getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#n-exposure").inputValue(), "+0.40", "its grade applies");
  assert.ok(await page.locator("#cloud-list").isHidden(), "the clip list is back");
  if (shots) await page.screenshot({ path: path.join(shots, "grade-8-brought.png") });

  // Another comes to the day that's open: it joins the list, and the clip on screen stays as it is.
  const shown = await page.locator("#video").evaluate((el) => el.src);
  await page.evaluate((clip) => fetch("/api/bring", { method: "POST", headers: { "X-Grade": "1" }, body: JSON.stringify({ what: "original", names: [clip] }) }), second);
  await page.locator(`.clip[data-name="${second}"]`).waitFor({ timeout: 15_000 });
  assert.deepEqual(await page.locator("#clip-list .clip").evaluateAll((all) => all.map((el) => el.dataset.name)), [gone, second]);
  assert.equal(await broughtRow.getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#video").evaluate((el) => el.src), shown, "the clip on screen stays");

  // A clip the address asks for, as the Footage tab's Grade does: one that's only in Cloudflare opens its day there.
  await page.evaluate((clip) => {
    location.hash = `clip=${encodeURIComponent(clip)}`;
  }, missing);
  await page.locator(`.cloud-clip[aria-current="true"][data-stem="${missing.replace(".MP4", "")}"]`).waitFor({ timeout: 10_000 });
  assert.equal(await picker.inputValue(), `cloud:${cloudDay}`);
  assert.ok(await cloudRow(missing).evaluate((el) => {
    const { top, bottom } = el.getBoundingClientRect();
    return top > 0 && bottom < window.innerHeight;
  }), "and shows it");
  cloud.down = true;
  await page.locator("#cloud-refresh").click();
  await page.getByText(/^Couldn't read the Cloudflare archive/).first().waitFor({ timeout: 10_000 });
  assert.ok((await page.locator(".cloud-clip").count()) >= 225, "the day stays as last read");
  if (shots) await page.screenshot({ path: path.join(shots, "grade-9-cloud-away.png") });
  cloud.down = false;

  // Framed by the composer, the app says how far its offload and its export are, and lets go of both once they end or it
  // can't tell. The work itself is stood in for: nothing is offloaded.
  const composer = await browser.newPage({ permissions: ["local-network-access"] });
  composer.on("pageerror", (e) => errors.push(e.message));
  await composer.route("http://127.0.0.1:4321/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><script>
        window.heard = [];
        addEventListener("message", (e) => e.origin === "http://127.0.0.1:${port}" && heard.push(e.data));
      </script><iframe src="http://127.0.0.1:${port}/" allow="local-network-access"></iframe>`,
    }),
  );
  let work = {};
  await composer.route("**/api/jobs", async (route) => {
    if (!work) return route.fulfill({ status: 500, json: { error: "gone" } });
    const jobs = await (await route.fetch()).json();
    return route.fulfill({ json: { ...jobs, ...work, export: { ...jobs.export, ...work.export } } });
  });
  const says = (what, offload, exported) =>
    composer
      .waitForFunction(
        (wanted) => JSON.stringify(window.heard.findLast((said) => said.type === "grade-progress")) === wanted,
        JSON.stringify({ type: "grade-progress", offload, export: exported }),
        { timeout: 10_000 },
      )
      .catch(async (e) => assert.fail(`${what}: ${e.message}; heard ${await composer.evaluate(() => JSON.stringify(window.heard.at(-1)))}`));
  const offload = (change) => ({
    running: true, sentBytes: 430, speed: null, waiting: null, finished: null, error: null,
    copy: { on: true, mode: "on", total: 1, bytes: 1000, done: 0, doneBytes: 0, current: null, waiting: null, skipped: [] },
    send: { on: true, mode: "on", total: 1, bytes: 1000, done: 0, doneBytes: 0, current: [], waiting: null, skipped: [] },
    exports: { on: false, mode: "off", total: 0, bytes: 0, done: 0, doneBytes: 0, current: [], waiting: null, skipped: [], sentBytes: 0 },
    ...change,
  });
  await composer.goto("http://127.0.0.1:4321/");
  await composer.waitForFunction(() => window.heard[0]?.type === "grade-ready");
  await says("nothing going", null, null);
  work = { export: { current: { id: "original", name, progress: 0.07 } } };
  await says("an export", null, 0.07);
  work = { ...work, offload: offload() };
  await says("an offload too", 0.43, 0.07);
  work = { offload: offload({ sentBytes: 1001 }) };
  await says("an offload that resent a part", 1, null);
  work = { offload: offload({ sentBytes: 0, send: { ...offload().send, total: 0, bytes: 0 } }) };
  await says("an offload with nothing to send", null, null);
  work = { offload: offload({ send: { ...offload().send, on: false, mode: "off" } }) };
  await says("only the camera being copied", null, null);
  work = { offload: offload({ exports: { ...offload().exports, on: true, mode: "on", bytes: 1000, sentBytes: 70 } }) };
  await says("the exports going up as well", 0.25, null);
  work = { offload: offload() };
  await says("an offload again", 0.43, null);
  work = { offload: offload({ running: false, error: "The camera was unplugged" }) };
  await says("an offload that failed", null, null);
  work = { offload: offload() };
  await says("an offload once more", 0.43, null);
  work = null;
  await says("the app's server gone", null, null);

  // A run of switches, stood in for: each says how it's going in its own room, stops in two steps, and moves nothing.
  {
    const menu = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    menu.on("pageerror", (e) => errors.push(e.message));
    let run = null;
    let keptDays = [];
    let keptClips = ["DJI_1.MP4", "DJI_1.mp4"];
    const asked = [];
    /** How the run is once the next thing is asked for. */
    let next = null;
    const info = () => ({
      camera: { mounted: true, clips: 12, bytes: 3.2e9 },
      mac: { clips: 4, bytes: 1.1e9, sent: 0 },
      exports: { clips: 2, bytes: 5e8, sent: 0 },
      transcripts: { toSend: 2 },
      kept: { days: keptDays, clips: keptClips, count: keptDays.length * 227 + keptClips.length },
      days: [{ day: "2026-11-18", clips: 12, bytes: 3.2e9 }, { day: "2026-11-08", clips: 227, bytes: 7e10 }].map((d) => ({ ...d, kept: keptDays.includes(d.day), keptClips: d.day === "2026-11-18" ? keptClips : [] })),
      room: { free: 12e9, keepFree: 5e9 },
      clearCardAfter: "copied",
      run,
    });
    const lane = (change = {}) => ({ on: true, mode: "on", total: 12, bytes: 3.2e9, done: 3, doneBytes: 8e8, current: [], waiting: null, skipped: [], finished: null, error: null, ...change });
    const off = lane({ on: false, mode: "off", total: 0, bytes: 0, done: 0, doneBytes: 0 });
    const going = (change = {}) => ({
      running: true, unattended: false, youtube: true, clearCardAfter: "copied", paused: null, waiting: null, speed: 250_000, sentBytes: 4e8, finished: null, error: null,
      transcripts: { sent: 0, error: null }, freed: { camera: 0, mac: 0, exports: 0 },
      copy: lane({ current: null, onCamera: 0 }), send: lane({ total: 16, bytes: 4.3e9 }), exports: { ...off, sentBytes: 0 },
      ...change,
    });
    await menu.route("**/api/jobs", async (route) => route.fulfill({ json: { ...(await (await route.fetch()).json()), offload: run } }));
    await menu.route(/\/api\/offload(\/\w+)?$/, async (route) => {
      const request = route.request();
      const what = new URL(request.url()).pathname.replace("/api/offload", "");
      if (request.method() === "POST") {
        asked.push([what, request.postDataJSON()]);
        run = next ?? run;
        next = null;
      }
      if (request.method() === "POST" && what === "/keep") ({ days: keptDays = keptDays, clips: keptClips = keptClips } = request.postDataJSON());
      await route.fulfill({ json: info() });
    });
    await menu.goto(`http://127.0.0.1:${port}/`);
    await menu.locator(".clip").first().waitFor({ timeout: 30_000 });
    await menu.getByRole("button", { name: "More ways to export" }).click();
    const said = (id) => menu.locator(`#offload-${id}`);
    const saysNow = (id, text) =>
      menu
        .waitForFunction(([i, t]) => document.getElementById(`offload-${i}`).textContent === t, [id, text], { timeout: 5_000 })
        .catch(async () => assert.fail(`${id} says “${await said(id).textContent()}”, not “${text}”`));
    await saysNow("camera", "12 clips · 3.2 GB");
    await saysNow("mac", "4 clips · 1.1 GB to send");
    await saysNow("exports", "2 clips · 500 MB to send");
    const spots = () =>
      menu.evaluate(() =>
        [...document.querySelectorAll("#export-menu, #export-menu .lane, #export-menu .lane button, #export-menu .menu-row, #export-menu label, #export, #export-more, #footage-link")].map((el) => {
          const { x, y, width, height } = el.getBoundingClientRect();
          return [el.id || el.className, x, y, width, height];
        }),
      );
    const still = await spots();
    if (shots) await menu.screenshot({ path: path.join(shots, "grade-10-offload.png") });

    // Each starts on its own, told whether to go on with the tab closed.
    await menu.getByRole("checkbox", { name: "Keep going when this tab is closed" }).check();
    next = going({ send: { ...off }, unattended: true });
    await menu.getByRole("button", { name: "Start Camera → Mac" }).click();
    await saysNow("camera", "3 of 12 · 800 MB of 3.2 GB");
    assert.deepEqual(asked.splice(0), [["", { lanes: ["copy"], unattended: true }]]);
    await saysNow("mac", "4 clips · 1.1 GB to send");
    next = going({ unattended: true });
    await menu.getByRole("button", { name: "Start Mac → Cloudflare" }).click();
    await saysNow("mac", "3 of 16 · 400 MB of 4.3 GB");
    assert.deepEqual(asked.splice(0), [["", { lanes: ["send"] }]]);
    next = going({ unattended: false });
    await menu.getByRole("checkbox", { name: "Keep going when this tab is closed" }).uncheck();
    assert.deepEqual(asked.splice(0), [["", { lanes: [], unattended: false }]]);

    // What each waits for.
    const until = new Date(Date.now() + 60_000).toISOString();
    run = going({ copy: lane({ current: null, onCamera: 0, waiting: { for: "camera", why: "x", until } }), send: lane({ waiting: { for: "page", why: "No Grade page is open" } }), paused: { for: "page" } });
    await menu.waitForFunction(() => /^Camera unplugged, tries again \d/.test(document.getElementById("offload-camera").textContent), null, { timeout: 5_000 });
    await menu.waitForFunction(() => /^Paused while no Grade page was open/.test(document.getElementById("offload-mac").textContent), null, { timeout: 5_000 });
    run = going({ copy: lane({ current: null, onCamera: 0, waiting: { for: "room", why: "x" } }), send: lane({ waiting: { for: "network", why: "fetch failed", until } }) });
    await menu.waitForFunction(() => /^Waiting for room/.test(document.getElementById("offload-camera").textContent), null, { timeout: 5_000 });
    await menu.waitForFunction(() => /^Can't reach Cloudflare, tries again \d/.test(document.getElementById("offload-mac").textContent), null, { timeout: 5_000 });
    if (shots) await menu.screenshot({ path: path.join(shots, "grade-11-offload-waiting.png") });

    // Stopping: the files in flight are finished, or cut on a second click; which of the two is said.
    next = going({ copy: lane({ current: { name: "a", sent: 1, size: 2 }, onCamera: 0, mode: "finishing" }), send: lane({ current: [{ sent: 0 }, { sent: 0 }] }) });
    await menu.getByRole("button", { name: "Stop Camera → Mac", exact: true }).click();
    assert.deepEqual(asked.splice(0), [["/stop", { lanes: ["copy"] }]]);
    await menu.waitForFunction(() => document.getElementById("offload-camera").textContent.startsWith("Finishing the clip being copied"), null, { timeout: 5_000 });
    await menu.getByRole("button", { name: "Stop now Camera → Mac" }).click();
    await menu.waitForTimeout(300);
    assert.deepEqual(asked.splice(0), [["/stop", { lanes: ["copy"] }]]);
    const stop = menu.locator("#stop-offload");
    assert.equal(await stop.textContent(), "Stop offloading");
    const stopSpot = await stop.boundingBox();
    run = going({ copy: lane({ current: null, onCamera: 0, mode: "stopping" }), send: lane({ mode: "finishing", current: [{ sent: 0 }, { sent: 0 }] }) });
    await menu.waitForFunction(() => document.getElementById("stop-offload").textContent === "Stop now", null, { timeout: 5_000 });
    await menu.waitForFunction(() => document.getElementById("offload-mac").textContent.startsWith("Finishing 2 uploads"), null, { timeout: 5_000 });
    assert.deepEqual(await stop.boundingBox(), stopSpot, "the bar's Stop keeps its place, whatever it says");
    assert.deepEqual(await spots(), still, "nothing in the menu or the bar moves, whatever the offload says");
    await stop.click();
    await menu.waitForTimeout(300);
    assert.deepEqual(asked.splice(0), [["/stop", {}]]);
    await menu.getByRole("button", { name: "More ways to export" }).click();

    // Done, with a clip passed over, and the next run asks again whether it goes on alone.
    run = going({ running: false, finished: "done", copy: { ...off, current: null, onCamera: 0 }, send: { ...off, skipped: [{ name: "DJI_1.MP4", why: "doesn't read back" }] } });
    await saysNow("mac", "1 clip passed over: doesn't read back");
    await menu.getByText("Offload: 1 clip passed over, DJI_1.MP4: doesn't read back").waitFor({ timeout: 5_000 });
    assert.ok(await stop.isHidden());
    assert.ok(!(await menu.getByRole("checkbox", { name: "Keep going when this tab is closed" }).isChecked()));

    // A whole day kept, and a day whose brought clips are: a click lets those go.
    await menu.getByRole("checkbox", { name: /2026-11-08/ }).click();
    await saysNow("kept", "229 clips");
    assert.deepEqual(asked.splice(0), [["/keep", { days: ["2026-11-08"] }]]);
    const brought = menu.getByRole("checkbox", { name: /2026-11-18/ });
    assert.ok(await brought.evaluate((el) => el.indeterminate));
    await menu.getByText("2 clips kept").waitFor({ timeout: 5_000 });
    await brought.click();
    await saysNow("kept", "227 clips");
    assert.deepEqual(asked.splice(0), [["/keep", { days: ["2026-11-08"], clips: [] }]]);
    assert.ok(!(await brought.evaluate((el) => el.indeterminate || el.checked)));
    if (shots) await menu.screenshot({ path: path.join(shots, "grade-12-offload-kept.png") });
  }

  assert.deepEqual(errors, []);
  console.log("grade check passed");
} finally {
  await browser.close();
  server.kill();
  archive.closeAllConnections();
  archive.close();
  rmSync(root, { recursive: true, force: true });
}
