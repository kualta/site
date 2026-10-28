import { execFile } from "node:child_process";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);

// Chrome on macOS copies its ~1.4 GB app into a code-sign clone at every launch and removes it only on a
// normal quit, so a killed sign-in window or crashed automation leaves one behind. The clone appears within
// seconds of its Chrome starting; one that matches no running Chrome's start time is an orphan.
const MATCH_MS = 30_000;
const SETTLE_MS = 60_000;

async function cloneRoot(run) {
  const { stdout } = await run("getconf", ["DARWIN_USER_TEMP_DIR"]);
  return join(stdout.trim(), "..", "X", "com.google.Chrome.code_sign_clone");
}

/** Removes orphaned Chrome code-sign clones and returns their names. */
export async function sweepChromeClones({
  run = exec,
  now = Date.now,
  root,
  remove = (path) => rm(path, { recursive: true, force: true }),
} = {}) {
  if (process.platform !== "darwin" && !root) return [];
  const folder = root ?? (await cloneRoot(run));
  let names;
  try {
    names = await readdir(folder);
  } catch {
    return [];
  }
  const { stdout } = await run("ps", ["-axo", "lstart=,command="]);
  const starts = stdout
    .split("\n")
    .filter((line) => /\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome( |$)/.test(line))
    .map((line) => Date.parse(line.slice(0, 24)));
  const removed = [];
  for (const name of names) {
    const path = join(folder, name);
    const { birthtimeMs } = await stat(path);
    // A Chrome that is still starting may not be listed yet; anything near a running Chrome stays.
    if (now() - birthtimeMs < SETTLE_MS || starts.some((start) => Math.abs(start - birthtimeMs) < MATCH_MS)) continue;
    await remove(path);
    removed.push(name);
  }
  return removed;
}
