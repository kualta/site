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
  const blob = { $type: "blob", mimeType: "video/mp4", size: 10, ref: { $link: "test" } };
  const agent = {
    session: { did: "did:plc:jhvnnnd3adml7t6anu3ay7ip" },
    pdsUrl: new URL("https://owner.pds.example"),
    login: async () => {},
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
      {},
      [file],
      [{ width: 64, height: 48 }],
      { id: crypto.randomUUID(), kind: "video", caption: "Hello", alt: "A scene" },
      {
        agent,
        wait: async () => {},
        fetcher: async (url) => {
          urls.push(String(url));
          return Response.json(call++ === 0 ? { jobId: "job", state: "JOB_STATE_CREATED" } : { jobStatus: { blob } });
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
