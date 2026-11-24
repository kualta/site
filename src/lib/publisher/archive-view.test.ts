import { expect, test } from "bun:test";
import type { ArchivedClip, ArchivedSettings } from "./archive-tab";
import {
  archivedClip,
  clipNumber,
  clock,
  cloudSource,
  cueAt,
  defaultLook,
  fileUrl,
  filmLabel,
  filmOutputs,
  filmParts,
  type MacClip,
  macSource,
  nameTime,
  ownGrade,
  parseVtt,
  placesOf,
  readFootageView,
  unplayable,
  withMac,
  writeFootageView,
} from "./archive-view";
import type { LedgerClip } from "./ledger";

test("the Footage tab's address holds the clip open, and its day only when one came with it", () => {
  expect(readFootageView("")).toEqual({ clip: null, day: null, project: null });
  const view = { clip: "DJI_20261108122204_0086_D", day: null, project: null };
  expect(writeFootageView(view)).toBe("?clip=DJI_20261108122204_0086_D");
  expect(readFootageView(writeFootageView(view))).toEqual(view);
  // An Archive tab link names the day the cloud files the clip under; without a clip, a day is nothing to keep.
  const linked = { clip: "DJI_20261108122204_0086_D", day: "2026-11-08", project: null };
  expect(readFootageView("?day=2026-11-08&clip=DJI_20261108122204_0086_D")).toEqual(linked);
  expect(writeFootageView(linked)).toBe("?clip=DJI_20261108122204_0086_D&day=2026-11-08");
  expect(writeFootageView(readFootageView("?day=2026-11-08"))).toBe("");
  expect(readFootageView("?day=yesterday&clip=IMG_4857")).toEqual({ clip: "IMG_4857", day: null, project: null });
});

test("the address holds a film's page open by its name, a clip's player in its place", () => {
  const view = { clip: null, day: null, project: "013-maybe-later" };
  expect(writeFootageView(view)).toBe("?project=013-maybe-later");
  expect(readFootageView("?project=013-maybe-later")).toEqual(view);
  expect(readFootageView("?project=013-maybe-later&clip=IMG_4857").project).toBeNull();
  // A shoot day's originals and the grade app's settings are archived as projects, and aren't films.
  for (const name of ["_settings", "_originals-2026-11-08", "../x", ""])
    expect(readFootageView(`?project=${encodeURIComponent(name)}`).project).toBeNull();
});

test("a film's name reads as its number and the rest", () => {
  expect(filmParts("013-maybe-later")).toEqual({ number: "013", slug: "maybe-later" });
  expect(filmLabel("013-maybe-later")).toBe("013 · maybe-later");
  expect(filmLabel("lorax")).toBe("lorax");
});

test("a film's outputs are the videos beside film.html: its render, then the Chinese one, then any other", () => {
  const file = (path: string, n: number) => ({ path, sha256: n.toString(16).padStart(64, "0"), size: n * 1000 });
  const manifest = {
    archivedAt: "2026-11-20T10:00:00.000Z",
    files: [
      file("013-maybe-later-zh.mp4", 2),
      file("013-maybe-later.mp4", 1),
      file("assets/DJI_20261108122204_0086_D.mp4", 3),
      file("zh/assets/DJI_20261108122204_0086_D.mp4", 3),
      file("film.html", 4),
      file("cut-for-x.mov", 5),
      { path: "broken.mp4", sha256: "nope", size: 1 },
    ],
  };
  expect(filmOutputs("013-maybe-later", manifest)).toEqual([
    { name: "Render", file: "013-maybe-later.mp4", sha256: file("", 1).sha256, size: 1000 },
    { name: "Chinese", file: "013-maybe-later-zh.mp4", sha256: file("", 2).sha256, size: 2000 },
    { name: "cut-for-x.mov", file: "cut-for-x.mov", sha256: file("", 5).sha256, size: 5000 },
  ]);
  expect(filmOutputs("014-walk", { archivedAt: "", files: [file("assets/a.mp4", 1)] })).toEqual([]);
});

test("a day's clip is found by its name without the extension, in any case", () => {
  const clips = [
    { file: "DJI_20261108121000_0085_D.mp4", sha256: "a".repeat(64), size: 1 },
    { file: "DJI_20261108122204_0086_D.MP4", sha256: "b".repeat(64), size: 2 },
  ];
  expect(archivedClip(clips, "DJI_20261108122204_0086_D")).toBe(clips[1]);
  expect(archivedClip(clips, "dji_20261108121000_0085_d")).toBe(clips[0]);
  expect(archivedClip(clips, "DJI_20261108122204_0087_D")).toBeUndefined();
});

test("a clip's number, time and file address come from its name", () => {
  expect(clipNumber("DJI_20261108122204_0086_D.MP4")).toBe("0086");
  expect(clipNumber("IMG_4857.MOV")).toBe("IMG_4857");
  expect(nameTime("DJI_20261108122204_0086_D.MP4")).toBe("12:22:04");
  expect(nameTime("IMG_4857.MOV")).toBeNull();
  expect(fileUrl("a".repeat(64), "custom%3AMy Look.cube")).toBe(
    `/api/publisher/archive/files/${"a".repeat(64)}/custom_3AMy_Look.cube`,
  );
  expect([0, 42.9, 725, 3729].map(clock)).toEqual(["0:00", "0:42", "12:05", "1:02:09"]);
});

test("a transcript's lines are read from its WebVTT, and the line said at a time found", () => {
  const cues = parseVtt(
    "WEBVTT\n\n00:00.000 --> 00:02.500\nHello there.\n\n1\n00:00:02.500 --> 00:01:04.000 align:start\n<v Speaker>Second line,\nwrapped.</v>\n\n00:01:04.000 --> 00:01:05.000\n\n",
  );
  expect(cues).toEqual([
    { start: 0, end: 2.5, text: "Hello there." },
    { start: 2.5, end: 64, text: "Second line, wrapped." },
  ]);
  expect([0, 2.4, 2.5, 63.9, 64].map((at) => cueAt(cues, at))).toEqual([0, 0, 1, 1, -1]);
});

const clip: ArchivedClip = { file: "DJI_20261108122204_0086_D.MP4", sha256: "a".repeat(64), size: 10 };
const settings = (paths: string[]): ArchivedSettings => ({
  at: "2026-11-20T00:00:00.000Z",
  files: Object.fromEntries(paths.map((path) => [path, { sha256: "b".repeat(64), size: 1 }])),
});

test("the default look is the first default the profile has backed up", () => {
  expect(defaultLook("dlog2", settings(["looks/dlog2/opendrt-colorful.cube", "looks/dlog2/aces.cube"]))).toMatchObject({
    ok: true,
    path: "looks/dlog2/opendrt-colorful.cube",
  });
  expect(defaultLook("dlog", settings(["looks/dlog2/opendrt-colorful.cube", "looks/dlog/aces.cube"]))).toMatchObject({
    ok: true,
    path: "looks/dlog/aces.cube",
  });
  expect(defaultLook("hlg", settings([]))).toEqual({
    ok: false,
    why: "The grade app hasn't backed up a default look yet",
  });
  expect(defaultLook("rec709", settings([]))).toEqual({ ok: false, why: "Rec.709 is graded as shot" });
  expect(defaultLook(null, settings([]))).toMatchObject({ ok: false });
});

test("its grade is composed from the backed-up grade and look, with the camera's white balance when it's moved", () => {
  const backed = settings(["looks/dlog2/fujifilm-velvia.cube", "looks/dlog2/opendrt-colorful.cube"]);
  expect(ownGrade(clip.file, "dlog2", backed, {}, {})).toEqual({ ok: false, why: "It hasn't been graded" });
  expect(ownGrade(clip.file, "dlog2", null, null, null)).toEqual({ ok: false, why: "Reading its grade…" });
  const graded = ownGrade(clip.file, "dlog2", backed, { [clip.file]: { base: "fujifilm-velvia", exposure: 0.3 } }, {});
  expect(graded).toMatchObject({ ok: true, path: "looks/dlog2/fujifilm-velvia.cube", shotK: null });
  expect(graded.ok && graded.grade).toMatchObject({
    base: "fujifilm-velvia",
    exposure: 0.3,
    contrast: 1,
    kelvin: null,
  });
  // A grade on the default look names none; one on a look not backed up can't be shown.
  expect(ownGrade(clip.file, "dlog2", backed, { [clip.file]: { exposure: 1 } }, {})).toMatchObject({
    ok: true,
    path: "looks/dlog2/opendrt-colorful.cube",
  });
  expect(ownGrade(clip.file, "dlog2", backed, { [clip.file]: { base: "arri-reveal" } }, {})).toEqual({
    ok: false,
    why: "Its look isn't backed up yet",
  });
  // As shot needs no LUT.
  expect(ownGrade(clip.file, "dlog2", backed, { [clip.file]: { base: "none", saturation: 1.3 } }, {})).toMatchObject({
    ok: true,
    path: null,
  });
  // White balance moves from the camera's, which only an export records.
  const warmer = { [clip.file]: { base: "fujifilm-velvia", kelvin: 4800 } };
  expect(ownGrade(clip.file, "dlog2", backed, warmer, {})).toMatchObject({ ok: false });
  expect(ownGrade(clip.file, "dlog2", backed, warmer, { [clip.file]: { cameraKelvin: 5600 } })).toMatchObject({
    ok: true,
    shotK: 5600,
  });
});

const record = (camera: boolean, mac: boolean, cloudflare: boolean): LedgerClip => ({
  name: clip.file,
  recorded: "2026-11-08T12:22:04",
  profile: "dlog2",
  duration: 30,
  size: 10,
  original: { camera, mac, cloudflare },
  graded: null,
  gradePending: false,
});
const onMac: MacClip = {
  name: clip.file,
  on: "mac",
  day: "2026-11-08",
  size: 10,
  recorded: "2026-11-08T12:22:04",
  profile: "dlog2",
  duration: 30,
  cameraKelvin: 5200,
  grade: { base: "fujifilm-velvia", kelvin: 4800 },
  transcript: true,
};

test("a clip plays from the grade app where the ledger has it on the Mac or the card, else from the cloud", () => {
  expect(placesOf(record(false, true, true), "2026-11-08")).toEqual({ mac: true, cloud: true });
  expect(placesOf(record(true, false, false), "")).toEqual({ mac: true, cloud: false });
  expect(placesOf(record(false, false, true), "2026-11-08")).toEqual({ mac: false, cloud: true });
  expect(placesOf(record(false, false, false), "2026-11-08")).toEqual({ mac: false, cloud: false });
  // One the ledger doesn't know is looked for on the Mac, and in the cloud on a day its address names.
  expect(placesOf(undefined, "")).toEqual({ mac: true, cloud: false });
  expect(placesOf(undefined, "2026-11-08")).toEqual({ mac: true, cloud: true });

  const stem = "DJI_20261108122204_0086_D";
  expect(macSource(stem, onMac)).toEqual({
    from: "mac",
    file: clip.file,
    video: `http://127.0.0.1:4777/footage/${stem}/original`,
    vtt: `http://127.0.0.1:4777/footage/${stem}/transcript.vtt`,
    size: 10,
    day: "2026-11-08",
  });
  expect(macSource("IMG 4857", { ...onMac, transcript: false })).toMatchObject({
    video: "http://127.0.0.1:4777/footage/IMG%204857/original",
    vtt: null,
  });
  expect(cloudSource({ ...clip, vtt: "c".repeat(64) }, "2026-11-08")).toEqual({
    from: "cloud",
    file: clip.file,
    video: fileUrl(clip.sha256, clip.file),
    vtt: fileUrl("c".repeat(64), `${stem}.vtt`),
    size: 10,
    day: "2026-11-08",
  });
});

test("a clip found nowhere it was looked for says why, and whether looking again could help", () => {
  const away = {
    why: "It's on the Mac. Open this page there, and allow local network access if Chrome asks.",
    again: true,
  };
  expect(unplayable(record(false, true, false), { mac: "away" })).toEqual(away);
  expect(unplayable(record(true, true, false), { mac: "away" })).toEqual(away);
  expect(unplayable(record(true, false, false), { mac: "away" })).toEqual({
    why: "It's on the camera. Plug it into the Mac, and open this page there.",
    again: true,
  });
  expect(unplayable(record(true, false, false), { mac: "gone" })).toEqual({
    why: "It's on the camera, which isn't plugged in.",
    again: true,
  });
  expect(unplayable(record(false, true, false), { mac: "gone" })).toEqual({
    why: "It isn't on the Mac any more.",
    again: true,
  });
  // The cloud: a listing that couldn't be read is worth reading again; one without the clip isn't.
  expect(unplayable(record(true, false, true), { mac: "away", cloud: "unread" })).toEqual({
    why: "Couldn't read it from the archive.",
    again: true,
  });
  expect(unplayable(record(false, false, true), { cloud: "gone" })).toEqual({
    why: "It isn't in the cloud.",
    again: false,
  });
  expect(unplayable(undefined, { mac: "gone", cloud: "gone" })).toEqual({
    why: "It isn't in the cloud.",
    again: false,
  });
  expect(unplayable(undefined, { mac: "gone" })).toEqual({ why: "It isn't on the Mac or the camera.", again: true });
  expect(unplayable(undefined, { mac: "away" })).toMatchObject({ again: true });
  expect(unplayable(record(false, false, false), {})).toEqual({ why: "No copy of it is left.", again: false });
});

test("a clip the grade app has is graded by the Mac's own grade and its camera's white balance", () => {
  const backed = settings(["looks/dlog2/fujifilm-velvia.cube", "looks/dlog2/opendrt-colorful.cube"]);
  const grades = { [clip.file]: { base: "opendrt-colorful" }, other: { exposure: 1 } };
  expect(withMac(grades, {}, null)).toEqual({ grades, records: {} });
  const known = withMac(grades, {}, onMac);
  expect(known).toEqual({
    grades: { [clip.file]: onMac.grade as Record<string, unknown>, other: { exposure: 1 } },
    records: { [clip.file]: { cameraKelvin: 5200 } },
  });
  expect(ownGrade(clip.file, "dlog2", backed, known.grades, known.records)).toMatchObject({
    ok: true,
    path: "looks/dlog2/fujifilm-velvia.cube",
    shotK: 5200,
  });
  // Ungraded on the Mac, it's ungraded, whatever the backup had; and while the backup is being read, so is its grade.
  const ungraded = withMac(grades, {}, { ...onMac, grade: null });
  expect(ownGrade(clip.file, "dlog2", backed, ungraded.grades, ungraded.records)).toEqual({
    ok: false,
    why: "It hasn't been graded",
  });
  expect(withMac(null, null, onMac).grades).toBeNull();
});
