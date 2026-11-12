import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const videos = path.join(root, "Videos");
const original = path.join(videos, "Original");
const exported = path.join(videos, "Exported");
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

const server = spawn(process.execPath, ["scripts/grade/server.mjs"], {
  env: { ...process.env, GRADE_ROOT: videos, GRADE_DATA: data, GRADE_CACHE: path.join(root, "cache"), GRADE_CAMERA: path.join(root, "no-camera"), GRADE_PORT: String(port) },
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
    "-hide_banner", "-loglevel", "error", "-ss", "1", "-i", path.join(videos, record().file), "-frames:v", "1",
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
  assert.deepEqual(errors, []);
  console.log("grade check passed");
} finally {
  await browser.close();
  server.kill();
  rmSync(root, { recursive: true, force: true });
}
