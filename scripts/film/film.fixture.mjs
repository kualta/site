// What the film tests run against: tiny clips made with ffmpeg, a fake of the grade app's preview and trim routes,
// and a stand-in for `openfilm render` that records what it was given.
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import ffmpegStatic from "ffmpeg-static";

const exec = promisify(execFile);
export const FFMPEG = process.env.FFMPEG_PATH || ffmpegStatic;

/** A small clip with a picture and a tone, `seconds` long at `rate` (an ffmpeg rate, "30" or "60000/1001"). */
export async function makeClip(file, { seconds = 4, rate = "30", size = "64x36", sound = true } = {}) {
  await exec(FFMPEG, [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${size}:rate=${rate}:duration=${seconds}`,
    ...(sound ? ["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${seconds}`] : []),
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-g",
    "8",
    "-pix_fmt",
    "yuv420p",
    ...(sound ? ["-c:a", "aac", "-shortest"] : []),
    file,
  ]);
  return file;
}

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
const read = (req) =>
  new Promise((done) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => done(body ? JSON.parse(body) : {}));
  });

/**
 * The grade app's routes for films, over `originals` (a folder of camera clips by name): previews and trims are made
 * from them with ffmpeg, in `cache`. A preview is "queued" the first time it's asked about after being asked for, then
 * "ready"; `regrade(name)` makes its preview stale. `missing` names clips only in Cloudflare, `failing` clips whose
 * trims fail. Trims start on the first frame at or after the second asked (`rate` frames a second) and run to the end
 * asked, or the clip's. Every request is kept in `requests`.
 */
export async function fakeGradeApp({ originals, cache, rate = 30, missing = [], failing = [] }) {
  mkdirSync(cache, { recursive: true });
  const requests = [];
  const keys = new Map();
  const previews = new Map();
  const asks = new Map();
  let nextId = 1;
  const keyOf = (name) => keys.get(name) ?? 1;
  async function preview(name) {
    const path = join(cache, `${basename(name, extname(name))}.preview${keyOf(name)}.mp4`);
    await exec(FFMPEG, [
      "-v",
      "error",
      "-y",
      "-i",
      join(originals, name),
      "-c:v",
      "libx264",
      "-crf",
      "40",
      "-c:a",
      "copy",
      path,
    ]);
    return path;
  }
  async function trim(name, start, end, n) {
    if (missing.includes(name)) return { state: "missing", path: null, start, end, error: null };
    if (failing.includes(name))
      return { state: "failed", path: null, start, end, error: "the camera's card was unplugged" };
    const first = Math.ceil(start * rate - 1e-6);
    const actualStart = first / rate;
    const path = join(cache, `${basename(name, extname(name))}.trim${n}.mp4`);
    await exec(FFMPEG, [
      "-v",
      "error",
      "-y",
      "-i",
      join(originals, name),
      "-vf",
      `trim=start_frame=${first},setpts=PTS-STARTPTS`,
      "-af",
      `atrim=start=${actualStart},asetpts=PTS-STARTPTS`,
      "-t",
      String(end - actualStart),
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-c:a",
      "aac",
      path,
    ]);
    return { state: "ready", path, start, end, actualStart, actualEnd: end, error: null };
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const body = req.method === "POST" ? await read(req) : null;
    requests.push({ method: req.method, path: url.pathname, query: url.search, body, grade: req.headers["x-grade"] });
    if (req.method === "POST" && req.headers["x-grade"] !== "1") return json(res, 403, { error: "X-Grade: 1, please" });
    if (url.pathname === "/api/previews" && req.method === "POST") {
      for (const name of body.names) {
        const was = previews.get(name);
        if (missing.includes(name) || (was && was.key === keyOf(name))) continue;
        previews.set(name, { state: "queued", key: keyOf(name), path: await preview(name) });
      }
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/api/previews") {
      const out = {};
      for (const name of url.searchParams.get("names").split(",")) {
        const p = previews.get(name);
        if (missing.includes(name)) out[name] = { state: "missing", path: null, key: null, error: null };
        else if (!p) out[name] = { state: "stale", path: null, key: null, error: null };
        else if (p.key !== keyOf(name)) out[name] = { state: "stale", path: p.path, key: p.key, error: null };
        else {
          out[name] = { state: p.state, path: p.path, key: `k${p.key}`, error: null };
          p.state = "ready";
        }
      }
      return json(res, 200, out);
    }
    if (url.pathname === "/api/trims" && req.method === "POST") {
      const id = `t${nextId++}`;
      asks.set(id, { trims: body.trims, made: null, looks: 0 });
      return json(res, 200, { id });
    }
    if (url.pathname === "/api/trims") {
      const ask = asks.get(url.searchParams.get("id"));
      if (!ask) return json(res, 404, { error: "no such request" });
      // Asked about once while they're being made, then made.
      if (ask.looks++ === 0)
        return json(
          res,
          200,
          ask.trims.map(({ start, end }) => ({ state: "making", path: null, start, end })),
        );
      ask.made ??= await Promise.all(
        ask.trims.map(({ name, start, end }, i) => trim(name, start, end, `${url.searchParams.get("id")}-${i}`)),
      );
      return json(res, 200, ask.made);
    }
    json(res, 404, { error: "no such route" });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    regrade: (name) => keys.set(name, keyOf(name) + 1),
    close: () => new Promise((done) => server.close(done)),
  };
}

/**
 * A stand-in for `openfilm`: run as `[process.execPath, script]`, it writes what it was given (its arguments, where it
 * ran, and the film.html, files and transcripts there) to `record`, then writes its --out file, or fails with `exit`.
 */
export function fakeOpenfilm(dir, record, { exit = 0 } = {}) {
  const script = join(dir, "fake-openfilm.mjs");
  writeFileSync(
    script,
    `import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const walk = (dir, base = "") => readdirSync(join(dir, base), { withFileTypes: true }).flatMap((e) => {
  const path = base ? base + "/" + e.name : e.name;
  return e.isDirectory() ? walk(dir, path) : [path];
});
const args = process.argv.slice(2);
const files = walk(process.cwd()).sort();
const texts = Object.fromEntries(files.filter((f) => f.endsWith(".vtt")).map((f) => [f, readFileSync(f, "utf8")]));
const inodes = Object.fromEntries(files.map((f) => [f, statSync(f).ino]));
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args, cwd: process.cwd(), film: readFileSync("film.html", "utf8"), files, texts, inodes }));
if (${exit}) process.exit(${exit});
writeFileSync(args[args.indexOf("--out") + 1], "rendered");
`,
  );
  return [process.execPath, script];
}
