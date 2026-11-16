import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import {
  archivedMedia,
  archivePost,
  archiveRecentPosts,
  archiveResponse,
  archiveUploads,
  withArchive,
} from "./archive";
import { memoryArchive, memoryMedia } from "./memory-archive";
import { UPLOAD_LIFETIME } from "./schedule";
import type { NewsletterDB } from "../newsletter/types";

function database() {
  const sqlite = new Database(":memory:");
  sqlite.exec(readFileSync("migrations/0002_publisher.sql", "utf8"));
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...v: unknown[]) {
          values = v;
          return statement;
        },
        async first() {
          return sqlite.query(sql).get(...(values as never[]));
        },
        async all() {
          return { results: sqlite.query(sql).all(...(values as never[])) };
        },
      };
      return statement;
    },
  } as unknown as NewsletterDB;
  return { db, sqlite };
}

const id = () => crypto.randomUUID();
const text = async (object: { body: ReadableStream } | null) => (object ? new Response(object.body).text() : null);
const sha256 = async (body: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");

describe("a queued post's uploads", () => {
  test("are read from the archive once the media bucket has expired them", async () => {
    const media = memoryMedia();
    const archive = memoryArchive();
    const [kept, lost, other] = [id(), id(), id()];
    await media.bucket.put(kept, "video", { httpMetadata: { contentType: "video/mp4" } });
    await media.bucket.put(lost, "cover", { httpMetadata: { contentType: "image/jpeg" } });
    await media.bucket.put(other, "draft upload", { httpMetadata: { contentType: "video/mp4" } });
    expect(await archiveUploads(media.bucket, archive.bucket, [kept, lost, kept])).toEqual({ copied: 2, gone: 0 });
    // Already archived ones aren't copied again; one that's gone can't be.
    media.objects.delete(lost);
    expect(await archiveUploads(media.bucket, archive.bucket, [kept, lost, id()])).toEqual({ copied: 0, gone: 1 });
    const bucket = withArchive(media.bucket, archive.bucket);
    expect(await text(await bucket.get(lost))).toBe("cover");
    expect((await bucket.get(lost))?.httpMetadata?.contentType).toBe("image/jpeg");
    expect(await bucket.head(lost)).toBeTruthy();
    expect(await bucket.head(id())).toBeNull();
    // Keys that aren't uploads (drafts) are the media bucket's alone.
    expect(await bucket.get("drafts/x.json")).toBeNull();
    expect(await archivedMedia(archive.bucket, [kept, lost, other, "drafts/x"])).toEqual(new Set([kept, lost]));
    // Deleting an upload deletes its copy.
    await bucket.delete([kept, other]);
    expect(media.objects.has(kept)).toBe(false);
    expect(archive.objects.has(`media/${kept}`)).toBe(false);
    expect(await bucket.head(lost)).toBeTruthy();
    // Without an archive nothing changes.
    expect(withArchive(media.bucket, undefined)).toBe(media.bucket);
  });

  test("a post's uploads are archived, and a sweep archives the posts of the last 31 days", async () => {
    const { db, sqlite } = database();
    const media = memoryMedia();
    const archive = memoryArchive();
    const [recent, old] = [id(), id()];
    const [video, zhVideo, cover, stale] = [id(), id(), id(), id()];
    for (const upload of [video, zhVideo, cover, stale])
      await media.bucket.put(upload, upload, { httpMetadata: { contentType: "video/mp4" } });
    const now = Date.now();
    sqlite
      .query("INSERT INTO publisher_jobs VALUES (?,?,?)")
      .run(recent, JSON.stringify({ kind: "video", media: [video], cover, zh: { video: zhVideo } }), now - 86_400_000);
    sqlite
      .query("INSERT INTO publisher_jobs VALUES (?,?,?)")
      .run(old, JSON.stringify({ kind: "video", media: [stale] }), now - UPLOAD_LIFETIME - 1);
    expect(await archivePost(db, media.bucket, archive.bucket, recent)).toEqual({ copied: 3, gone: 0 });
    expect(await archivePost(db, media.bucket, archive.bucket, id())).toEqual({ copied: 0, gone: 0 });
    archive.objects.clear();
    expect(await archiveRecentPosts(db, media.bucket, archive.bucket, now)).toEqual({ posts: 1, copied: 3, gone: 0 });
    expect([...archive.objects.keys()].sort()).toEqual([video, zhVideo, cover].map((u) => `media/${u}`).sort());
  });
});

describe("the laptop's archive requests", () => {
  const setup = () => {
    const { db } = database();
    const media = memoryMedia();
    const archive = memoryArchive();
    const call = async (rest: string, init: RequestInit & { bytes?: string } = {}) => {
      const { bytes, ...rest_ } = init;
      const headers = new Headers(init.headers);
      if (bytes !== undefined) headers.set("Content-Length", String(new TextEncoder().encode(bytes).byteLength));
      const request = new Request(`https://post.kualta.dev/api/publisher/helper/archive/${rest}`, {
        ...rest_,
        headers,
        body: bytes ?? init.body,
      });
      // The route hands over the path without its query, as Astro's [...path] does.
      const path = rest.split("?")[0];
      const response = await archiveResponse(path, request, { db, media: media.bucket, archive: archive.bucket });
      return { status: response.status, response };
    };
    const body = async (rest: string, init: RequestInit & { bytes?: string } = {}) => {
      const { status, response } = await call(rest, init);
      return { status, data: (await response.json()) as any };
    };
    return { call, body, archive };
  };

  test("files go up whole or in parts, checked against their hash, and come back", async () => {
    const { call, body, archive } = setup();
    const [a, b] = [await sha256("hello"), await sha256("a larger file")];
    expect((await body("missing", { method: "POST", body: JSON.stringify({ blobs: [a, b, a] }) })).data).toEqual({
      missing: [a, b].sort(),
    });
    expect((await body("missing", { method: "POST", body: JSON.stringify({ blobs: ["../x"] }) })).status).toBe(400);
    // A file whose bytes don't match its hash is refused.
    expect((await body(`blobs/${a}`, { method: "PUT", bytes: "goodbye" })).data).toEqual({
      error: "The file doesn't match its hash",
    });
    expect((await call(`blobs/${a}`, { method: "PUT", bytes: "hello" })).status).toBe(201);
    expect((await body(`blobs/${a}`, { method: "PUT", bytes: "" })).status).toBe(400);
    // An empty file is a file too.
    const empty = await sha256("");
    expect((await call(`blobs/${empty}`, { method: "PUT", bytes: "" })).status).toBe(201);
    expect(await (await call(`blobs/${empty}`)).response.text()).toBe("");
    const { data } = await body("uploads", { method: "POST", body: JSON.stringify({ blob: b }) });
    const upload = encodeURIComponent(data.upload);
    const parts = [];
    for (const [n, chunk] of ["a larg", "er fil", "e"].entries())
      parts.push((await body(`uploads/${b}/${n + 1}?upload=${upload}`, { method: "PUT", bytes: chunk })).data);
    expect(
      (await body(`uploads/${b}/complete`, { method: "POST", body: JSON.stringify({ upload: data.upload, parts }) }))
        .status,
    ).toBe(200);
    expect((await body("missing", { method: "POST", body: JSON.stringify({ blobs: [a, b] }) })).data.missing).toEqual(
      [],
    );
    expect(await (await call(`blobs/${b}`)).response.text()).toBe("a larger file");
    expect((await call(`blobs/${await sha256("nothing")}`)).status).toBe(404);
    // A part-sent file can be given up.
    const second = (await body("uploads", { method: "POST", body: JSON.stringify({ blob: a }) })).data.upload;
    expect(archive.uploads.size).toBe(1);
    expect((await call(`uploads/${a}?upload=${encodeURIComponent(second)}`, { method: "DELETE" })).status).toBe(200);
    expect(archive.uploads.size).toBe(0);
  });

  test("a manifest is kept only once every file it names is archived, and the latest is read back", async () => {
    const { call, body } = setup();
    const hash = await sha256("film");
    const manifest = { files: [{ path: "film.html", sha256: hash, size: 4, mtime: 1_700_000_000_000 }] };
    const put = (name: string, value: unknown) =>
      body(`projects/${name}`, { method: "PUT", body: JSON.stringify(value) });
    expect((await put("013-maybe-later", manifest)).data.error).toContain("aren't in the archive");
    await call(`blobs/${hash}`, { method: "PUT", bytes: "film" });
    for (const path of ["/etc/passwd", "a/../../b", ""])
      expect((await put("013-maybe-later", { files: [{ ...manifest.files[0], path }] })).status).toBe(400);
    expect((await put("not a name!", manifest)).status).toBe(400);
    const first = await put("013-maybe-later", manifest);
    expect(first.status).toBe(201);
    expect(first.data).toMatchObject({ files: 1, bytes: 4 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const changed = { files: [...manifest.files, { path: "zh/film.html", sha256: hash, size: 4, mtime: 1 }] };
    await put("013-maybe-later", changed);
    const projects = (await body("projects")).data.projects;
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ name: "013-maybe-later", versions: 2 });
    expect((await body("projects/013-maybe-later")).data.files).toHaveLength(2);
    const at = first.data.key
      .split("/")
      .pop()
      .replace(/\.json$/, "");
    expect((await body(`projects/013-maybe-later?at=${encodeURIComponent(at)}`)).data.files).toHaveLength(1);
    expect((await body("projects/014-nothing")).status).toBe(404);
  });

  test("the media sweep archives recent posts' uploads", async () => {
    const { body } = setup();
    expect((await body("media", { method: "POST" })).data).toEqual({ posts: 0, copied: 0, gone: 0 });
    expect((await body("nothing")).status).toBe(404);
  });
});
