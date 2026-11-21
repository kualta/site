import { expect, test } from "bun:test";
import { footageResponse, isWatched, MAX_STATUS, WATCH_TTL } from "./footage";
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
  expect(await ask(now)).toEqual({ watching: false });
  await answer(bucket, "footage/watch", "POST", {}, now);
  expect(await ask(now + 60_000)).toEqual({ watching: true });
  // A tab that stops saying so (closed without a word, the laptop asleep) lapses on its own.
  expect(await isWatched(bucket, now + WATCH_TTL + 1)).toBe(false);
  await answer(bucket, "footage/watch", "POST", {}, now);
  await answer(bucket, "footage/watch", "DELETE", undefined, now);
  expect(await ask(now)).toEqual({ watching: false });
});

test("the laptop's status reaches the tab as sent, with how long ago it came", async () => {
  const { bucket } = memoryMedia();
  const status = { at: 1, state: "uploading", current: { name: "DJI_x.mp4", sent: 5, size: 10 }, speed: 2_500_000 };
  expect(await (await answer(bucket, "helper/footage", "POST", status)).json()).toEqual({ watching: false });
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
});

test("before the laptop has said anything the tab reads no status", async () => {
  const { bucket } = memoryMedia();
  expect(await (await answer(bucket, "footage")).json()).toEqual({ watching: false, age: null, status: null });
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
