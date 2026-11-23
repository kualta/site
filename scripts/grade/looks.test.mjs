import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeLut, parseCube, sampleTetra } from "./color.mjs";
import { LOOK_SIZE, lookFiles, lookPath, looksInUse } from "./looks.mjs";
import { sha, site } from "./offload.fixture.mjs";
import { saveSettings } from "./settings.mjs";

/** A stand-in look of `size`: a curve on each channel, and green into red, so where it's sampled shows. */
function look(size, lift = 0) {
  const data = new Float32Array(size ** 3 * 3);
  let i = 0;
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        const [x, y, z] = [r, g, b].map((v) => v / (size - 1));
        data[i++] = Math.min(1, x ** 0.6 * 0.8 + y * 0.2 + lift);
        data[i++] = y ** 1.4;
        data[i++] = 1 - (1 - z) ** 2;
      }
  return { size, data, min: [0, 0, 0], max: [1, 1, 1] };
}

// The app's looks per profile, as server.mjs lists them: "none" has no file, and not every look is there for every profile.
const bases = {
  dlog2: [
    { id: "none", name: "As shot", file: null },
    { id: "aces", name: "ACES 2.0", file: "dlog2-to-rec709-aces2.cube" },
    { id: "opendrt-colorful", name: "Colorful", file: "opendrt/dlog2-colorful.cube" },
    { id: "fujifilm-velvia", name: "Velvia", file: "fujifilm/dlog2-velvia.cube" },
    { id: "p4p-01", name: "Neutral", file: "p4p/P4P_01_Neutral_size65.cube" },
  ],
  dlog: [
    { id: "none", name: "As shot", file: null },
    { id: "aces", name: "ACES 2.0", file: "dlog-to-rec709-aces2.cube" },
    { id: "fujifilm-velvia", name: "Velvia", file: "fujifilm/dlog-velvia.cube" },
  ],
  hlg: [{ id: "none", name: "As shot", file: null }],
  rec709: [
    { id: "none", name: "As shot", file: null },
    { id: "custom:Warm.cube", name: "Warm", file: "custom/rec709/Warm.cube" },
  ],
};
const grades = {
  "DJI_20261108122204_0086_D.MP4": { base: "fujifilm-velvia", exposure: 0.3 },
  "DJI_20261108122300_0087_D.MP4": { base: "none", exposure: -1 },
  "DJI_20261108122400_0088_D.MP4": { exposure: 1 },
  "IMG_4857.MOV": { base: "custom:Warm.cube", saturation: 1.2 },
};

test("the looks backed up are those the grades name, and each profile's default, where the profile has them", () => {
  const ids = Object.fromEntries(Object.entries(looksInUse(grades, bases)).map(([p, l]) => [p, l.map((b) => b.id)]));
  expect(ids).toEqual({
    // OpenDRT Colorful is D-Log2's default; P4P Neutral, which no grade names, stays.
    dlog2: ["opendrt-colorful", "fujifilm-velvia"],
    // Without OpenDRT, D-Log starts on ACES.
    dlog: ["aces", "fujifilm-velvia"],
    hlg: [],
    rec709: ["custom:Warm.cube"],
  });
  expect(lookPath("rec709", "custom:Warm.cube")).toBe("looks/rec709/custom%3AWarm.cube.cube");
});

test("each is the app's own look at 33³, sampled as composeLut samples it, and made again only once it changes", async () => {
  const read = async (file) => ({
    lut: look(file.includes("p4p") ? 65 : 17, file.includes("velvia") ? 0.05 : 0),
    mtime: 1_700_000_000_123.4,
  });
  const files = await lookFiles({ grades, bases, read });
  expect(files.map((f) => f.path)).toEqual([
    "looks/dlog2/opendrt-colorful.cube",
    "looks/dlog2/fujifilm-velvia.cube",
    "looks/dlog/aces.cube",
    "looks/dlog/fujifilm-velvia.cube",
    "looks/rec709/custom%3AWarm.cube.cube",
  ]);
  const velvia = parseCube(new TextDecoder().decode(files[1].body));
  expect(velvia.size).toBe(LOOK_SIZE);
  expect(velvia.title).toBe("Velvia · dlog2 · grade app");
  // The grid's own points are the look's, and between them the small LUT lands where the app's would.
  const app = look(17, 0.05);
  for (const point of [
    [0, 0, 0],
    [1, 1, 1],
    [0.5, 0.25, 0.75],
    [0.31, 0.62, 0.07],
  ]) {
    const ours = sampleTetra(velvia, ...point);
    const theirs = sampleTetra(app, ...point);
    for (let k = 0; k < 3; k++) expect(Math.abs(ours[k] - theirs[k])).toBeLessThan(0.004);
  }
  // A clip's whole grade composed over the small LUT is within a level of the same composed over the app's.
  const grade = { exposure: 0.3, saturation: 1.2, contrast: 1.1 };
  const fromBackup = composeLut({ profile: "dlog2", grade, shotK: 5600, base: velvia, size: 9 });
  const fromApp = composeLut({ profile: "dlog2", grade, shotK: 5600, base: app, size: 9 });
  for (let i = 0; i < fromApp.length; i++) expect(Math.abs(fromBackup[i] - fromApp[i])).toBeLessThan(1 / 255);
  // About a megabyte each, whatever the look's own size; the mtime is the look's file's.
  for (const file of files) {
    expect(file.body.length).toBeLessThan(1_100_000);
    expect(file.mtime).toBe(1_700_000_000_123);
  }
  // Made once: the same look, unchanged, is the same bytes without composing it again.
  expect((await lookFiles({ grades, bases, read }))[1].body).toBe(files[1].body);
});

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "looks-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("the looks go in _settings beside the grades, and again only once they change", async () => {
  const request = site();
  const paths = ["grades.json", "exports.json"].map((name) => join(root, name));
  writeFileSync(paths[0], "the grades");
  writeFileSync(paths[1], "the exports");
  const made = (text) => [{ path: "looks/dlog2/aces.cube", body: new TextEncoder().encode(text), mtime: 5 }];
  const first = await saveSettings(request, paths, null, made("aces"));
  expect(
    (await request("projects/_settings")).files.map(({ path, sha256, size, mtime }) => [path, sha256, size, mtime]),
  ).toEqual([
    ["grades.json", sha("the grades"), 10, expect.any(Number)],
    ["exports.json", sha("the exports"), 11, expect.any(Number)],
    ["looks/dlog2/aces.cube", sha("aces"), 4, 5],
  ]);
  expect(await (await request(`blobs/${sha("aces")}`, { raw: true })).text()).toBe("aces");
  const asked = request.asked.length;
  expect(await saveSettings(request, paths, first, made("aces"))).toBe(first);
  expect(request.asked).toHaveLength(asked);
  // A look that changed goes up by itself; the grades, unchanged, aren't sent again.
  await saveSettings(request, paths, first, made("aces, again"));
  expect(request.asked.slice(asked).filter((what) => what.startsWith("PUT"))).toEqual([
    `PUT blobs/${sha("aces, again")}`,
    "PUT projects/_settings",
  ]);
  // Without grades or export records there's nothing to back up, looks or not.
  rmSync(paths[0]);
  rmSync(paths[1]);
  expect(await saveSettings(site(), paths, null, made("aces"))).toBeNull();
});
