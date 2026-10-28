import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepChromeClones } from "./clones.mjs";

const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const helper =
  "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper";
// `ps -o lstart` prints local time as "Wed Oct 28 08:43:19 2026".
function lstart(ms) {
  const date = new Date(ms);
  const [weekday, month] = date.toDateString().split(" ");
  return `${weekday} ${month} ${String(date.getDate()).padStart(2)} ${date
    .toTimeString()
    .slice(0, 8)} ${date.getFullYear()}`;
}
async function withClone(check) {
  const root = await mkdtemp(join(tmpdir(), "clones-"));
  try {
    await mkdir(join(root, "code_sign_clone.a"));
    await check(root, (await stat(join(root, "code_sign_clone.a"))).birthtimeMs);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const ps = (lines) => async () => ({ stdout: lines.join("\n") });

test("an orphaned clone is removed once it has settled", () =>
  withClone(async (root, born) => {
    const run = ps([`${lstart(born - 3_600_000)}     ${chrome}`]);
    expect(await sweepChromeClones({ root, run, now: () => born + 1_000 })).toEqual([]);
    expect(await sweepChromeClones({ root, run, now: () => born + 120_000 })).toEqual(["code_sign_clone.a"]);
    expect(await readdir(root)).toEqual([]);
  }));

test("a clone born with a running Chrome stays", () =>
  withClone(async (root, born) => {
    const run = ps([`${lstart(born - 6_000)}     ${chrome} --user-data-dir=/profile`]);
    expect(await sweepChromeClones({ root, run, now: () => born + 120_000 })).toEqual([]);
    expect(await readdir(root)).toEqual(["code_sign_clone.a"]);
  }));

test("Chrome's helper processes don't own clones", () =>
  withClone(async (root, born) => {
    const run = ps([`${lstart(born - 6_000)}     ${helper} --type=renderer`]);
    expect(await sweepChromeClones({ root, run, now: () => born + 120_000 })).toEqual(["code_sign_clone.a"]);
  }));

test("a missing clone folder is nothing to sweep", async () => {
  expect(await sweepChromeClones({ root: "/nonexistent/clones", run: ps([]) })).toEqual([]);
});
