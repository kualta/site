import { describe, expect, test } from "bun:test";
import {
  type ArchiveReader,
  archiveTabResponse,
  byteRange,
  latestVersion,
  LISTING_TTL,
  type ResponseCache,
} from "./archive-tab";

const url = "https://post.kualta.dev/api/publisher/";
const hex = (n: number) => n.toString(16).padStart(64, "0");

/** The archive bucket as R2 answers the tab: prefixes, delimiters, startAfter and ranges, counting what it's asked. */
function archive(objects = new Map<string, Uint8Array>()) {
  const asked = { list: 0, get: 0, head: 0, listed: 0, read: 0 };
  const reader: ArchiveReader = {
    async list({ prefix, delimiter, startAfter, cursor }) {
      asked.list++;
      const keys = [...objects.keys()]
        .filter((key) => key.startsWith(prefix) && (!startAfter || key > startAfter))
        .sort();
      const prefixes = new Set<string>();
      const listed: string[] = [];
      for (const key of keys) {
        const cut = delimiter ? key.indexOf(delimiter, prefix.length) : -1;
        if (cut >= 0) prefixes.add(key.slice(0, cut + 1));
        else listed.push(key);
      }
      // A page at a time, as R2 does, so a long listing takes several.
      const from = Number(cursor ?? 0);
      const page = listed.slice(from, from + 1000);
      asked.listed += page.length;
      return {
        objects: page.map((key) => ({ key })),
        delimitedPrefixes: from ? [] : [...prefixes],
        truncated: from + 1000 < listed.length,
        cursor: String(from + 1000),
      };
    },
    async get(key, options) {
      asked.get++;
      const bytes = objects.get(key);
      if (!bytes) return null;
      const part = options?.range
        ? bytes.slice(options.range.offset, options.range.offset + options.range.length)
        : bytes.slice();
      asked.read += part.byteLength;
      return { body: new Response(part).body as ReadableStream, size: bytes.byteLength };
    },
    async head(key) {
      asked.head++;
      const bytes = objects.get(key);
      return bytes ? { size: bytes.byteLength } : null;
    },
  };
  const put = (key: string, body: string | Uint8Array) =>
    objects.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body);
  return { reader, objects, asked, put };
}

/** The Worker's cache, honouring max-age on a clock the test moves. */
function memoryCache() {
  const clock = { now: 0 };
  const stored = new Map<string, { body: string; headers: Headers; until: number }>();
  const cache: ResponseCache = {
    async match(key) {
      const hit = stored.get(key);
      if (!hit || hit.until <= clock.now) return undefined;
      return new Response(hit.body, { headers: hit.headers });
    },
    async put(key, response) {
      const age = Number(/max-age=(\d+)/.exec(response.headers.get("Cache-Control") ?? "")?.[1] ?? 0);
      stored.set(key, { body: await response.text(), headers: response.headers, until: clock.now + age * 1000 });
    },
  };
  return { cache, clock, stored };
}

const get = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  new Request(url + path, { method, headers });
async function answer(
  reader: ArchiveReader,
  path: string,
  init: { headers?: Record<string, string>; method?: string; cache?: ResponseCache; now?: number } = {},
) {
  const response = await archiveTabResponse(
    path,
    get(path, init.headers, init.method),
    { archive: reader, cache: init.cache },
    init.now,
  );
  if (!response) throw new Error(`${path} wasn't answered`);
  return response;
}

/** A shoot day's manifest as the grade app files it: its clips, a transcript for some, and one put aside. */
function shootDay(clips: number, transcribed = clips) {
  const files = [];
  for (let i = 0; i < clips; i++) {
    const stem = `DJI_20261108${String(100000 + i * 37).slice(-6)}_${String(i + 1).padStart(4, "0")}_D`;
    files.push({
      path: `assets/${stem}.MP4`,
      sha256: hex(i + 1),
      size: 2_000_000_000 + i,
      mtime: 1_762_600_000_000 + i,
    });
    if (i < transcribed) {
      files.push({ path: `transcripts/${stem}.vtt`, sha256: hex(10_000 + i), size: 900, mtime: 1 });
      files.push({ path: `transcripts/${stem}.json`, sha256: hex(20_000 + i), size: 40_000, mtime: 1 });
    }
  }
  files.push({ path: "replaced/abcdef012345/DJI_20261108100000_0001_D.MP4", sha256: hex(99_999), size: 10, mtime: 1 });
  // Nor is a camera proxy, should one be filed.
  files.push({ path: "assets/DJI_20261108100000_0001_D.LRF", sha256: hex(99_998), size: 10, mtime: 1 });
  return { name: "_originals-2026-11-08", archivedAt: "", files, folders: [] };
}

describe("files, by hash, with Range", () => {
  const bytes = new Uint8Array(1000).map((_, i) => i % 251);
  const sha = hex(7);
  const setup = () => {
    const a = archive();
    a.put(`blobs/${sha}`, bytes);
    return a;
  };
  const path = `archive/files/${sha}/DJI_20261108122204_0086_D.MP4`;

  test("a whole file, said to take ranges", async () => {
    const { reader, asked } = setup();
    const response = await answer(reader, path);
    expect(response.status).toBe(200);
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Content-Length")).toBe("1000");
    expect(response.headers.get("Content-Type")).toBe("video/mp4");
    expect(response.headers.get("Content-Range")).toBeNull();
    expect(response.headers.get("ETag")).toBe(`"${sha}"`);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(asked.read).toBe(1000);
  });

  test("a part, a part to the end, and the last bytes, each 206 with its Content-Range, and only those bytes read", async () => {
    for (const [header, offset, end] of [
      ["bytes=100-199", 100, 199],
      ["bytes=990-", 990, 999],
      ["bytes=-10", 990, 999],
      // Past the end is cut at it; a suffix longer than the file is the file.
      ["bytes=900-5000", 900, 999],
      ["bytes=-5000", 0, 999],
      ["bytes=0-0", 0, 0],
    ] as const) {
      const { reader, asked } = setup();
      const response = await answer(reader, path, { headers: { Range: header } });
      expect(response.status).toBe(206);
      expect(response.headers.get("Content-Range")).toBe(`bytes ${offset}-${end}/1000`);
      expect(response.headers.get("Content-Length")).toBe(String(end - offset + 1));
      expect(response.headers.get("Accept-Ranges")).toBe("bytes");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.slice(offset, end + 1));
      expect(asked.read).toBe(end - offset + 1);
    }
  });

  test("a range that can't be served is 416 with the file's size, and reads nothing", async () => {
    for (const header of [
      "bytes=1000-",
      "bytes=5000-6000",
      "bytes=-0",
      "bytes=200-100",
      "bytes=abc",
      "bytes=-",
      "bytes=0-1,5-9",
    ]) {
      const { reader, asked } = setup();
      const response = await answer(reader, path, { headers: { Range: header } });
      expect(response.status).toBe(416);
      expect(response.headers.get("Content-Range")).toBe("bytes */1000");
      expect(asked.get).toBe(0);
    }
  });

  test("a unit other than bytes is ignored, as HTTP says", async () => {
    const { reader } = setup();
    const response = await answer(reader, path, { headers: { Range: "items=0-5" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe("1000");
  });

  test("HEAD says what GET would, without reading", async () => {
    const { reader, asked } = setup();
    const response = await answer(reader, path, { method: "HEAD", headers: { Range: "bytes=0-1" } });
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 0-1/1000");
    expect(asked.get).toBe(0);
  });

  test("each kind of file is typed by its name, a missing one is 404, and a bad hash or name 400", async () => {
    const { reader, put } = setup();
    put(`blobs/${hex(8)}`, "WEBVTT\n");
    expect((await answer(reader, `archive/files/${hex(8)}/DJI_x.vtt`)).headers.get("Content-Type")).toBe(
      "text/vtt; charset=utf-8",
    );
    expect((await answer(reader, `archive/files/${sha}/IMG_4857.MOV`)).headers.get("Content-Type")).toBe(
      "video/quicktime",
    );
    expect((await answer(reader, `archive/files/${sha}/dlog2-opendrt-colorful.cube`)).headers.get("Content-Type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect((await answer(reader, `archive/files/${hex(9)}/DJI_x.MP4`)).status).toBe(404);
    expect((await answer(reader, "archive/files/nothex/DJI_x.MP4")).status).toBe(400);
    expect((await answer(reader, `archive/files/${sha}/..%2Fx`)).status).toBe(400);
    expect(await archiveTabResponse(path, get(path, {}, "DELETE"), { archive: reader })).toBeNull();
  });

  test("an empty file is empty, and has no range", async () => {
    const { reader, put } = setup();
    put(`blobs/${hex(10)}`, "");
    const whole = await answer(reader, `archive/files/${hex(10)}/empty.json`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("Content-Length")).toBe("0");
    expect(
      (await answer(reader, `archive/files/${hex(10)}/empty.json`, { headers: { Range: "bytes=0-" } })).status,
    ).toBe(416);
  });

  test("byteRange", () => {
    expect(byteRange(null, 10)).toBeNull();
    expect(byteRange("bytes=0-", 10)).toEqual({ offset: 0, length: 10 });
    expect(byteRange("Bytes = 2-3", 10)).toEqual({ offset: 2, length: 2 });
    expect(byteRange("bytes=-3", 10)).toEqual({ offset: 7, length: 3 });
    expect(byteRange("bytes=10-", 10)).toBe("unsatisfiable");
  });
});

describe("listings", () => {
  const manifestKey = (day: string, at: string) => `projects/_originals-${day}/${at}.json`;
  const now = Date.parse("2026-11-23T12:00:00Z");

  test("the days are read from the projects' names alone, newest first", async () => {
    const { reader, put, asked } = archive();
    put(manifestKey("2026-11-08", "2026-11-16T01:00:00.000Z"), JSON.stringify(shootDay(2)));
    put(manifestKey("2026-11-08", "2026-11-16T02:00:00.000Z"), JSON.stringify(shootDay(3)));
    put(manifestKey("2026-11-11", "2026-11-17T02:00:00.000Z"), JSON.stringify(shootDay(1)));
    put("projects/_graded-2026-11-11/2026-11-17T02:00:00.000Z.json", "{}");
    put("projects/_settings/2026-11-17T02:00:00.000Z.json", "{}");
    put("projects/013-maybe-later/2026-11-17T02:00:00.000Z.json", "{}");
    const response = await answer(reader, "archive/days");
    expect(await response.json()).toEqual({ days: ["2026-11-11", "2026-11-08"] });
    // No manifest was listed or read to say so.
    expect(asked.listed).toBe(0);
    expect(asked.get).toBe(0);
  });

  test("a day lists its latest manifest's clips, with their transcripts, compactly", async () => {
    const { reader, put } = archive();
    put(manifestKey("2026-11-08", "2026-11-16T01:00:00.000Z"), JSON.stringify(shootDay(2)));
    // Saved after every clip: the latest has them all, and 18 of the 230 clips aren't transcribed yet.
    const latest = shootDay(230, 212);
    put(manifestKey("2026-11-08", "2026-11-22T23:59:00.000Z"), JSON.stringify(latest));
    const response = await answer(reader, "archive/days/2026-11-08", { now });
    expect(response.headers.get("Content-Type")).toBe("application/json");
    const text = await response.text();
    const day = JSON.parse(text);
    expect(day.day).toBe("2026-11-08");
    expect(day.at).toBe("2026-11-22T23:59:00.000Z");
    expect(day.clips).toHaveLength(230);
    expect(day.clips[0]).toEqual({
      file: "DJI_20261108100000_0001_D.MP4",
      sha256: hex(1),
      size: 2_000_000_000,
      vtt: hex(10_000),
    });
    expect(day.clips.filter((clip: { vtt?: string }) => clip.vtt)).toHaveLength(212);
    // What was put aside isn't a clip of the day, nor a proxy.
    expect(day.clips.some((clip: { sha256: string }) => [hex(99_999), hex(99_998)].includes(clip.sha256))).toBe(false);
    // About 200 bytes a clip, two hashes of them: under half the manifest, which also lists the word timings.
    expect(text.length).toBeLessThan(230 * 210);
    expect(text.length).toBeLessThan(JSON.stringify(latest).length / 2);
  });

  test("the latest version is found without listing every one", async () => {
    const { reader, put, asked } = archive();
    // 1,500 versions over three weeks, the last the day before.
    for (let i = 0; i < 1500; i++)
      put(manifestKey("2026-11-08", new Date(now - 22 * 86_400_000 + i * 1_200_000).toISOString()), "{}");
    put(manifestKey("2026-11-08", "2026-11-22T13:00:00.000Z"), "{}");
    const latest = await latestVersion(reader, "_originals-2026-11-08", now);
    expect(latest?.at).toBe("2026-11-22T13:00:00.000Z");
    expect(asked.listed).toBeLessThan(100);
    // One older than a year is still found, by listing them all.
    const old = archive();
    old.put("projects/_settings/2024-01-01T00:00:00.000Z.json", "{}");
    expect((await latestVersion(old.reader, "_settings", now))?.at).toBe("2024-01-01T00:00:00.000Z");
    expect(await latestVersion(old.reader, "_originals-2026-11-09", now)).toBeNull();
  });

  test("listings are kept in the Worker's cache, then read again", async () => {
    const { reader, put, asked } = archive();
    const { cache, clock } = memoryCache();
    put(manifestKey("2026-11-08", "2026-11-16T01:00:00.000Z"), JSON.stringify(shootDay(2)));
    put(
      "projects/_settings/2026-11-16T01:00:00.000Z.json",
      JSON.stringify({
        files: [
          { path: "grades.json", sha256: hex(5), size: 30, mtime: 1 },
          { path: "looks/dlog2/aces.cube", sha256: hex(6), size: 9, mtime: 1 },
        ],
      }),
    );
    const read = async (path: string) => {
      const response = await answer(reader, path, { cache, now });
      expect(response.headers.get("Cache-Control")).toBe("private, max-age=60");
      return response.json();
    };
    for (const path of ["archive/days", "archive/days/2026-11-08", "archive/settings"]) {
      const first = await read(path);
      const before = { ...asked };
      expect(await read(path)).toEqual(first);
      // Answered from the cache: the archive wasn't asked anything.
      expect(asked).toEqual(before);
    }
    expect(await read("archive/settings")).toEqual({
      at: "2026-11-16T01:00:00.000Z",
      files: { "grades.json": { sha256: hex(5), size: 30 }, "looks/dlog2/aces.cube": { sha256: hex(6), size: 9 } },
    });
    // A clip offloaded meanwhile shows once the cached listing lapses.
    put(manifestKey("2026-11-08", "2026-11-16T02:00:00.000Z"), JSON.stringify(shootDay(3)));
    expect((await read("archive/days/2026-11-08")).clips).toHaveLength(2);
    clock.now += LISTING_TTL * 1000;
    expect((await read("archive/days/2026-11-08")).clips).toHaveLength(3);
  });

  test("a day with nothing archived is empty, and a bad day is refused", async () => {
    const { reader } = archive();
    expect(await (await answer(reader, "archive/days/2026-11-09", { now })).json()).toEqual({
      day: "2026-11-09",
      at: null,
      clips: [],
    });
    expect((await answer(reader, "archive/days/yesterday")).status).toBe(400);
    expect(await (await answer(reader, "archive/settings", { now })).json()).toEqual({ at: null, files: {} });
    expect(await archiveTabResponse("archive/elsewhere", get("archive/elsewhere"), { archive: reader })).toBeNull();
  });
});
