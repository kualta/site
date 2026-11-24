// A film is the Pipeline piece with its number: piece 17's OpenFilm project is ~/Movies/OpenFilm/Projects/017-<slug>.
// `film <number>` starts the project for a piece, `film new "<title>"` makes the piece first, and `number-pieces`
// numbers the pieces from before numbers, giving each piece a posted film went out as that film's number.
import { execFile, spawn } from "node:child_process";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { PROJECTS, filmNumber, md5File } from "./archive.mjs";

/** The films from before numbers run to 016; pieces count on from there (as `NUMBERED_AFTER` in content.ts). */
export const NUMBERED_AFTER = 16;
/** The largest video the composer takes: a render larger than this went up re-encoded, so it can't be found by MD5. */
export const MAX_UPLOAD = 90_000_000;
/** How long after its render a film's draft sends it up: the composer's video of a film goes up minutes after. */
export const UPLOAD_WINDOW = 15 * 60_000;

/** A number as a film's folder starts with it: 017. */
export const pad = (number) => String(number).padStart(3, "0");

/** A title as the words of a folder's name: lowercase letters and digits joined by hyphens, at most 48 characters. */
export function slugOf(title) {
  const words = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let slug = "";
  for (const word of words) {
    const longer = slug ? `${slug}-${word}` : word;
    if (longer.length > 48) break;
    slug = longer;
  }
  return slug || words[0]?.slice(0, 48) || "film";
}

/** The numbered folders in `dir`, by name. */
export async function localFilms(dir = PROJECTS) {
  const entries = await readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return entries
    .filter((entry) => entry.isDirectory() && filmNumber(entry.name) !== null)
    .map((entry) => entry.name)
    .sort();
}

/** The highest number of the films named, or 0. */
export const highestFilm = (names) => Math.max(0, ...names.map((name) => filmNumber(name) ?? 0));

/** OpenFilm's `open`: makes a new project in the folder and shows it in Studio, printing Studio's address. */
export function openFilm(path) {
  return new Promise((done, fail) => {
    const child = spawn("npx", ["-y", "openfilm@latest", "open", path], { stdio: "inherit" });
    child.on("error", fail);
    child.on("exit", (code) => (code === 0 ? done() : fail(new Error(`openfilm open stopped (${code})`))));
  });
}

/**
 * Starts the film of `piece`, numbered: its folder in `dir` is `NNN-slug`, made by OpenFilm's `open`. A folder with its
 * number already on the laptop opens as it is, whatever its slug; one only in the archive (`archived`, by name) comes
 * back with `restore` first.
 */
export async function startFilm(piece, { dir = PROJECTS, archived = [], open = openFilm }) {
  if (!Number.isSafeInteger(piece.number)) throw new Error(`“${piece.title}” has no number yet: run number-pieces`);
  const prefix = `${pad(piece.number)}-`;
  const here = (await localFilms(dir)).find((name) => name.startsWith(prefix));
  const away = archived.find((name) => name.startsWith(prefix));
  if (!here && away)
    throw new Error(`${away} is in the archive: bring it back with node scripts/publisher/cli.mjs restore ${away}`);
  const path = join(dir, here ?? `${prefix}${slugOf(piece.title)}`);
  await open(path);
  if (!(await stat(join(path, "film.html")).catch(() => null))) throw new Error(`OpenFilm made no project at ${path}`);
  return { path, made: !here };
}

/* ── numbering the pieces from before numbers ─────────────────────────── */

/**
 * Which piece each film went out as, and the number each piece without one gets.
 *
 * - `pieces`: every piece, `{ id, title, stage, job_id, created_at, number }`.
 * - `films`: each numbered film, archived or on the laptop, `{ name, number, renders: [{ md5, mtime }] }`: its render
 *   and its Chinese version's, each with its MD5 when known.
 * - `uploads`: each post's first video upload, by its id: when it went up.
 * - `posted`: the posts holding each MD5 as their video, as the posted check answers.
 *
 * A film went out as the post whose video is its render, byte for byte; else as the post whose video went up within
 * `window` after the film was rendered, as the draft sends a render up minutes after it's made (re-encoded when it's
 * too large, and the composer's uploads expire, so their bytes can't always be compared). That post's piece takes the
 * film's number. Every other piece without a number takes the next one after every film and piece, in the order the
 * pieces were made. Numbers already given stay.
 */
export function planNumbers({ pieces, films, uploads, posted, after = NUMBERED_AFTER, window = UPLOAD_WINDOW }) {
  const byJob = new Map();
  for (const piece of pieces) if (piece.job_id && !byJob.has(piece.job_id)) byJob.set(piece.job_id, piece);
  const ordered = [...films].sort((a, b) => a.number - b.number || a.name.localeCompare(b.name));
  const matched = new Set();
  const matches = [];
  const left = [];
  for (const film of ordered) {
    const piece = film.renders
      .flatMap((render) => (render.md5 && posted.get(render.md5)) || [])
      .map((job) => byJob.get(job))
      .find((found) => found && !matched.has(found.id));
    if (!piece) left.push(film);
    else {
      matched.add(piece.id);
      matches.push({ film, piece, how: "same" });
    }
  }
  const pairs = [];
  for (const film of left) {
    if (!film.renders.length) continue;
    const rendered = Math.max(...film.renders.map((render) => render.mtime));
    for (const [job, at] of uploads) {
      const piece = byJob.get(job);
      if (piece && at >= rendered && at - rendered <= window) pairs.push({ film, piece, gap: at - rendered });
    }
  }
  pairs.sort((a, b) => a.gap - b.gap || a.film.number - b.film.number);
  const placed = new Set();
  for (const pair of pairs)
    if (!placed.has(pair.film.name) && !matched.has(pair.piece.id)) {
      placed.add(pair.film.name);
      matched.add(pair.piece.id);
      matches.push({ ...pair, how: "uploaded" });
    }
  matches.sort((a, b) => a.film.number - b.film.number);
  const unmatched = left.filter((film) => !placed.has(film.name));

  const used = new Set(pieces.flatMap((piece) => (piece.number === null ? [] : [piece.number])));
  const assign = [];
  const clashes = [];
  for (const { film, piece } of matches) {
    if (piece.number === film.number) continue;
    if (piece.number !== null)
      clashes.push(`${film.name} went out as “${piece.title}”, which is numbered ${pad(piece.number)} already`);
    else if (used.has(film.number))
      clashes.push(`${film.name} went out as “${piece.title}”, but another piece is numbered ${pad(film.number)}`);
    else {
      used.add(film.number);
      assign.push({ piece, number: film.number });
    }
  }
  const given = new Set(assign.map(({ piece }) => piece.id));
  let next = Math.max(after, ...films.map((film) => film.number), ...used);
  const unnumbered = pieces
    .filter((piece) => piece.number === null && !given.has(piece.id))
    .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
  for (const piece of unnumbered) assign.push({ piece, number: ++next });
  const numbered = pieces.filter((piece) => piece.number !== null).length;
  return { matches, unmatched, assign, clashes, numbered };
}

/** How a piece was found to be a film, after its line in the plan. */
function matchNote(match) {
  if (!match) return "";
  if (match.how === "same") return `  ← ${match.film.name}: the render is its video`;
  const minutes = Math.round(match.gap / 60_000);
  const when = minutes ? `${minutes} min after` : "within a minute of";
  return `  ← ${match.film.name}: its video went up ${when} the render`;
}

/** The plan in lines: each piece's new number, with the film it went out as. */
export function describePlan({ matches, unmatched, assign, clashes, numbered }) {
  const filmOf = new Map(matches.map((match) => [match.piece.id, match]));
  const lines = [...assign]
    .sort((a, b) => a.number - b.number)
    .map(
      ({ piece, number }) =>
        `${pad(number)}  ${piece.title.split("\n")[0].slice(0, 70)}${matchNote(filmOf.get(piece.id))}`,
    );
  for (const match of matches)
    if (match.piece.number === match.film.number)
      lines.push(`${match.film.name} is numbered as “${match.piece.title}” already`);
  if (unmatched.length) lines.push(`No piece went out as ${unmatched.map((film) => film.name).join(", ")}`);
  if (numbered)
    lines.push(`${numbered} ${numbered === 1 ? "piece has its number" : "pieces have their numbers"} already`);
  lines.push(...clashes.map((clash) => `Left as it is: ${clash}`));
  return lines;
}

/* ── where the plan's facts come from ─────────────────────────────────── */

const run = promisify(execFile);
/**
 * Rows from the publisher's D1 database through wrangler: production's, or with `local` the copy `wrangler dev` keeps.
 * Several statements run in order; the rows of all of them come back.
 */
export function d1({ root, local = false, exec = run }) {
  return async (sql) => {
    const where = local ? "--local" : "--remote";
    let stdout;
    try {
      ({ stdout } = await exec(
        "bunx",
        ["wrangler", "d1", "execute", "kualta-newsletter", where, "--json", "--command", sql],
        { cwd: root, maxBuffer: 64 * 1024 * 1024, timeout: 5 * 60_000 },
      ));
    } catch (error) {
      const said = `${error.stdout ?? ""}${error.stderr ?? ""}`;
      throw Object.assign(new Error(said.match(/"text":\s*"([^"]+)"/)?.[1] || said.trim() || error.message), {
        said,
      });
    }
    return JSON.parse(stdout.slice(stdout.indexOf("["))).flatMap((result) => result.results ?? []);
  };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Each numbered film with its renders: the archive's, from their manifests, and the laptop's, which win. A render's MD5
 * is read from the laptop's copy, or from the archive's when it's small enough to have gone up unchanged; those are kept
 * in `cache` (a file, by SHA-256), so asking again downloads nothing.
 */
export async function filmRenders({ request, dir = PROJECTS, cache, log = () => {} }) {
  const known = JSON.parse(await readFile(cache, "utf8").catch(() => "{}"));
  /** An archived render's MD5, read from the archive the first time it's asked for. */
  async function archivedMd5(name, file) {
    if (!known[file.sha256]) {
      log(`${name}: reading ${file.path} from the archive for its MD5`);
      const response = await request(`blobs/${file.sha256}`, { raw: true });
      const md5 = createHash("md5");
      const sha = createHash("sha256");
      for await (const chunk of response.body) {
        md5.update(chunk);
        sha.update(chunk);
      }
      if (sha.digest("hex") !== file.sha256) throw new Error(`${name}/${file.path} came back different`);
      known[file.sha256] = md5.digest("hex");
      await writeFile(cache, JSON.stringify(known), { mode: 0o600 });
    }
    return known[file.sha256];
  }
  // Only the original can be its post's video byte for byte: a Chinese version goes out in the same post.
  const hashed = (name, path, size) => path === `${name}.mp4` && size <= MAX_UPLOAD;
  const films = new Map();
  for (const { name } of (await request("projects")).projects) {
    const number = filmNumber(name);
    if (number === null) continue;
    // One at a time, a moment apart: the Worker has little CPU to spare.
    await sleep(300);
    const manifest = await request(`projects/${encodeURIComponent(name)}`);
    const renders = [];
    for (const path of [`${name}.mp4`, `${name}-zh.mp4`]) {
      const file = manifest.files.find((listed) => listed.path === path);
      if (!file) continue;
      const md5 = hashed(name, path, file.size) ? await archivedMd5(name, file) : null;
      renders.push({ md5, mtime: file.mtime });
    }
    films.set(name, { name, number, renders });
  }
  for (const name of await localFilms(dir)) {
    const renders = [];
    for (const path of [`${name}.mp4`, `${name}-zh.mp4`]) {
      const abs = join(dir, name, path);
      const info = await stat(abs).catch(() => null);
      if (!info?.isFile()) continue;
      const md5 = hashed(name, path, info.size) ? await md5File(abs) : null;
      renders.push({ md5, mtime: info.mtimeMs });
    }
    films.set(name, { name, number: filmNumber(name), renders });
  }
  return [...films.values()];
}

/**
 * Numbers the pieces from before numbers, from the facts as they are now: plans, then (unless `dryRun`) writes each
 * number to a piece that still has none. Running it again plans only what's left.
 */
export async function numberPieces({ query, request, dir = PROJECTS, cache, dryRun = true, log = () => {} }) {
  let missingColumn = false;
  const pieces = await query(
    "SELECT id, title, stage, job_id, created_at, number FROM publisher_content ORDER BY created_at, id",
  ).catch(async (error) => {
    if (!/no such column: number/.test(error.message + (error.said ?? ""))) throw error;
    missingColumn = true;
    const rows = await query("SELECT id, title, stage, job_id, created_at FROM publisher_content ORDER BY created_at");
    return rows.map((row) => ({ ...row, number: null }));
  });
  if (missingColumn && !dryRun)
    throw new Error("The database has no piece numbers yet: apply migrations/0015_publisher_content_number.sql first");
  const uploads = new Map(
    (
      await query(
        "SELECT job_id, MIN(created_at) AS at FROM publisher_media WHERE kind = 'video' AND job_id IS NOT NULL GROUP BY job_id",
      )
    ).map((row) => [row.job_id, row.at]),
  );
  const films = await filmRenders({ request, dir, cache, log });
  const md5s = [...new Set(films.flatMap((film) => film.renders.flatMap((render) => render.md5 ?? [])))];
  const posted = new Map();
  if (md5s.length)
    for (const { md5, job } of (await request("posted", { method: "POST", json: { md5s } })).posted)
      if (md5) posted.set(md5, [...(posted.get(md5) ?? []), job]);
  const plan = planNumbers({ pieces, films, uploads, posted });
  if (dryRun || !plan.assign.length) return { ...plan, missingColumn, written: 0 };
  for (const { piece, number } of plan.assign)
    if (!/^[0-9a-f-]{36}$/.test(piece.id) || !Number.isSafeInteger(number))
      throw new Error(`Refusing to write ${number} to ${piece.id}`);
  // One statement each, only to a piece still without a number; the unique index refuses a number twice.
  await query(
    plan.assign
      .map(
        ({ piece, number }) =>
          `UPDATE publisher_content SET number = ${number} WHERE id = '${piece.id}' AND number IS NULL;`,
      )
      .join("\n"),
  );
  const now = new Map(
    (await query("SELECT id, number FROM publisher_content WHERE number IS NOT NULL")).map((row) => [
      row.id,
      row.number,
    ]),
  );
  const written = plan.assign.filter(({ piece, number }) => now.get(piece.id) === number).length;
  return { ...plan, missingColumn, written };
}
