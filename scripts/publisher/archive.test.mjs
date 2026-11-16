import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveProject, listArchived, projectContents, restoreProject, skipped } from "./archive.mjs";
import { archiveResponse } from "../../src/lib/publisher/archive.ts";
import { memoryArchive, memoryMedia } from "../../src/lib/publisher/memory-archive.ts";

/** The site's archive routes, answered in memory, as the laptop's fetch reaches them. */
function site() {
  const sqlite = new Database(":memory:");
  sqlite.exec(readFileSync("migrations/0002_publisher.sql", "utf8"));
  const db = {
    prepare: (sql) => {
      let values = [];
      const statement = {
        bind: (...v) => {
          values = v;
          return statement;
        },
        first: async () => sqlite.query(sql).get(...values),
        all: async () => ({ results: sqlite.query(sql).all(...values) }),
      };
      return statement;
    },
  };
  const archive = memoryArchive();
  const requests = [];
  const fetcher = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const rest = pathname.replace(/^\/api\/publisher\/helper\/archive\//, "");
    requests.push(`${init.method ?? "GET"} ${rest}`);
    expect(init.headers.Authorization).toBe("Bearer token");
    const headers = new Headers(init.headers);
    if (init.body !== undefined) headers.set("Content-Length", String(Buffer.byteLength(init.body)));
    const request = new Request(url, { method: init.method, headers, body: init.body });
    return archiveResponse(rest, request, { db, media: memoryMedia().bucket, archive: archive.bucket });
  };
  return { fetcher, archive, requests, auth: { origin: "https://post.kualta.dev", token: "token", fetcher } };
}

async function project(root) {
  const dir = join(root, "014-test-film");
  const files = {
    "film.html": "<!doctype html>",
    "assets/clip.mp4": "x".repeat(250),
    "zh/film.html": "<!doctype html lang=zh>",
    // The Chinese version's media is a clone of the original's: stored once.
    "zh/assets/clip.mp4": "x".repeat(250),
    "014-test-film.mp4": "rendered",
    ".film/id": "abc123\n",
    // Studio keeps this one empty.
    ".film/opened": "",
    ".film/cache/frames/1.png": "cached",
    "zh/.film/cache/look/2.png": "cached",
    ".DS_Store": "finder",
  };
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), body);
  }
  await utimes(join(dir, "film.html"), new Date(), new Date(1_700_000_000_000));
  // Git, which Studio's history is, needs some of its folders even empty.
  await mkdir(join(dir, ".film/history/refs/heads"), { recursive: true });
  return dir;
}

test("Studio's caches and Finder's files stay out", () => {
  expect(skipped(".film/cache")).toBe(true);
  expect(skipped("zh/.film/cache/look/2.png")).toBe(true);
  expect(skipped("assets/.DS_Store")).toBe(true);
  expect(skipped(".film/history/HEAD")).toBe(false);
  expect(skipped("assets/cache.mp4")).toBe(false);
});

test("a project is archived once per file, its caches cleared, and restored as it was", async () => {
  const root = await mkdtemp(join(tmpdir(), "archive-"));
  try {
    const dir = await project(root);
    const { auth, archive, requests } = site();
    // zh/.film holds only Studio's cache, which stays out, so it's kept as an empty folder.
    expect((await projectContents(dir)).folders).toEqual([".film/history/refs/heads", "zh/.film"]);
    expect((await projectContents(dir)).files.map((f) => f.path)).toEqual([
      ".film/id",
      ".film/opened",
      "014-test-film.mp4",
      "assets/clip.mp4",
      "film.html",
      "zh/assets/clip.mp4",
      "zh/film.html",
    ]);
    // Parts of 100 bytes send the 250-byte clip in three.
    const done = await archiveProject(dir, { ...auth, part: 100 });
    expect(done).toMatchObject({ name: "014-test-film", files: 7, sent: 15 + 250 + 23 + 8 + 7 + 0, cleared: 12 });
    expect(requests.filter((r) => r.startsWith("PUT uploads/"))).toHaveLength(3);
    expect([...archive.objects.keys()].filter((k) => k.startsWith("blobs/"))).toHaveLength(6);
    await expect(stat(join(dir, ".film/cache"))).rejects.toThrow();
    await expect(stat(join(dir, "zh/.film/cache"))).rejects.toThrow();
    expect(await readFile(join(dir, ".film/id"), "utf8")).toBe("abc123\n");

    // Archived again, nothing new goes up.
    expect((await archiveProject(dir, { ...auth, part: 100 })).sent).toBe(0);
    expect((await listArchived(auth)).map((p) => [p.name, p.versions])).toEqual([["014-test-film", 2]]);

    const dest = join(root, "restored");
    const back = await restoreProject("014-test-film", { ...auth, dest });
    expect(back.files).toBe(7);
    expect((await stat(join(dest, ".film/history/refs/heads"))).isDirectory()).toBe(true);
    for (const file of (await projectContents(dir)).files)
      expect(await readFile(join(dest, file.path), "utf8")).toBe(await readFile(file.abs, "utf8"));
    expect((await stat(join(dest, "film.html"))).mtimeMs).toBe(1_700_000_000_000);
    expect(await readdir(join(dest, "zh/assets"))).toEqual(["clip.mp4"]);
    // Never over a project that's there.
    await expect(restoreProject("014-test-film", { ...auth, dest })).rejects.toThrow("isn't empty");
    await expect(restoreProject("014-nothing", { ...auth, dest: join(root, "none") })).rejects.toThrow(
      "No such archived project",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a file that comes back different is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "archive-"));
  try {
    const dir = await project(root);
    const { auth, archive } = site();
    await archiveProject(dir, { ...auth, keepCache: true });
    await stat(join(dir, ".film/cache/frames/1.png"));
    const [key] = [...archive.objects.keys()].filter((k) => k.startsWith("blobs/"));
    archive.objects.get(key).bytes = new TextEncoder().encode("tampered");
    await expect(restoreProject("014-test-film", { ...auth, dest: join(root, "back") })).rejects.toThrow(
      "came back different",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
