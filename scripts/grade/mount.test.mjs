import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mountWatch } from "./mount.mjs";
import { until } from "./offload.fixture.mjs";

// The card's folder, as /Volumes/Pocket4P/DCIM is: a folder of its own in the one volumes appear in.
const made = [];
afterEach(() => {
  for (const { root, watch } of made.splice(0)) {
    watch.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
function volumes(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "volumes-"));
  const card = join(root, "Pocket4P/DCIM");
  const heard = [];
  const watch = mountWatch(card, { changed: (mounted) => heard.push(mounted), ...options });
  made.push({ root, watch });
  return {
    heard,
    watch,
    plug: () => mkdirSync(card, { recursive: true }),
    pull: () => renameSync(join(root, "Pocket4P"), join(root, `ejected-${heard.length}`)),
  };
}

test("the card plugged in or pulled out is noticed at once, by a watch on the folder volumes appear in", async () => {
  // Looked at only every minute: the watch is what notices.
  const { heard, watch, plug, pull } = volumes({ every: 60_000 });
  watch.start();
  await until(() => watch.mounted === false);
  expect(heard).toEqual([]);
  plug();
  await until(() => heard.length === 1, 2_000);
  expect([heard, watch.mounted]).toEqual([[true], true]);
  pull();
  await until(() => heard.length === 2, 2_000);
  expect([heard, watch.mounted]).toEqual([[true, false], false]);
});

test("without a watch to be had, it's noticed at the next look, and each change only once", async () => {
  const { heard, watch, plug, pull } = volumes({
    every: 50,
    watch: () => {
      throw new Error("no watching here");
    },
  });
  plug();
  watch.start();
  await until(() => watch.mounted === true);
  // As it was at the first look, it's no change.
  expect(heard).toEqual([]);
  pull();
  await until(() => heard.length === 1, 2_000);
  plug();
  await until(() => heard.length === 2, 2_000);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(heard).toEqual([false, true]);
});
