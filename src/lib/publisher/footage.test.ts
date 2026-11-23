import { expect, test } from "bun:test";
import { footageResponse, isWatched, MAX_STATUS, WATCH_TTL } from "./footage";
import { MAX_MAC_REPORT } from "./mac";
import { memoryArchive, memoryMedia } from "./memory-archive";
import type { MediaBucket } from "./server";

const url = "https://post.kualta.dev/api/publisher/";
const call = (path: string, method = "GET", body?: unknown) =>
  new Request(url + path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
/** A route's answer, which these paths always have. */
async function answer(bucket: MediaBucket, path: string, method = "GET", body?: unknown, now = Date.now()) {
  const response = await footageResponse(path, call(path, method, body), { media: bucket }, now);
  if (!response) throw new Error(`${method} ${path} wasn't answered`);
  return response;
}

test("the Archive tab counts as open while it keeps saying so, and closes when it says it closed", async () => {
  const { bucket } = memoryMedia();
  const now = Date.parse("2026-11-21T12:00:00Z");
  const ask = async (at: number) => (await answer(bucket, "helper/footage", "GET", undefined, at)).json();
  expect(await ask(now)).toEqual({ watching: false, paused: null });
  await answer(bucket, "footage/watch", "POST", {}, now);
  expect(await ask(now + 60_000)).toEqual({ watching: true, paused: null });
  // A tab that stops saying so (closed without a word, the laptop asleep) lapses on its own.
  expect(await isWatched(bucket, now + WATCH_TTL + 1)).toBe(false);
  await answer(bucket, "footage/watch", "POST", {}, now);
  await answer(bucket, "footage/watch", "DELETE", undefined, now);
  expect(await ask(now)).toEqual({ watching: false, paused: null });
  // The grade app, on the helper's pairing, keeps it fresh while an offload goes; it lapses the same way after.
  await answer(bucket, "helper/footage/watch", "POST", undefined, now);
  expect(await ask(now + 60_000)).toEqual({ watching: true, paused: null });
  expect(await isWatched(bucket, now + WATCH_TTL + 1)).toBe(false);
  expect(
    await footageResponse("helper/footage/watch", call("helper/footage/watch", "DELETE"), { media: bucket }),
  ).toBeNull();
});

test("the laptop's status reaches the tab as sent, with how long ago it came", async () => {
  const { bucket } = memoryMedia();
  const status = { at: 1, state: "uploading", current: { name: "DJI_x.mp4", sent: 5, size: 10 }, speed: 2_500_000 };
  expect(await (await answer(bucket, "helper/footage", "POST", status)).json()).toEqual({
    watching: false,
    paused: null,
  });
  await answer(bucket, "footage/watch", "POST", {});
  const body = (await (await answer(bucket, "footage", "GET", undefined, Date.now() + 2_000)).json()) as {
    watching: boolean;
    age: number;
    status: unknown;
  };
  expect(body.watching).toBe(true);
  expect(body.status).toEqual(status);
  expect(body.age).toBeGreaterThanOrEqual(1_900);
  expect(body.age).toBeLessThan(5_000);
  // Saying it's open answers the same, so a hidden tab, which reads nothing else, hears how the upload is going.
  const beat = (await (await answer(bucket, "footage/watch", "POST", {})).json()) as typeof body;
  expect(beat.watching).toBe(true);
  expect(beat.status).toEqual(status);
  expect(beat.age).toBeLessThan(5_000);
});

test("before the laptop has said anything the tab reads no status", async () => {
  const { bucket } = memoryMedia();
  expect(await (await answer(bucket, "footage")).json()).toEqual({
    watching: false,
    age: null,
    paused: null,
    status: null,
  });
});

test("a status that isn't an object, or is too big, is refused and the last one kept", async () => {
  const { bucket } = memoryMedia();
  await answer(bucket, "helper/footage", "POST", { state: "done" });
  for (const body of ["[1,2]", "not json", "null", JSON.stringify({ pad: "x".repeat(MAX_STATUS) })]) {
    const response = await answer(bucket, "helper/footage", "POST", body);
    expect([400, 413]).toContain(response.status);
  }
  const read = (await (await answer(bucket, "footage")).json()) as { status: unknown };
  expect(read.status).toEqual({ state: "done" });
});

test("other paths and methods are left to the rest of the API", async () => {
  const { bucket } = memoryMedia();
  expect(await footageResponse("footage", call("footage", "POST", {}), { media: bucket })).toBeNull();
  expect(await footageResponse("footage/watch", call("footage/watch"), { media: bucket })).toBeNull();
  expect(await footageResponse("helper/footage", call("helper/footage", "DELETE"), { media: bucket })).toBeNull();
});

test("the Footage tab reads the ledger and its pictures from the archive, as they're stored", async () => {
  const { bucket: media } = memoryMedia();
  const { bucket: archive } = memoryArchive();
  const read = (path: string) => footageResponse(path, call(path), { media, archive });
  expect((await read("footage/ledger"))?.status).toBe(404);
  const ledger = JSON.stringify({ version: 1, clips: { DJI_20261111161230_0258_D: { thumb: true } } });
  await archive.put("ledger/footage.json", ledger);
  const sent = await read("footage/ledger");
  expect(sent?.headers.get("Content-Type")).toBe("application/json");
  expect(await sent?.text()).toBe(ledger);

  await archive.put("ledger/thumbs/DJI_20261111161230_0258_D.jpg", "jpeg bytes");
  const picture = await read("footage/thumbs/DJI_20261111161230_0258_D.jpg");
  expect(picture?.headers.get("Content-Type")).toBe("image/jpeg");
  expect(picture?.headers.get("Cache-Control")).toBe("private, max-age=86400");
  expect(await picture?.text()).toBe("jpeg bytes");
  expect((await read("footage/thumbs/IMG_4857.jpg"))?.status).toBe(404);
  expect((await read("footage/thumbs/..%2Fledger.jpg"))?.status).toBe(404);
  // Without the archive bound there's nothing to read.
  expect((await footageResponse("footage/ledger", call("footage/ledger"), { media }))?.status).toBe(404);
});

test("a Pipeline piece names its film, or a shoot day before there's one, and can let go of it", async () => {
  const { bucket: media } = memoryMedia();
  const { bucket: archive } = memoryArchive();
  const send = async (path: string, method = "GET", body?: unknown) => {
    const response = await footageResponse(path, call(path, method, body), { media, archive });
    return { status: response?.status, data: (await response?.json()) as any };
  };
  const piece = "00000000-0000-4000-8000-000000000001";
  const other = "00000000-0000-4000-8000-000000000002";
  expect((await send("footage/links")).data).toEqual({ links: {} });
  await send(`footage/links/${piece}`, "PUT", { project: "013-maybe-later" });
  await send(`footage/links/${other}`, "PUT", { day: "2026-11-15" });
  expect((await send("footage/links")).data.links).toEqual({
    [piece]: { project: "013-maybe-later" },
    [other]: { day: "2026-11-15" },
  });
  // A film made since takes the shoot day's place; naming nothing lets go.
  await send(`footage/links/${other}`, "PUT", { project: "014-walk" });
  await send(`footage/links/${piece}`, "PUT", {});
  expect((await send("footage/links")).data.links).toEqual({ [other]: { project: "014-walk" } });
  for (const body of [{ project: "../x" }, { day: "15 Nov" }, { project: "a", day: "2026-11-15" }])
    expect((await send(`footage/links/${piece}`, "PUT", body)).status).toBe(400);
  expect((await send("footage/links/not-a-piece", "PUT", { day: "2026-11-15" })).status).toBe(400);
});

/** How the grade app's offload stands, as it sends it. */
const macReport = () => ({
  version: 1,
  at: "2026-11-23T12:00:00.000Z",
  running: true,
  lanes: {
    copy: {
      state: "waiting",
      speed: null,
      left: null,
      waiting: { for: "camera", why: "The camera isn't plugged in", until: "2026-11-23T12:05:00.000Z" },
      error: null,
    },
    send: { state: "running", speed: 887_500, left: 43_606, waiting: null, error: null },
  },
  camera: { mounted: false, clips: 0, bytes: 0, space: null },
  mac: { clips: 160, bytes: 38.7e9, space: { used: 454e9, total: 494.4e9 } },
  skipped: [{ lane: "send", name: "DJI_1.MP4", why: "doesn't read back" }],
  transcripts: { waiting: 3, failed: 1, toSend: 4, error: "no GPU" },
  kept: { days: ["2026-11-08"], clips: 45 },
  heard: { copy: null, send: { at: 1_763_900_000_000, error: null } },
});

test("the grade app's offload reaches the tab as checked, with how long ago it came", async () => {
  const { bucket } = memoryMedia();
  const read = async (at = Date.now()) => (await answer(bucket, "footage/mac", "GET", undefined, at)).json();
  expect(await read()).toEqual({ age: null, report: null, lanes: {} });
  const sent = await answer(bucket, "helper/footage/mac", "POST", { ...macReport(), extra: "x".repeat(100) });
  expect(sent.status).toBe(200);
  expect(await sent.json()).toEqual({ ok: true, paused: null, lanes: {} });
  const { age, report } = (await read(Date.now() + 3_000)) as { age: number; report: unknown };
  // Only what the tab reads is kept.
  expect(report).toEqual(macReport());
  expect(age).toBeGreaterThanOrEqual(2_900);
  expect(age).toBeLessThan(6_000);
  // Each report takes the last one's place.
  await answer(bucket, "helper/footage/mac", "POST", { ...macReport(), running: false });
  expect(((await read()) as { report: { running: boolean } }).report.running).toBe(false);
});

test("a report from a grade app that hasn't been restarted since is read without what it doesn't say", async () => {
  const { bucket } = memoryMedia();
  const { camera, mac, transcripts, heard: _, ...rest } = macReport();
  const older = {
    ...rest,
    startedAt: "2026-11-23T11:00:00.000Z",
    endedAt: null,
    lanes: {
      copy: { ...rest.lanes.copy, done: 120, total: 167, sentBytes: 28.8e9, totalBytes: 40.1e9 },
      send: { ...rest.lanes.send, done: 7, total: 167, sentBytes: 1.4e9, totalBytes: 40.1e9 },
    },
    camera: { mounted: camera.mounted, clips: camera.clips, bytes: camera.bytes },
    mac: { clips: mac.clips, bytes: mac.bytes },
    freed: { camera: 28.8e9, mac: 1.4e9 },
    transcripts: { ...transcripts, made: 12 },
    room: { free: 123e9, keepFree: 5e9 },
  };
  expect((await answer(bucket, "helper/footage/mac", "POST", older)).status).toBe(200);
  const { report } = (await (await answer(bucket, "footage/mac")).json()) as { report: unknown };
  expect(report).toEqual({
    ...macReport(),
    mac: { ...macReport().mac, space: null },
    heard: { copy: null, send: null },
  });
});

test("an offload report that's malformed or too big is refused, and the last one kept", async () => {
  const { bucket } = memoryMedia();
  await answer(bucket, "helper/footage/mac", "POST", macReport());
  const report = macReport();
  const wrong: unknown[] = [
    "[1,2]",
    "not json",
    "null",
    { ...report, version: 2 },
    { ...report, running: "yes" },
    { ...report, at: "yesterday" },
    { ...report, lanes: { copy: report.lanes.copy } },
    { ...report, lanes: { ...report.lanes, send: { ...report.lanes.send, state: "flying" } } },
    { ...report, lanes: { ...report.lanes, send: { ...report.lanes.send, left: -1 } } },
    { ...report, lanes: { ...report.lanes, send: { ...report.lanes.send, speed: "fast" } } },
    { ...report, lanes: { ...report.lanes, copy: { ...report.lanes.copy, waiting: { for: "camera", why: 3 } } } },
    { ...report, camera: { ...report.camera, clips: 1.5 } },
    { ...report, mac: { ...report.mac, space: { used: 500e9, total: 494.4e9 } } },
    { ...report, mac: { ...report.mac, space: { used: 1 } } },
    { ...report, skipped: [{ lane: "exports", name: "DJI_1.MP4", why: "x" }] },
    { ...report, skipped: Array.from({ length: 101 }, () => report.skipped[0]) },
    { ...report, kept: { days: ["x".repeat(21)], clips: 0 } },
    { ...report, transcripts: { ...report.transcripts, error: "x".repeat(601) } },
    { ...report, heard: { send: { at: "today", error: null } } },
    { ...report, kept: undefined },
  ];
  for (const body of wrong) {
    const response = await answer(bucket, "helper/footage/mac", "POST", body);
    expect(response.status).toBe(400);
  }
  // Over the cap, by what it says it is or by what it is.
  const big = JSON.stringify({ ...report, pad: "x".repeat(MAX_MAC_REPORT) });
  expect((await answer(bucket, "helper/footage/mac", "POST", big)).status).toBe(413);
  const declared = new Request(`${url}helper/footage/mac`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": String(MAX_MAC_REPORT + 1) },
    body: JSON.stringify(report),
  });
  expect((await footageResponse("helper/footage/mac", declared, { media: bucket }))?.status).toBe(413);
  expect(((await (await answer(bucket, "footage/mac")).json()) as { report: unknown }).report).toEqual(report);
  // Only the laptop sends it, and only the tab reads it.
  expect(await footageResponse("helper/footage/mac", call("helper/footage/mac"), { media: bucket })).toBeNull();
  expect(await footageResponse("footage/mac", call("footage/mac", "POST", report), { media: bucket })).toBeNull();
});

test("each switch's Start or Pause is the tab's to ask, and the grade app hears the last of each", async () => {
  const { bucket } = memoryMedia();
  const now = Date.parse("2026-11-23T10:42:00Z");
  const body = async (path: string, method = "GET", sent?: unknown, at = now) =>
    (await (await answer(bucket, path, method, sent, at)).json()) as Record<string, unknown>;
  expect(await body("helper/footage/lanes")).toEqual({ paused: null, lanes: {} });
  expect(await body("footage/lanes", "POST", { lane: "copy", want: "start" })).toEqual({
    lanes: { copy: { want: "start", at: now } },
  });
  // Asked again in the same moment, it's still later than the last.
  await body("footage/lanes", "POST", { lane: "copy", want: "pause" });
  await body("footage/lanes", "POST", { lane: "send", want: "start" }, now + 5_000);
  const lanes = { copy: { want: "pause", at: now + 1 }, send: { want: "start", at: now + 5_000 } };
  expect(await body("helper/footage/lanes")).toEqual({ paused: null, lanes });
  expect(await body("helper/footage/mac", "POST", macReport())).toEqual({ ok: true, paused: null, lanes });
  expect((await body("footage/mac")).lanes).toEqual(lanes);
  // With everything paused, it says that too.
  await body("footage/pause", "POST", {});
  expect(await body("helper/footage/lanes")).toEqual({ paused: { since: now }, lanes });
  for (const wrong of [{}, { lane: "exports", want: "start" }, { lane: "copy", want: "stop" }, "not json"])
    expect((await answer(bucket, "footage/lanes", "POST", wrong)).status).toBe(400);
  expect(await body("helper/footage/lanes")).toEqual({ paused: { since: now }, lanes });
  // The laptops can only hear them.
  const asLaptop = footageResponse("helper/footage/lanes", call("helper/footage/lanes", "POST", {}), { media: bucket });
  expect(await asLaptop).toBeNull();
});

test("pausing everything is the tab's to set, and every answer the laptops and the tab get says so", async () => {
  const { bucket } = memoryMedia();
  const now = Date.parse("2026-11-23T10:42:00Z");
  const body = async (path: string, method = "GET", sent?: unknown, at = now) =>
    (await (await answer(bucket, path, method, sent, at)).json()) as Record<string, unknown>;
  expect(await body("footage/pause")).toEqual({ paused: null });
  expect(await body("footage/pause", "POST", {})).toEqual({ paused: { since: now } });
  // Paused again later, it's paused since the first time.
  expect(await body("footage/pause", "POST", {}, now + 60_000)).toEqual({ paused: { since: now } });
  const paused = { since: now };
  // The helper asking and sending its status, the grade app sending its report, and the tab reading and saying it's open.
  expect(await body("helper/footage")).toEqual({ watching: false, paused });
  expect(await body("helper/footage", "POST", { state: "held" })).toEqual({ watching: false, paused });
  expect(await body("helper/footage/mac", "POST", macReport())).toEqual({ ok: true, paused, lanes: {} });
  expect((await body("footage")).paused).toEqual(paused);
  expect((await body("footage/watch", "POST", {})).paused).toEqual(paused);
  expect(await body("footage/pause", "DELETE")).toEqual({ paused: null });
  expect(await body("helper/footage")).toEqual({ watching: true, paused: null });
  expect((await body("footage")).paused).toBeNull();
  // The laptops can't set it: there's no such route on the pairing.
  const asLaptop = (method: string) =>
    footageResponse("helper/footage/pause", call("helper/footage/pause", method, {}), { media: bucket });
  expect(await asLaptop("POST")).toBeNull();
  expect(await asLaptop("DELETE")).toBeNull();
});
