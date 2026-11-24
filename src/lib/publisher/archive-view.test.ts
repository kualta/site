import { expect, test } from "bun:test";
import type { ArchivedClip, ArchivedSettings } from "./archive-tab";
import {
  archivedClip,
  clipNumber,
  clock,
  cueAt,
  defaultLook,
  fileUrl,
  nameTime,
  ownGrade,
  parseVtt,
  readFootageView,
  writeFootageView,
} from "./archive-view";

test("the Footage tab's address holds the clip open, and its day only when one came with it", () => {
  expect(readFootageView("")).toEqual({ clip: null, day: null });
  const view = { clip: "DJI_20261108122204_0086_D", day: null };
  expect(writeFootageView(view)).toBe("?clip=DJI_20261108122204_0086_D");
  expect(readFootageView(writeFootageView(view))).toEqual(view);
  // An Archive tab link names the day the cloud files the clip under; without a clip, a day is nothing to keep.
  const linked = { clip: "DJI_20261108122204_0086_D", day: "2026-11-08" };
  expect(readFootageView("?day=2026-11-08&clip=DJI_20261108122204_0086_D")).toEqual(linked);
  expect(writeFootageView(linked)).toBe("?clip=DJI_20261108122204_0086_D&day=2026-11-08");
  expect(writeFootageView(readFootageView("?day=2026-11-08"))).toBe("");
  expect(readFootageView("?day=yesterday&clip=IMG_4857")).toEqual({ clip: "IMG_4857", day: null });
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
