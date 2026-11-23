import { expect, test } from "bun:test";
import type { ArchivedClip, ArchivedSettings } from "./archive-tab";
import {
  clipNumber,
  clock,
  cueAt,
  defaultLook,
  fileUrl,
  nameTime,
  otherCopies,
  ownGrade,
  parseVtt,
  readArchiveView,
  writeArchiveView,
} from "./archive-view";
import type { LedgerClip } from "./ledger";

test("the tab's address holds the day and the clip open, and nothing it doesn't need", () => {
  expect(readArchiveView("")).toEqual({ day: null, clip: null });
  const view = { day: "2026-11-08", clip: "DJI_20261108122204_0086_D" };
  expect(writeArchiveView(view)).toBe("?day=2026-11-08&clip=DJI_20261108122204_0086_D");
  expect(readArchiveView(writeArchiveView(view))).toEqual(view);
  expect(writeArchiveView({ day: null, clip: null })).toBe("");
  // An old address's page is no longer read.
  expect(readArchiveView("?day=yesterday&page=2")).toEqual({ day: null, clip: null });
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

const ledgerClip = (extra: Partial<LedgerClip> = {}): LedgerClip => ({
  name: "DJI_20261108122204_0086_D.MP4",
  recorded: "2026-11-08T12:22:04",
  profile: "dlog2",
  duration: 30,
  size: 2_780_000_000,
  original: { camera: false, mac: false, cloudflare: true },
  graded: null,
  gradePending: false,
  ...extra,
});

test("where else a clip is, from the ledger", () => {
  expect(otherCopies(undefined)).toBe("Not in the ledger");
  expect(otherCopies(ledgerClip())).toBe("");
  expect(otherCopies(ledgerClip({ original: { camera: true, mac: true, cloudflare: true } }))).toBe(
    "Also on camera, Mac",
  );
  const graded = {
    look: "Umbra",
    at: null,
    size: 1,
    mac: false,
    cloudflare: "current" as const,
    youtube: { video: "v", at: "", current: true },
  };
  expect(otherCopies(ledgerClip({ graded }))).toBe("Graded on Cloudflare, YouTube");
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
  expect(ownGrade(clip, "dlog2", backed, {}, {})).toEqual({ ok: false, why: "It hasn't been graded" });
  expect(ownGrade(clip, "dlog2", null, null, null)).toEqual({ ok: false, why: "Reading its grade…" });
  const graded = ownGrade(clip, "dlog2", backed, { [clip.file]: { base: "fujifilm-velvia", exposure: 0.3 } }, {});
  expect(graded).toMatchObject({ ok: true, path: "looks/dlog2/fujifilm-velvia.cube", shotK: null });
  expect(graded.ok && graded.grade).toMatchObject({
    base: "fujifilm-velvia",
    exposure: 0.3,
    contrast: 1,
    kelvin: null,
  });
  // A grade on the default look names none; one on a look not backed up can't be shown.
  expect(ownGrade(clip, "dlog2", backed, { [clip.file]: { exposure: 1 } }, {})).toMatchObject({
    ok: true,
    path: "looks/dlog2/opendrt-colorful.cube",
  });
  expect(ownGrade(clip, "dlog2", backed, { [clip.file]: { base: "arri-reveal" } }, {})).toEqual({
    ok: false,
    why: "Its look isn't backed up yet",
  });
  // As shot needs no LUT.
  expect(ownGrade(clip, "dlog2", backed, { [clip.file]: { base: "none", saturation: 1.3 } }, {})).toMatchObject({
    ok: true,
    path: null,
  });
  // White balance moves from the camera's, which only an export records.
  const warmer = { [clip.file]: { base: "fujifilm-velvia", kelvin: 4800 } };
  expect(ownGrade(clip, "dlog2", backed, warmer, {})).toMatchObject({ ok: false });
  expect(ownGrade(clip, "dlog2", backed, warmer, { [clip.file]: { cameraKelvin: 5600 } })).toMatchObject({
    ok: true,
    shotK: 5600,
  });
});
