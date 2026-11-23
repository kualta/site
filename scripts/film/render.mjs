// Rendering a film from full-quality trims of its camera clips, while the film itself holds small preview copies.
//
// The grade app makes a graded trim of each stretch of a camera clip the film shows or plays (its uses joined, with a
// handle each side). A render copy of the film is put together elsewhere: the film's files cloned (no disk), each trim
// cloned in beside its clip as `<clip>-trim<k>`, film.html with those clips' sources pointed at their trims and their
// seconds moved to the trim's, and their words moved the same way. `openfilm render` runs there and writes its video
// where the film's own render goes, so the film's folder is never otherwise touched. A render that stops leaves the
// copy, and running again picks up its finished chunks.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, posix } from "node:path";
import { isCameraClip, moveFor, readFilm, seconds, stretches, trimName, writeSources } from "./film.mjs";
import { SETTLED, inCloudflare, waitUntil } from "./grade.mjs";
import { clone, fpsOf, probe, statOf } from "./media.mjs";
import { ORIGINALS } from "./previews.mjs";
import { moveVtt } from "./vtt.mjs";

export const OPENFILM = ["npx", "-y", "openfilm@latest"];
export const RENDERS = process.env.FILM_RENDERS || join(homedir(), "Library/Caches/Film/renders");
/** Files of a project a render copy needs from its `.film/`: the subtitles' look, linked media, the editor's rate. */
const TOOL_FILES = ["subtitles.json", "media-links.json", "settings.json"];
const VIDEO = /\.(mp4|mov|webm|m4v|mkv)$/i;

const span = (s) => `${s.start.toFixed(3)}–${s.end.toFixed(3)} s`;

/** Every file under `dir` by its path from it, `/` between folders; `skip(path, entry)` leaves a file or folder out. */
async function walk(dir, skip = () => false, base = "") {
  const out = [];
  for (const entry of await readdir(join(dir, base), { withFileTypes: true }).catch(() => [])) {
    const path = base ? `${base}/${entry.name}` : entry.name;
    if (skip(path, entry)) continue;
    if (entry.isDirectory()) out.push(...(await walk(dir, skip, path)));
    else out.push(path);
  }
  return out;
}

/** How long a camera clip runs, from its file in the film or the original kept beside it. */
async function lengthOf(project, path) {
  for (const file of [join(project, path), join(project, dirname(path), ORIGINALS, basename(path))])
    if (await statOf(file)) return (await probe(file)).duration;
  throw new Error(`${path} isn't in the film, so how long it runs can't be told`);
}

/** Asks the grade app for the trims and waits for all of them; any that fails, or is only in Cloudflare, stops it. */
async function getTrims(asks, { grade, log, every }) {
  const id = await grade.askTrims(asks.map(({ name, start, end }) => ({ name, start, end })));
  log(`Asked the grade app for ${asks.length} full-quality trim${asks.length > 1 ? "s" : ""} (request ${id}).`);
  let said = "";
  const bad = (t) => t?.state === "failed" || t?.state === "missing";
  const trims = await waitUntil(
    () => grade.trims(id),
    (list) => list.some(bad) || asks.every((_, i) => SETTLED.has(list[i]?.state)),
    {
      every,
      heard: (list) => {
        const ready = list.filter((t) => t?.state === "ready").length;
        const line = `Trims ready: ${ready} of ${asks.length}`;
        if (line !== said) log(line);
        said = line;
      },
    },
  );
  const missing = [...new Set(asks.filter((_, i) => trims[i]?.state === "missing").map((a) => a.name))];
  const failed = asks.flatMap((ask, i) =>
    trims[i]?.state === "failed" ? [`  ${ask.name} ${span(ask)}: ${trims[i].error ?? "no reason given"}`] : [],
  );
  if (missing.length || failed.length)
    throw new Error(
      [
        "Nothing was rendered: the grade app couldn't give every trim.",
        ...failed,
        ...(missing.length ? [inCloudflare(missing)] : []),
      ].join("\n"),
    );
  return trims;
}

/**
 * Renders `film` (its Chinese version in zh/ with `zh`) from graded trims of its camera clips, to `<film>/<name>.mp4`
 * (or `<name>-zh.mp4`) as `openfilm render` would. `args` go to `openfilm render` as they are. The frame rate is the
 * one `--fps` gives, else the one Studio's settings for the film give, else its main footage's; and a frame smaller
 * than that footage, of the same shape, is drawn at the footage's size.
 */
export async function renderFilm(
  film,
  {
    zh = false,
    args = [],
    grade,
    openfilm = OPENFILM,
    renders = RENDERS,
    log = console.log,
    every = 2000,
    output = "inherit",
  },
) {
  const name = basename(film);
  const project = zh ? join(film, "zh") : film;
  if (!existsSync(join(project, "film.html"))) throw new Error(`${project} has no film.html`);
  const refused = args.find((arg) => /^--out(=|$)/.test(arg) || /^[\d.]+-[\d.]+$/.test(arg));
  if (refused) throw new Error(`${refused}: a render here is the whole film, to the film's folder`);
  const out = join(film, zh ? `${name}-zh.mp4` : `${name}.mp4`);
  const text = await readFile(join(project, "film.html"), "utf8");
  const { stage, clips, pages } = readFilm(text);
  for (const page of pages)
    if (/(^|\/)film\.html$/.test(page))
      log(`${page} is a film within the film: its camera clips are drawn from what's in its assets, not from trims.`);

  // The trims: each camera clip's stretches the film shows or plays.
  const byClip = new Map();
  for (const clip of clips.filter((c) => c.used && isCameraClip(c.path)))
    byClip.set(clip.path, [...(byClip.get(clip.path) ?? []), clip]);
  const asks = [];
  for (const [path, uses] of byClip) {
    const open = uses.some((use) => use.time?.out == null);
    const length = open ? await lengthOf(project, path) : Number.POSITIVE_INFINITY;
    for (const [i, s] of stretches(uses, length).entries())
      asks.push({ path, name: basename(path), k: i + 1, length, ...s });
  }
  if (!asks.length) log("The film uses no camera clips: it renders as it is.");
  const trims = asks.length ? await getTrims(asks, { grade, log, every }) : [];

  // Each trim as the render copy has it, and each clip's source in it.
  const files = new Map();
  const changes = new Map();
  let main = null;
  for (const [i, ask] of asks.entries()) {
    const trim = trims[i];
    const facts = await probe(trim.path);
    const at = { first: facts.first, actualStart: Number(trim.actualStart), actualEnd: Number(trim.actualEnd) };
    const frame = facts.rate ? facts.rate.den / facts.rate.num : 0.05;
    const rel = trimName(ask.path, ask.k, extname(trim.path));
    files.set(rel, { from: trim.path });
    let shown = 0;
    for (const use of ask.uses) {
      const from = use.time?.in ?? 0;
      const to = use.time?.out ?? ask.length;
      if (at.actualStart > from + 0.0005 || at.actualEnd < Math.min(to, ask.length) - frame - 0.001)
        throw new Error(
          `Nothing was rendered: the grade app's trim of ${ask.name} runs ${at.actualStart}–${at.actualEnd} s, short of the ${from}–${to} s the film plays.`,
        );
      // A clip that plays to its file's end ends where it did, not where the trim does, so it keeps its length on the
      // film; but never past the trim's own end, which OpenFilm refuses.
      const move = moveFor(from, at, facts.rate, use.tag === "video");
      const fromMs = Math.round(from * 1000) + move;
      const wanted = Math.round(to * 1000) + move;
      const toMs = Math.min(wanted, Math.floor(facts.duration * 1000));
      if (wanted - toMs > 1)
        log(
          `${use.id ?? use.path}: the trim ends ${wanted - toMs} ms before the clip did, so the clip ends that early.`,
        );
      const time = `#t=${seconds(fromMs)},${seconds(toMs)}`;
      const dir = posix.dirname(use.file);
      const file = `${dir === "." ? "" : `${dir}/`}${posix.basename(rel)}`;
      changes.set(use.span.start, { end: use.span.end, src: `${file}${time}` });
      shown += to - from;
    }
    if (!main || shown > main.shown) main = { ...facts, shown };
    // Its words (`<clip>.vtt`, and `<clip>.<language>.vtt` for each translation), moved to its seconds.
    const stem = basename(ask.path, extname(ask.path));
    const trimStem = basename(rel, extname(rel));
    const dir = join(project, dirname(ask.path));
    const move = Math.round((at.first - at.actualStart) * 1000);
    for (const words of await readdir(dir).catch(() => [])) {
      const language = words.startsWith(stem) ? /^((?:\.[A-Za-z0-9-]+)?)\.vtt$/.exec(words.slice(stem.length)) : null;
      if (!language) continue;
      const vtt = await readFile(join(dir, words), "utf8");
      files.set(posix.join(posix.dirname(ask.path), `${trimStem}${language[1]}.vtt`), {
        text: moveVtt(vtt, move, Math.round(facts.duration * 1000)),
      });
    }
  }

  // The rest of the film, as it is: not its dot folders, its renders, or (for the original) its Chinese version.
  const used = new Set([...clips.map((c) => c.path), ...pages.map((p) => posix.normalize(p))]);
  const skip = (path, entry) =>
    path.split("/").at(-1).startsWith(".") ||
    (path === "zh" && !zh) ||
    (!path.includes("/") && entry.isFile() && VIDEO.test(path) && !used.has(path));
  for (const path of await walk(project, skip)) if (!files.has(path)) files.set(path, { from: join(project, path) });
  files.set("film.html", { text: writeSources(text, changes) });
  files.set(".film/opened", { text: "" });
  for (const file of TOOL_FILES)
    if (await statOf(join(project, ".film", file))) files.set(`.film/${file}`, { from: join(project, ".film", file) });

  const copy = join(renders, zh ? `${name}-zh` : name);
  await sync(copy, files);
  log(`Render copy: ${copy}`);

  const given = (flag) => args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
  const extra = [];
  const settings = JSON.parse((await readFile(join(project, ".film/settings.json"), "utf8").catch(() => null)) ?? "{}");
  const fps = given("--fps") ? null : rateOf(settings, main);
  if (fps) extra.push("--fps", fps);
  const sameShape = main && Math.abs(main.width / main.height - stage.w / stage.h) < 0.01;
  const scaled = !given("--scale") && !given("--4k") && sameShape && main.width > stage.w;
  if (scaled) extra.push("--scale", String(Math.round((main.width / stage.w) * 10000) / 10000));
  log(
    `Rendering${zh ? " the Chinese version" : ""}${fps ? ` at ${fps} fps` : ""}` +
      (scaled ? `, ${main.width}×${main.height} (the footage's size; the frame is ${stage.w}×${stage.h})` : ""),
  );
  const code = await new Promise((done, fail) => {
    const child = spawn(openfilm[0], [...openfilm.slice(1), "render", "--out", out, ...extra, ...args], {
      cwd: copy,
      stdio: output,
    });
    child.on("error", fail);
    child.on("exit", (status, signal) => done(signal ? 1 : status));
  });
  if (code !== 0 || !(await statOf(out)))
    throw new Error(
      `openfilm render stopped (exit ${code}). The render copy stays at ${copy}: render again to pick it up.`,
    );
  await rm(copy, { recursive: true, force: true });
  log(`→ ${out}`);
  return { out, copy, trims: asks.length, args: [...extra, ...args] };
}

/** The rate to render at: the one set in Studio for the film, else its main footage's, else none (OpenFilm's 30). */
function rateOf(settings, main) {
  if (settings.fps) return String(settings.fps);
  if (main?.rate) return fpsOf(main.rate);
  return null;
}

/**
 * Makes `copy` hold exactly `files` (path → `{ from }` a file to clone, or `{ text }`), leaving what's there already
 * the same untouched, so a render that stopped finds its chunks (in `.film/cache`, kept) still match.
 */
async function sync(copy, files) {
  await mkdir(copy, { recursive: true });
  const there = await walk(copy, (path) => path === ".film/cache");
  for (const path of there) if (!files.has(path)) await rm(join(copy, path), { force: true });
  for (const [path, want] of files) {
    const dest = join(copy, path);
    const now = await statOf(dest);
    if (want.text != null) {
      if (now && (await readFile(dest, "utf8")) === want.text) continue;
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, want.text);
      continue;
    }
    const source = await stat(want.from);
    if (now && now.size === source.size && Math.abs(now.mtimeMs - source.mtimeMs) < 1) continue;
    await rm(dest, { force: true });
    await mkdir(dirname(dest), { recursive: true });
    await clone(want.from, dest);
  }
}
