import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const shoot = path.join(root, "2026-01-01");
const name = "DJI_20260101120000_0001_D.MP4";
mkdirSync(path.join(shoot, "originals"), { recursive: true });
mkdirSync(path.join(root, "luts"), { recursive: true });

// A static field: red across, green down, blue constant, as D-Log2 code values.
execFileSync(ffmpeg, [
  "-hide_banner", "-loglevel", "error", "-y",
  "-f", "lavfi", "-i", "color=c=black:s=640x360:r=24:d=2,format=rgb24,geq=r='40+X/W*180':g='40+Y/H*180':b='110'",
  "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
  "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "8", "-colorspace", "bt709", "-color_range", "tv",
  "-c:a", "aac", "-metadata", "com.dji.camera.ColorGammaSxS=D-Log2", "-metadata", "com.dji.camera.WhiteBalanceKelvin=5600",
  "-movflags", "use_metadata_tags", path.join(shoot, "originals", name),
]);

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
writeFileSync(path.join(root, "luts/dlog2-to-rec709-aces2.cube"), writeCube(size, base, "check base"));

const server = spawn(process.execPath, ["scripts/grade/server.mjs"], {
  env: { ...process.env, GRADE_ROOT: root, GRADE_LUTS: path.join(root, "luts"), GRADE_CAMERA: path.join(root, "no-camera"), GRADE_PORT: String(port) },
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
  await row.getByText("not exported").waitFor({ timeout: 30_000 });
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
  await page.getByText("+0.75 EV").waitFor();
  await page.waitForTimeout(1500);
  if (shots) await page.screenshot({ path: path.join(shots, "grade-2-graded.png") });

  // The preview's own pixels, at the proxy's size.
  const preview = await page.evaluate(() => {
    const c = document.getElementById("canvas");
    const t = document.createElement("canvas");
    t.width = c.width;
    t.height = c.height;
    const ctx = t.getContext("2d");
    ctx.drawImage(c, 0, 0);
    return { w: c.width, h: c.height, px: Array.from(ctx.getImageData(0, 0, c.width, c.height).data) };
  });
  assert.equal(preview.w, 1280, "proxy is 1280 wide");

  const grades = JSON.parse(readFileSync(path.join(shoot, "grades.json"), "utf8"));
  assert.equal(grades.clips[name].exposure, 0.75, "the grade is saved");

  await page.getByRole("button", { name: "Export this clip" }).click();
  await row.getByText("exported", { exact: true }).waitFor({ timeout: 120_000 });
  if (shots) await page.screenshot({ path: path.join(shots, "grade-3-exported.png") });

  const sidecar = JSON.parse(readFileSync(path.join(shoot, "graded", "DJI_20260101120000_0001_D.grade.json"), "utf8"));
  assert.equal(sidecar.key, gradeKey(sidecar.grade), "the sidecar's key matches its grade");
  assert.equal(sidecar.grade.kelvin, 4800);
  assert.ok(existsSync(path.join(shoot, sidecar.lut)), "the exported LUT is kept");

  const frame = execFileSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-ss", "1", "-i", path.join(shoot, sidecar.graded), "-frames:v", "1",
    // accurate_rnd: swscale's default 8-bit YUV→RGB path reads limited range about 2 levels low.
    "-vf", `scale=${preview.w}:${preview.h}:in_color_matrix=bt709:in_range=tv:flags=accurate_rnd+full_chroma_int,format=rgb24`, "-f", "rawvideo", "-",
  ], { maxBuffer: 64 * 1024 * 1024 });
  // Compare 8×8 patch means on a grid away from the edges. Where a channel clips steeply, chroma resampling moves
  // the edge a pixel, so the check holds the mean and the 95th percentile, not the single worst patch.
  const diffs = [];
  for (let y = 24; y < preview.h - 24; y += 24)
    for (let x = 24; x < preview.w - 24; x += 24)
      for (let k = 0; k < 3; k++) {
        let a = 0;
        let b = 0;
        for (let dy = 0; dy < 8; dy++)
          for (let dx = 0; dx < 8; dx++) {
            a += preview.px[((y + dy) * preview.w + x + dx) * 4 + k];
            b += frame[((y + dy) * preview.w + x + dx) * 3 + k];
          }
        diffs.push(Math.abs(a - b) / 64);
      }
  diffs.sort((a, b) => a - b);
  const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length;
  const p95 = diffs[Math.floor(diffs.length * 0.95)];
  console.log(`preview vs export over ${diffs.length} patch channels: mean ${mean.toFixed(2)}, 95% within ${p95.toFixed(2)}, worst ${diffs.at(-1).toFixed(2)} of 255`);
  assert.ok(mean <= 1.5 && p95 <= 4, "the preview matches the export");
  assert.deepEqual(errors, []);
  console.log("grade check passed");
} finally {
  await browser.close();
  server.kill();
  rmSync(root, { recursive: true, force: true });
}
