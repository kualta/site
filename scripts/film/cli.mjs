#!/usr/bin/env node
// bun run film <command> <film>: graded previews in an OpenFilm film while it's cut, and renders from full-quality
// trims of its camera clips. See previews.mjs and render.mjs.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { gradeApp } from "./grade.mjs";
import { filmStatus, makePreviews } from "./previews.mjs";
import { OPENFILM, renderFilm } from "./render.mjs";

const PROJECTS = process.env.OPENFILM_PROJECTS || join(homedir(), "Movies/OpenFilm/Projects");

const USAGE = `bun run film <command> [film] [options]

  previews <film> [--watch]  clone the grade app's graded preview copies of the film's camera clips into its assets
                             (zh/ too), keeping each original in assets/.originals/; run it again after regrading,
                             or keep --watch running to follow every regrade
  status <film>              which camera clips have current previews, and which are outdated, stale or missing
  render <film> [--zh] [openfilm render options]
                             render from full-quality trims of the camera clips to <film>/<name>.mp4, or with --zh
                             the Chinese version in zh/ to <film>/<name>-zh.mp4 (e.g. --subtitles, --loudness=-14)

<film> is the film's folder, its name in ${PROJECTS}, or nothing for the film around this folder.
The grade app is asked at GRADE_URL (http://127.0.0.1:4777).`;

/** The film's folder, and whether it was named by its Chinese version's. */
function findFilm(arg) {
  let dir = null;
  if (!arg) {
    for (let up = process.cwd(); up !== dirname(up); up = dirname(up))
      if (existsSync(join(up, "film.html"))) {
        dir = up;
        break;
      }
  } else if (existsSync(join(resolve(arg), "film.html"))) dir = resolve(arg);
  else if (existsSync(join(PROJECTS, arg, "film.html"))) dir = join(PROJECTS, arg);
  if (!dir) throw new Error(arg ? `${arg} isn't a film (no film.html there or in ${PROJECTS})` : "No film around here");
  if (basename(dir) === "zh" && existsSync(join(dirname(dir), "film.html"))) return { film: dirname(dir), zh: true };
  return { film: dir, zh: false };
}

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

async function main([command, ...rest]) {
  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE);
    return 0;
  }
  const grade = gradeApp();
  const flags = rest.filter((arg) => arg.startsWith("-"));
  const named = rest.find((arg) => !arg.startsWith("-"));
  if (command === "previews") {
    const { film } = findFilm(named);
    const done = await makePreviews(film, { grade });
    if (!flags.includes("--watch")) return done.failed.length || done.missing.length ? 1 : 0;
    console.log("Watching for regrades; Ctrl-C stops.");
    for (;;) {
      await pause(3000);
      try {
        const { rows } = await filmStatus(film, { grade });
        if (rows.some((row) => ["stale", "outdated", "original", "making"].includes(row.state)))
          await makePreviews(film, { grade });
      } catch (error) {
        console.error(error.message);
      }
    }
  }
  if (command === "status") {
    const { film } = findFilm(named);
    const { rows, unreachable } = await filmStatus(film, { grade });
    if (unreachable) console.log(unreachable);
    if (!rows.length) console.log(`${basename(film)} uses no camera clips.`);
    const where = (row) => (row.project ? `${row.project}/${row.path}` : row.path);
    const width = Math.max(0, ...rows.map((row) => where(row).length));
    for (const row of rows) console.log(`${where(row).padEnd(width)}  ${row.detail}`);
    const off = rows.filter((row) => !["current", "unknown"].includes(row.state));
    if (off.length) console.log(`${off.length} of ${rows.length} not current.`);
    else if (rows.length && !unreachable) console.log("All current.");
    return 0;
  }
  if (command === "render") {
    const { film, zh } = findFilm(named);
    const args = rest.filter((arg) => arg !== named && arg !== "--zh");
    // FILM_OPENFILM runs another `openfilm` (a stand-in, to try the flow without rendering).
    const openfilm = process.env.FILM_OPENFILM ? process.env.FILM_OPENFILM.split(" ") : OPENFILM;
    await renderFilm(film, { zh: zh || rest.includes("--zh"), args, grade, openfilm });
    return 0;
  }
  console.error(`No command ${command}.\n\n${USAGE}`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error.message);
    process.exitCode = 1;
  },
);
