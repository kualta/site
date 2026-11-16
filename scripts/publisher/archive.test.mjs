import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveProject, cleanupProject, listArchived, projectContents, restoreProject, skipped } from "./archive.mjs";
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
  const media = memoryMedia();
  const requests = [];
  const fetcher = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const rest = pathname.replace(/^\/api\/publisher\/helper\/archive\//, "");
    requests.push(`${init.method ?? "GET"} ${rest}`);
    expect(init.headers.Authorization).toBe("Bearer token");
    const headers = new Headers(init.headers);
    if (init.body !== undefined) headers.set("Content-Length", String(Buffer.byteLength(init.body)));
    const request = new Request(url, { method: init.method, headers, body: init.body });
    return archiveResponse(rest, request, { db, media: media.bucket, archive: archive.bucket });
  };
  /** A post of `bytes` as its video, with each platform in the state given, as the composer queues it. */
  const post = async (bytes, states) => {
    const upload = crypto.randomUUID();
    await media.bucket.put(upload, bytes, { httpMetadata: { contentType: "video/mp4" } });
    const job = crypto.randomUUID();
    sqlite
      .query("INSERT INTO publisher_jobs (id, payload, created_at) VALUES (?, ?, ?)")
      .run(job, JSON.stringify({ kind: "video", media: [upload] }), Date.now());
    for (const [platform, state] of Object.entries(states))
      sqlite
        .query("INSERT INTO publisher_targets (id, job_id, platform, state) VALUES (?, ?, ?, ?)")
        .run(crypto.randomUUID(), job, platform, state);
    return job;
  };
  return { fetcher, archive, requests, post, auth: { origin: "https://post.kualta.dev", token: "token", fetcher } };
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

/** The grade app's export folder: the clip the project copied, one exported again since, and one no project used. */
async function exports(root) {
  const dir = join(root, "Exported");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "clip.mp4"), "x".repeat(250));
  await writeFile(join(dir, "regraded.mp4"), "graded again");
  await writeFile(join(dir, "unused.mp4"), "not in any film");
  return dir;
}

test("a posted film's project and the exported clips the archive holds come off the laptop, and come back", async () => {
  const root = await mkdtemp(join(tmpdir(), "archive-"));
  try {
    const dir = await project(root);
    await writeFile(join(dir, "assets/regraded.mp4"), "graded once");
    const exported = await exports(root);
    const { auth, post } = site();
    const job = await post("rendered", { instagram: "succeeded", tiktok: "queued", x: "failed" });

    const plan = await cleanupProject(dir, { ...auth, exported, dryRun: true });
    expect(plan.clips.map((clip) => clip.name).sort()).toEqual(["clip.mp4", "regraded.mp4"]);
    await stat(join(dir, "film.html"));

    const done = await cleanupProject(dir, { ...auth, exported });
    expect(done.posts.map((p) => p.job)).toEqual([job]);
    expect(done.posts[0].platforms).toContainEqual({ platform: "tiktok", state: "queued" });
    expect(done.deleted.map((clip) => clip.name)).toEqual(["clip.mp4"]);
    // Exported again after the project copied it: those bytes aren't in the archive.
    expect(done.kept.map((clip) => clip.name)).toEqual(["regraded.mp4"]);
    expect((await readdir(exported)).sort()).toEqual(["regraded.mp4", "unused.mp4"]);
    await expect(stat(dir)).rejects.toThrow();

    const back = await restoreProject("014-test-film", { ...auth, dest: join(root, "back") });
    expect(await readFile(join(back.dest, "assets/clip.mp4"), "utf8")).toBe("x".repeat(250));
    expect(await readFile(join(back.dest, "014-test-film.mp4"), "utf8")).toBe("rendered");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a film no post went out as stays, unless the owner vouches for it", async () => {
  const root = await mkdtemp(join(tmpdir(), "archive-"));
  try {
    const dir = await project(root);
    const exported = await exports(root);
    const { auth, post, requests } = site();
    // Every destination failed: it never went out.
    await post("rendered", { instagram: "failed", youtube: "failed" });
    // Another film's post.
    await post("another render", { instagram: "succeeded" });

    const kept = await cleanupProject(dir, { ...auth, exported });
    expect(kept.kept).toContain("014-test-film.mp4");
    expect(requests.filter((r) => !r.endsWith("posted"))).toEqual([]);
    await stat(join(dir, "film.html"));
    expect((await readdir(exported)).length).toBe(3);

    const vouched = await cleanupProject(dir, { ...auth, exported, posted: true });
    expect(vouched.posts).toEqual([]);
    expect(vouched.deleted.map((clip) => clip.name)).toEqual(["clip.mp4"]);
    await expect(stat(dir)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("only a project folder is taken, and the posted check wants MD5s", async () => {
  const root = await mkdtemp(join(tmpdir(), "archive-"));
  try {
    const dir = await project(root);
    const { auth, fetcher } = site();
    await expect(cleanupProject(join(dir, "zh"), auth)).rejects.toThrow("isn't an OpenFilm project");
    await expect(cleanupProject(join(dir, "assets"), auth)).rejects.toThrow("isn't an OpenFilm project");
    const response = await fetcher("https://post.kualta.dev/api/publisher/helper/archive/posted", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({ md5s: ["not a hash"] }),
    });
    expect(response.status).toBe(400);
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
