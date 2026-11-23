// Graded preview copies in a film, so OpenFilm's own preview plays its camera clips graded while the film is cut.
//
// Each camera clip a film uses gets the grade app's preview copy (1920 px on its long side) cloned in under the clip's
// own name, so film.html, its trims and its captions stay as they are. The file that was there (the full graded export
// the film was cut from) moves beside it into `.originals/` and is never deleted. `.originals/previews.json` records
// which preview each copy is, by the app's key, so a clip graded again since is told apart and its copy made again.
// The Chinese version in `zh/` has its own assets, and gets the same.
import { existsSync } from "node:fs";
import { link, mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { isCameraClip, readFilm } from "./film.mjs";
import { SETTLED, inCloudflare, waitUntil } from "./grade.mjs";
import { clone, statOf } from "./media.mjs";

export const ORIGINALS = ".originals";
const RECORD = "assets/.originals/previews.json";

/** The camera clips a project's film.html names, by their path in it (`assets/DJI_….mp4`), once each. */
async function cameraClips(project) {
  const { clips } = readFilm(await readFile(join(project, "film.html"), "utf8"));
  return [...new Set(clips.filter((clip) => isCameraClip(clip.path)).map((clip) => clip.path))];
}

/**
 * The film and its Chinese version (when it has one), the camera clips each uses (`uses`, by project), and those
 * clips' names as the grade app knows them, once each.
 */
async function filmClips(film) {
  const projects = [film, join(film, "zh")].filter((dir) => existsSync(join(dir, "film.html")));
  if (!projects.length) throw new Error(`${film} has no film.html`);
  const uses = new Map(await Promise.all(projects.map(async (p) => [p, await cameraClips(p)])));
  const names = [...new Set([...uses.values()].flat().map((path) => basename(path)))].sort();
  return { projects, uses, names };
}

async function readRecord(project) {
  try {
    return JSON.parse(await readFile(join(project, RECORD), "utf8"));
  } catch {
    return {};
  }
}

async function writeRecord(project, record) {
  await mkdir(dirname(join(project, RECORD)), { recursive: true });
  await writeFile(join(project, RECORD), `${JSON.stringify(record, null, 2)}\n`);
}

/** The preview a clip's file in the film is, by the record, or null when it isn't one (an original, or a file put there since). */
async function placed(project, path, record) {
  const now = await statOf(join(project, path));
  const was = record[path];
  return now && was && now.size === was.size && Math.round(now.mtimeMs) === was.mtimeMs ? was : null;
}

/**
 * Puts the preview at `from` (the app's copy, with its `key`) in place of the project's `path`. A file there that
 * isn't a preview is moved into `.originals/` first, hard-linked there and then replaced in one step, so the film is
 * never without the clip; one already in `.originals/` by that name is kept too, under the time it was moved aside.
 * Transcripts current with the old file are made current with the new one, which has the same sound and times.
 * `label` is the project's place in the film ("" or "zh/"), for saying what was moved.
 */
async function place(project, path, { path: from, key }, record, { label, log }) {
  const abs = join(project, path);
  const now = await statOf(abs);
  const ours = await placed(project, path, record);
  const moved = [];
  const temp = join(dirname(abs), `.${basename(abs)}.preview-${process.pid}`);
  await mkdir(dirname(abs), { recursive: true });
  await rm(temp, { force: true });
  await clone(from, temp);
  if (now && !ours) {
    const originals = join(dirname(abs), ORIGINALS);
    await mkdir(originals, { recursive: true });
    const original = join(originals, basename(abs));
    if (await statOf(original)) {
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
      const aside = join(originals, `${basename(abs, extname(abs))}.${stamp}${extname(abs)}`);
      await rename(original, aside);
      moved.push(`${label}${join(dirname(path), ORIGINALS, basename(aside))} (the one there before)`);
    }
    try {
      await link(abs, original);
    } catch {
      await rename(abs, original);
    }
    moved.push(`${label}${join(dirname(path), ORIGINALS, basename(abs))}`);
  }
  await rename(temp, abs);
  const after = await stat(abs);
  if (now) {
    const stem = basename(abs, extname(abs));
    for (const name of await readdir(dirname(abs))) {
      if (!name.startsWith(`${stem}.`) || !name.endsWith(".vtt")) continue;
      const words = join(dirname(abs), name);
      const at = await stat(words);
      if (at.mtimeMs >= now.mtimeMs && at.mtimeMs < after.mtimeMs) await utimes(words, at.atime, after.mtime);
    }
  }
  record[path] = { key: key ?? null, size: after.size, mtimeMs: Math.round(after.mtimeMs) };
  if (moved.length) log(`${label}${path}: the original is kept in ${moved.join(" and ")}`);
}

/**
 * Asks the grade app for previews of every camera clip the film and its Chinese version use, waits for them, and
 * clones each in that isn't current. Says what it placed, kept and couldn't get; `failed` and `missing` are clips
 * it couldn't get, the latter only in Cloudflare.
 */
export async function makePreviews(film, { grade, log = console.log, every = 1000 }) {
  const { projects, uses, names } = await filmClips(film);
  if (!names.length) {
    log("The film uses no camera clips.");
    return { placed: [], current: [], failed: [], missing: [] };
  }
  await grade.askPreviews(names);
  log(`Asked the grade app for previews of ${names.length} clip${names.length > 1 ? "s" : ""}.`);
  let said = "";
  const states = await waitUntil(
    () => grade.previews(names),
    (answer) => names.every((name) => SETTLED.has(answer[name]?.state)),
    {
      every,
      heard: (answer) => {
        const waiting = names.filter((name) => !SETTLED.has(answer[name]?.state));
        const line = waiting.length ? `Waiting for ${waiting.length} preview${waiting.length > 1 ? "s" : ""}…` : "";
        if (line && line !== said) log(line);
        said = line;
      },
    },
  );
  const result = { placed: [], current: [], failed: [], missing: [] };
  for (const project of projects) {
    const record = await readRecord(project);
    const label = project === film ? "" : "zh/";
    let changed = false;
    for (const path of uses.get(project)) {
      const state = states[basename(path)];
      if (state.state !== "ready") continue;
      const ours = await placed(project, path, record);
      if (ours && ours.key === state.key) {
        result.current.push(`${label}${path}`);
        continue;
      }
      await place(project, path, state, record, { label, log });
      result.placed.push(`${label}${path}`);
      changed = true;
    }
    if (changed) await writeRecord(project, record);
  }
  for (const name of names) {
    if (states[name].state === "failed") result.failed.push({ name, error: states[name].error ?? "no reason given" });
    if (states[name].state === "missing") result.missing.push(name);
  }
  if (result.placed.length) log(`Preview copies in place: ${result.placed.join(", ")}.`);
  if (result.current.length) log(`Already current: ${result.current.length}.`);
  for (const { name, error } of result.failed) log(`${name}: the grade app couldn't make its preview: ${error}`);
  if (result.missing.length) log(inCloudflare(result.missing));
  return result;
}

/**
 * How each camera clip of the film stands: `[{ project, path, state, detail }]`, `state` one of
 * current, outdated (a newer preview is ready), stale (graded again since; its preview isn't made yet), making,
 * original (no preview in the film yet), missing (no file in the film), cloudflare (the app has it only there), failed,
 * unknown (the app can't be asked).
 */
export async function filmStatus(film, { grade }) {
  const { projects, uses, names } = await filmClips(film);
  let states = {};
  let unreachable = null;
  if (names.length)
    try {
      states = await grade.previews(names);
    } catch (error) {
      unreachable = error.message;
    }
  const rows = [];
  for (const project of projects) {
    const record = await readRecord(project);
    for (const path of uses.get(project)) {
      const there = Boolean(await statOf(join(project, path)));
      const ours = await placed(project, path, record);
      const standing = standingOf({ name: basename(path), there, ours, app: states[basename(path)], unreachable });
      rows.push({ project: project === film ? "" : "zh", path, ...standing });
    }
  }
  return { rows, unreachable };
}

/** How one clip of a film stands, from its file (`there`), the preview it is (`ours`) and the app's preview (`app`). */
function standingOf({ name, there, ours, app, unreachable }) {
  if (!there) return { state: "missing", detail: "no such file in the film" };
  if (app?.state === "missing") return { state: "cloudflare", detail: inCloudflare([name]) };
  if (!ours) return { state: "original", detail: "not a preview copy yet: film previews" };
  if (unreachable) return { state: "unknown", detail: "preview copy; the grade app can't be asked" };
  switch (app?.state) {
    case "ready":
      return app.key === ours.key
        ? { state: "current", detail: "preview copy, current" }
        : { state: "outdated", detail: "graded again since: film previews" };
    case "stale":
      return { state: "stale", detail: "graded again since: film previews" };
    case "failed":
      return { state: "failed", detail: `its preview failed: ${app.error}` };
    default:
      return { state: "making", detail: "its new preview is being made" };
  }
}
