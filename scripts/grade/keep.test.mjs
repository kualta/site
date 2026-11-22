import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keepList } from "./keep.mjs";

let root;
let path;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keep-"));
  path = join(root, "data/keep.json");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const clip = (name, day = "2026-11-18") => ({ name, day });
const A = "DJI_20261118100000_0001_D.MP4";

test("nothing is kept until something is; days and clips are set apart, and what isn't given stays", async () => {
  const keep = keepList(path);
  expect(await keep.read()).toEqual({ days: [], clips: [] });
  expect((await keep.keeping())(clip(A))).toBe(false);
  expect(await keep.set({ days: ["2026-11-19", "2026-11-18", "2026-11-18"] })).toEqual({
    days: ["2026-11-18", "2026-11-19"],
    clips: [],
  });
  expect(await keep.set({ clips: [A] })).toEqual({ days: ["2026-11-18", "2026-11-19"], clips: [A] });
  expect(await keep.set({ days: [] })).toEqual({ days: [], clips: [A] });
  // Another run of the server reads it back.
  expect(await keepList(path).read()).toEqual({ days: [], clips: [A] });
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, days: [], clips: [A] });
});

test("a kept clip is kept whatever its extension, its export too; a kept day is all of its clips", async () => {
  const keep = keepList(path);
  await keep.set({ days: ["2026-11-19"], clips: [A] });
  const keeps = await keep.keeping();
  expect(keeps(clip(A))).toBe(true);
  expect(keeps(clip("dji_20261118100000_0001_d.mp4"))).toBe(true);
  expect(keeps(clip("DJI_20261118100000_0002_D.MP4"))).toBe(false);
  expect(keeps(clip("IMG_4857.MOV", "2026-11-19"))).toBe(true);
});

test("the list is read anew each time it's asked", async () => {
  const keep = keepList(path);
  await keep.set({ days: [] });
  expect((await keep.keeping())(clip(A))).toBe(false);
  writeFileSync(path, JSON.stringify({ clips: [A] }));
  expect((await keep.keeping())(clip(A))).toBe(true);
});

test("a list that can't be read keeps everything, and isn't written over", async () => {
  const keep = keepList(path);
  await keep.set({ clips: [A] });
  for (const broken of ["{ half", "null", '{"days": "2026-11-18"}', '{"clips": [1]}']) {
    writeFileSync(path, broken);
    await expect(keep.keeping()).rejects.toThrow("can't be read");
    await expect(keep.set({ days: ["2026-11-18"] })).rejects.toThrow("can't be read");
    expect(readFileSync(path, "utf8")).toBe(broken);
  }
});

test("a clip added by its name can be let go again, unless it was kept before", async () => {
  const keep = keepList(path);
  const undo = await keep.add(A);
  await keep.set({ days: ["2026-11-18"] });
  expect(await keep.read()).toEqual({ days: ["2026-11-18"], clips: [A] });
  const again = await keep.add(A);
  await again();
  expect((await keep.read()).clips).toEqual([A]);
  await undo();
  expect(await keep.read()).toEqual({ days: ["2026-11-18"], clips: [] });
  // Several at once all count.
  await Promise.all([1, 2, 3].map((n) => keep.add(`${n}.MP4`)));
  expect((await keep.read()).clips).toEqual(["1.MP4", "2.MP4", "3.MP4"]);
  await expect(keep.add("../x.MP4")).rejects.toMatchObject({ status: 400 });
});

test("what isn't a day or a clip is refused, and changes made at once all count", async () => {
  const keep = keepList(path);
  for (const bad of [{ days: ["18 Nov"] }, { days: "2026-11-18" }, { clips: ["a/b.MP4"] }, { clips: {} }])
    await expect(keep.set(bad)).rejects.toMatchObject({ status: 400 });
  await Promise.all([keep.set({ days: ["2026-11-18"] }), keep.set({ clips: [A] })]);
  expect(await keep.read()).toEqual({ days: ["2026-11-18"], clips: [A] });
});
