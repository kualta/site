import { expect, mock, test } from "bun:test";

// The publisher's API as the site runs it, with the owner's sign-in and the Worker's bindings stood in for: the
// archive's files are the owner's alone, and the laptop's pairing doesn't reach them.
const owner = { allowed: false };
const sha = "a".repeat(64);
const blob = new Uint8Array(100).map((_, i) => i);
const archive = {
  async head(key: string) {
    return key === `blobs/${sha}` ? { size: blob.byteLength } : null;
  },
  async get(key: string, options?: { range?: { offset: number; length: number } }) {
    if (key !== `blobs/${sha}`) return null;
    const { offset = 0, length = blob.byteLength } = options?.range ?? {};
    return { body: new Response(blob.slice(offset, offset + length)).body, size: blob.byteLength };
  },
  async list() {
    return { objects: [], truncated: false };
  },
};
mock.module("cloudflare:workers", () => ({
  env: {
    NEWSLETTER_DB: {
      // A pairing token never matches: the helper's routes are refused.
      prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }) }) }),
    },
    PUBLISHER_MEDIA: { get: async () => null, head: async () => null },
    ARCHIVE: archive,
  },
  waitUntil: () => {},
}));
// Bun keeps a module's stand-in for every test file after this one: the rest of it stays as it is.
const auth = await import("@/lib/publisher/auth");
mock.module("@/lib/publisher/auth", () => ({
  ...auth,
  publisherSession: async () => ({ session: { setCookies: [] }, allowed: owner.allowed }),
}));
const { ALL } = await import("../../pages/api/publisher/[...path]");

const call = (path: string, headers: Record<string, string> = {}) =>
  ALL({
    request: new Request(`https://post.kualta.dev/api/publisher/${path}`, { headers }),
    params: { path },
  } as never) as Promise<Response>;

test("the archive's files are streamed to the owner alone, a range at a time", async () => {
  const path = `archive/files/${sha}/DJI_20261108122204_0086_D.MP4`;
  owner.allowed = false;
  expect((await call(path, { Range: "bytes=0-9" })).status).toBe(403);
  expect((await call("archive/settings")).status).toBe(403);
  // The laptop's pairing token opens helper/ routes only, and this isn't one.
  expect((await call(path, { Authorization: `Bearer ${"f".repeat(64)}` })).status).toBe(403);
  expect((await call(`helper/${path}`, { Authorization: `Bearer ${"f".repeat(64)}` })).status).toBe(401);

  owner.allowed = true;
  const part = await call(path, { Range: "bytes=10-19" });
  expect(part.status).toBe(206);
  expect(part.headers.get("Content-Range")).toBe("bytes 10-19/100");
  expect(part.headers.get("Accept-Ranges")).toBe("bytes");
  expect(new Uint8Array(await part.arrayBuffer())).toEqual(blob.slice(10, 20));
  expect((await call(path, { Range: "bytes=100-" })).status).toBe(416);
  expect((await call(`archive/files/${"b".repeat(64)}/DJI_x.MP4`)).status).toBe(404);
  expect(await (await call("archive/settings")).json()).toEqual({ at: null, files: {} });
});
