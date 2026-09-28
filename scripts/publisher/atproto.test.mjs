import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { publishAtproto } from "./atproto.mjs";

test("video grants uploadBlob to the account PDS, waits for a blob, then creates the post", async () => {
  const dir = await mkdtemp(join(tmpdir(), "publisher-atproto-"));
  const file = join(dir, "video.mp4");
  await writeFile(file, "test bytes");
  const grants = [],
    records = [],
    urls = [];
  const blob = {
    $type: "blob",
    mimeType: "video/mp4",
    size: 10,
    ref: { $link: "test" },
  };
  const agent = {
    did: "did:plc:jhvnnnd3adml7t6anu3ay7ip",
    pdsUrl: new URL("https://owner.pds.example"),
    com: {
      atproto: {
        server: {
          getServiceAuth: async (args) => {
            grants.push(args);
            return { data: { token: "test-token" } };
          },
        },
        repo: {
          createRecord: async (args) => {
            records.push(args);
          },
        },
      },
    },
  };
  let call = 0;
  try {
    const result = await publishAtproto(
      "bluesky",
      { agent, pdsUrl: new URL("https://owner.pds.example") },
      [file],
      [{ width: 64, height: 48 }],
      {
        id: crypto.randomUUID(),
        kind: "video",
        caption: "Hello",
        alt: "A scene",
      },
      {
        agent,
        wait: async () => {},
        fetcher: async (url) => {
          urls.push(String(url));
          return Response.json(
            call++ === 0 ? { jobId: "job", state: "JOB_STATE_CREATED" } : { jobStatus: { blob } },
          );
        },
      },
    );
    expect(grants[0].aud).toBe("did:web:owner.pds.example");
    expect(grants[0].lxm).toBe("com.atproto.repo.uploadBlob");
    expect(urls).toHaveLength(2);
    expect(records).toHaveLength(1);
    expect(records[0].record.embed.video).toEqual(blob);
    expect(result.url).toContain("https://bsky.app/profile/");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Grain writes ordered photos and gallery links atomically with stable TID keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "publisher-grain-"));
  const file = join(dir, "photo.jpg");
  await writeFile(file, "test bytes");
  const batches = [];
  const owner = "did:plc:jhvnnnd3adml7t6anu3ay7ip";
  const agent = {
    did: owner,
    uploadBlob: async () => ({
      data: { blob: { $type: "blob", mimeType: "image/jpeg", size: 10 } },
    }),
    com: {
      atproto: { repo: { applyWrites: async (args) => batches.push(args) } },
    },
  };
  const post = {
    id: crypto.randomUUID(),
    kind: "photo",
    title: "Mountains",
    caption: "Hello",
    alt: "A scene",
  };
  try {
    const publish = () =>
      publishAtproto(
        "grain",
        { agent, pdsUrl: new URL("https://owner.pds.example") },
        [file, file],
        [
          { width: 64, height: 48 },
          { width: 48, height: 64 },
        ],
        post,
        { agent },
      );
    const result = await publish();
    expect(batches).toHaveLength(1);
    const { writes } = batches[0];
    expect(writes).toHaveLength(5);
    for (const write of writes)
      expect(write.rkey).toMatch(/^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/);
    const [gallery, photo1, item1, photo2, item2] = writes;
    expect(photo1.rkey).not.toBe(photo2.rkey);
    expect(item1.value.gallery).toBe(`at://${owner}/social.grain.gallery/${gallery.rkey}`);
    expect(item1.value.item).toBe(`at://${owner}/social.grain.photo/${photo1.rkey}`);
    expect(item2.value.item).toBe(`at://${owner}/social.grain.photo/${photo2.rkey}`);
    expect([item1.value.position, item2.value.position]).toEqual([0, 1]);
    expect(result.url).toEndWith(`/gallery/${gallery.rkey}`);
    await publish();
    expect(batches[1].writes.map((write) => write.rkey)).toEqual(writes.map((write) => write.rkey));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
