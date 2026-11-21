import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Lexicons, jsonToLex } from "@atproto/lexicon";
import {
  RELINK,
  ScopeError,
  applyPostRecord,
  blobCid,
  buildPostRecord,
  carriesMetadata,
  collection,
  planPostRecord,
  postRecordKey,
  reconcilePostRecords,
  scopeDenied,
  syncPostRecord,
} from "./post-record.mjs";

const owner = "did:plc:jhvnnnd3adml7t6anu3ay7ip";
const job = "11111111-2222-3333-4444-555555555555";
const picture = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2, 0xff, 0xd9]);
const sha256 = createHash("sha256").update(picture).digest("hex");
const bluesky = {
  platform: "bluesky",
  url: `https://bsky.app/profile/${owner}/post/3kabcdefghijk`,
  published_at: Date.UTC(2026, 10, 2),
  deleted: false,
};
const instagram = {
  platform: "instagram",
  url: "https://www.instagram.com/p/Cabc123/",
  published_at: Date.UTC(2026, 10, 1),
  deleted: false,
};
const source = (changes = {}) => ({
  id: job,
  created_at: Date.UTC(2026, 9, 30),
  post: { kind: "photo", title: "Bogotá", text: "Morning light", tags: ["travel"] },
  targets: [bluesky, instagram],
  thumbnail: { type: "image/jpeg", size: picture.length, sha256 },
  ...changes,
});
const stored = (record, cid = "bafyrecord") => ({ cid, value: JSON.parse(JSON.stringify(record)) });
const json = (data, status = 200) => Response.json(data, { status });

test("a blob's address is the CID a PDS gives the same bytes", () => {
  expect(blobCid(createHash("sha256").update("").digest("hex"))).toBe(
    "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
  );
});

test("a post's record key is a TID fixed by the post alone", () => {
  expect(postRecordKey(job)).toBe(postRecordKey(job));
  expect(postRecordKey(job)).toMatch(/^[234567a-j][234567a-z]{12}$/);
  expect(postRecordKey(job)).not.toBe(postRecordKey(job.replace("1", "2")));
});

test("the record lists each copy that is up and is valid under its lexicon", () => {
  const record = buildPostRecord(source());
  expect(record).toEqual({
    $type: "dev.kualta.post",
    kind: "photo",
    title: "Bogotá",
    text: "Morning light",
    tags: ["travel"],
    createdAt: "2026-11-01T00:00:00.000Z",
    thumbnail: { $type: "blob", ref: { $link: blobCid(sha256) }, mimeType: "image/jpeg", size: 8 },
    syndication: [
      {
        platform: "bluesky",
        url: bluesky.url,
        uri: `at://${owner}/app.bsky.feed.post/3kabcdefghijk`,
        publishedAt: "2026-11-02T00:00:00.000Z",
      },
      { platform: "instagram", url: instagram.url, publishedAt: "2026-11-01T00:00:00.000Z" },
    ],
  });
  const lexicons = new Lexicons([JSON.parse(readFileSync("scripts/lexicons/dev.kualta.post.json", "utf8"))]);
  lexicons.assertValidRecord(collection, jsonToLex(record));
  lexicons.assertValidRecord(
    collection,
    jsonToLex(buildPostRecord(source({ post: { kind: "text", title: "", text: "Hi", tags: [] }, thumbnail: null }))),
  );
});

test("nothing private in a post reaches its record", () => {
  const secret = "PRIVATE";
  const record = buildPostRecord(
    source({
      post: {
        kind: "photo",
        title: "Bogotá",
        text: "Morning light",
        tags: ["travel"],
        caption: secret,
        alt: secret,
        alts: [secret],
        media: [secret],
        cover: secret,
        location: secret,
        datesTaken: [secret],
        short: secret,
        schedule: { bluesky: 1 },
        metadata: { bluesky: secret },
        visibility: secret,
        zh: { title: secret, text: secret, topics: [secret], video: secret, location: secret },
        variants: { xiaohongshu: { title: secret, text: secret, tags: [secret] } },
      },
      targets: [{ ...bluesky, message: secret, claim: secret, metrics: secret, linked: secret }],
      helper: secret,
    }),
  );
  expect(JSON.stringify(record)).not.toContain("PRIVATE");
  expect(Object.keys(record).sort()).toEqual(
    ["$type", "createdAt", "kind", "syndication", "tags", "text", "thumbnail", "title"].sort(),
  );
  expect(Object.keys(record.syndication[0]).sort()).toEqual(["platform", "publishedAt", "uri", "url"]);
});

test("a deleted copy leaves the list but keeps the post's date; a copy without a known time has none", () => {
  const record = buildPostRecord(
    source({
      targets: [
        { ...instagram, deleted: true },
        bluesky,
        {
          platform: "bluesky",
          url: "https://bsky.app/profile/kualta.dev/post/3kzzzzzzzzzzz",
          published_at: null,
          deleted: false,
        },
      ],
    }),
  );
  expect(record.createdAt).toBe("2026-11-01T00:00:00.000Z");
  expect(record.syndication.map((copy) => copy.platform)).toEqual(["bluesky", "bluesky"]);
  expect(record.syndication[1]).toEqual({
    platform: "bluesky",
    url: "https://bsky.app/profile/kualta.dev/post/3kzzzzzzzzzzz",
  });
  expect(buildPostRecord(source({ targets: [{ ...instagram, deleted: true }] }))).toBeNull();
  expect(buildPostRecord({ id: job, targets: [] })).toBeNull();
  const linkedOnly = buildPostRecord(source({ targets: [{ ...instagram, published_at: null }] }));
  expect(linkedOnly.createdAt).toBe("2026-10-30T00:00:00.000Z");
});

test("the plan creates, leaves alone, updates and deletes", () => {
  const record = buildPostRecord(source());
  expect(planPostRecord(source(), null)).toMatchObject({ action: "create", upload: true, rkey: postRecordKey(job) });
  expect(planPostRecord(source({ targets: [] }), null).action).toBe("none");
  // The PDS returns keys in its own order and may describe the blob its own way.
  const held = stored({ ...Object.fromEntries(Object.entries(record).reverse()) });
  held.value.thumbnail.mimeType = "image/jpg";
  expect(planPostRecord(source(), held).action).toBe("none");
  const edited = planPostRecord(source({ post: { ...source().post, text: "Evening light" } }), held);
  expect(edited).toMatchObject({ action: "update", cid: "bafyrecord", upload: false });
  expect(edited.record.thumbnail).toEqual(held.value.thumbnail);
  const repainted = source({ thumbnail: { type: "image/png", size: 9, sha256: "00".repeat(32) } });
  expect(planPostRecord(repainted, held)).toMatchObject({ action: "update", upload: true });
  expect(planPostRecord(source({ targets: [instagram] }), held).record.syndication).toHaveLength(1);
  expect(planPostRecord(source({ targets: [{ ...bluesky, deleted: true }] }), held)).toMatchObject({
    action: "delete",
    cid: "bafyrecord",
  });
});

test("a post the site holds back, such as one only on YouTube as a private or unlisted video, has no record", () => {
  const held = { id: job, targets: [] };
  expect(buildPostRecord(held)).toBeNull();
  expect(planPostRecord(held, null).action).toBe("none");
  expect(planPostRecord(held, stored(buildPostRecord(source())))).toMatchObject({
    action: "delete",
    cid: "bafyrecord",
  });
});

function repo(calls, fail) {
  const call = (name) => async (input) => {
    calls.push([name, input]);
    if (fail) throw fail;
    return {};
  };
  return {
    did: owner,
    uploadBlob: async (bytes, options) => {
      calls.push(["uploadBlob", { bytes, ...options }]);
      return { data: { blob: { uploaded: true } } };
    },
    com: {
      atproto: {
        repo: { createRecord: call("createRecord"), putRecord: call("putRecord"), deleteRecord: call("deleteRecord") },
      },
    },
  };
}
const { scope } = JSON.parse(readFileSync("src/lib/publisher/oauth-client.json", "utf8"));
const thumbnailApi = async (path) => {
  expect(path).toBe(`post-records/${job}/thumbnail`);
  return new Response(picture);
};

test("writes are conditional: a create under the fixed key, a swap for an update or a delete", async () => {
  const calls = [];
  const authorization = { agent: repo(calls), scope };
  const record = buildPostRecord(source());
  await applyPostRecord(planPostRecord(source(), null), source(), { authorization, api: thumbnailApi });
  expect(calls.map(([name]) => name)).toEqual(["uploadBlob", "createRecord"]);
  expect(calls[0][1]).toMatchObject({ encoding: "image/jpeg" });
  expect(calls[1][1]).toMatchObject({
    repo: owner,
    collection,
    rkey: postRecordKey(job),
    validate: false,
    record: { thumbnail: { uploaded: true } },
  });
  expect(calls[1][1]).not.toHaveProperty("swapRecord");
  calls.length = 0;
  const edit = source({ post: { ...source().post, text: "Evening light" } });
  await applyPostRecord(planPostRecord(edit, stored(record)), edit, { authorization, api: thumbnailApi });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject(["putRecord", { swapRecord: "bafyrecord", record: { text: "Evening light" } }]);
  calls.length = 0;
  const gone = { id: job, targets: [] };
  await applyPostRecord(planPostRecord(gone, stored(record)), gone, { authorization, api: thumbnailApi });
  expect(calls).toEqual([
    ["deleteRecord", { repo: owner, collection, rkey: postRecordKey(job), swapRecord: "bafyrecord" }],
  ]);
  calls.length = 0;
  await applyPostRecord(planPostRecord(source(), stored(record)), source(), { authorization, api: thumbnailApi });
  expect(calls).toEqual([]);
});

test("a thumbnail that changed since the plan is not uploaded", async () => {
  const calls = [];
  await expect(
    applyPostRecord(planPostRecord(source(), null), source(), {
      authorization: { agent: repo(calls), scope },
      api: async () => new Response(new Uint8Array([9])),
    }),
  ).rejects.toThrow("thumbnail changed");
  expect(calls).toEqual([]);
});

const jpeg = (...segments) => new Uint8Array([0xff, 0xd8, ...segments.flat(), 0xff, 0xda, 0, 2, 0xff, 0xd9]);
const segment = (marker, text) => [0xff, marker, 0, text.length + 2, ...Buffer.from(text, "latin1")];
const png = (...chunks) =>
  new Uint8Array([
    0x89,
    ...Buffer.from("PNG\r\n\x1a\n", "latin1"),
    ...chunks.flatMap(([type, text]) => [0, 0, 0, text.length, ...Buffer.from(type + text, "latin1"), 0, 0, 0, 0]),
  ]);
const webp = (...chunks) =>
  new Uint8Array([
    ...Buffer.from("RIFF\0\0\0\0WEBP", "latin1"),
    ...chunks.flatMap(([type, text]) => [
      ...Buffer.from(type, "latin1"),
      text.length,
      0,
      0,
      0,
      ...Buffer.from(text.padEnd(text.length + (text.length % 2), "\0"), "latin1"),
    ]),
  ]);

test("a thumbnail carrying EXIF or XMP is recognised in each format", () => {
  expect(carriesMetadata(jpeg(segment(0xe0, "JFIF\0"), segment(0xdb, "Exif\0\0 in a table")))).toBe(false);
  expect(carriesMetadata(jpeg(segment(0xe0, "JFIF\0"), segment(0xe1, "Exif\0\0GPS")))).toBe(true);
  expect(carriesMetadata(jpeg(segment(0xe1, "http://ns.adobe.com/xap/1.0/\0<x/>")))).toBe(true);
  expect(carriesMetadata(png(["IHDR", "eXIf in the pixels"], ["IDAT", "x"]))).toBe(false);
  expect(carriesMetadata(png(["IHDR", "x"], ["eXIf", "GPS"]))).toBe(true);
  expect(carriesMetadata(png(["iTXt", "XML:com.adobe.xmp\0<x/>"]))).toBe(true);
  expect(carriesMetadata(webp(["VP8 ", "EXIF"], ["ALPH", "abc"]))).toBe(false);
  expect(carriesMetadata(webp(["VP8 ", "abc"], ["EXIF", "GPS"]))).toBe(true);
  expect(carriesMetadata(webp(["XMP ", "<x/>"]))).toBe(true);
  expect(() => carriesMetadata(new Uint8Array([1, 2, 3, 4]))).toThrow("not a JPEG, PNG or WebP");
});

test("a thumbnail carrying metadata is never uploaded", async () => {
  const calls = [];
  const bytes = jpeg(segment(0xe1, "Exif\0\0GPS"));
  const tagged = source({
    thumbnail: { type: "image/jpeg", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
  });
  await expect(
    applyPostRecord(planPostRecord(tagged, null), tagged, {
      authorization: { agent: repo(calls), scope },
      api: async () => new Response(bytes),
    }),
  ).rejects.toThrow("carries EXIF or XMP metadata");
  expect(calls).toEqual([]);
});

test("the publisher's OAuth client asks for the record and its thumbnail types", () => {
  const parts = scope.split(" ");
  expect(parts).toContain("repo:dev.kualta.post?action=create&action=update&action=delete");
  for (const type of ["image/jpeg", "image/png", "image/webp"]) expect(parts).toContain(`blob:${type}`);
});

test("a sign-in from before the scope gets one instruction to re-link, without a write", async () => {
  const calls = [];
  const old = "atproto repo:app.bsky.feed.post?action=create&action=delete blob:image/jpeg";
  await expect(
    applyPostRecord(planPostRecord(source(), null), source(), {
      authorization: { agent: repo(calls), scope: old },
      api: thumbnailApi,
    }),
  ).rejects.toThrow(ScopeError);
  expect(calls).toEqual([]);
  expect(RELINK).toContain("Re-link Bluesky in the publisher Accounts tab");
});

test("the PDS turning a write down for scope reads as the same instruction", async () => {
  expect(
    scopeDenied({ status: 403, error: "ScopeMissingError", message: 'Missing required scope "repo:dev.kualta.post"' }),
  ).toBe(true);
  expect(scopeDenied({ status: 401, error: "insufficient_scope", message: "" })).toBe(true);
  expect(scopeDenied({ status: 400, error: "InvalidSwap", message: "Record was at bafy" })).toBe(false);
  expect(scopeDenied({ status: 403, error: "Forbidden", message: "Account is suspended" })).toBe(false);
  const denied = Object.assign(new Error("Missing required scope"), { status: 403, error: "ScopeMissingError" });
  const gone = { id: job, targets: [] };
  await expect(
    applyPostRecord(planPostRecord(gone, stored({})), gone, {
      authorization: { agent: repo([], denied) },
      api: thumbnailApi,
    }),
  ).rejects.toThrow(RELINK);
});

function site(sources) {
  return async (path) => {
    if (path === "post-records") return json({ jobs: sources.slice(0, 1), next: sources.length > 1 ? "2:next" : null });
    if (path === "post-records?before=2:next") return json({ jobs: sources.slice(1), next: null });
    const one = sources.find((item) => path === `post-records/${item.id}`);
    if (one) return json({ job: one });
    if (path.endsWith("/thumbnail")) return new Response(picture);
    return json({ job: null });
  };
}
function pds(records) {
  return async (address) => {
    const url = new URL(address);
    if (url.hostname === "plc.directory")
      return json({ service: [{ type: "AtprotoPersonalDataServer", serviceEndpoint: "https://pds.test" }] });
    expect(url.origin).toBe("https://pds.test");
    expect(url.searchParams.get("collection")).toBe(collection);
    if (url.pathname.endsWith("listRecords"))
      return json({
        records: Object.entries(records).map(([rkey, record]) => ({
          uri: `at://${owner}/${collection}/${rkey}`,
          ...record,
        })),
      });
    const record = records[url.searchParams.get("rkey")];
    return record ? json(record) : json({ error: "RecordNotFound" }, 400);
  };
}
const other = "99999999-2222-3333-4444-555555555555";

test("a dry run plans every post across pages and writes nothing", async () => {
  const lines = [];
  const counts = await reconcilePostRecords({
    api: site([source(), { id: other, targets: [] }]),
    fetcher: pds({
      [postRecordKey(other)]: stored(buildPostRecord(source())),
      strayrecordkey: stored({ text: "?" }),
    }),
    log: (line) => lines.push(line),
  });
  expect(counts).toEqual({ create: 1, update: 0, delete: 1, none: 0, failed: 0, orphans: 1 });
  expect(lines).toEqual([
    `would create ${postRecordKey(job)} ${job} "Bogotá" → bluesky, instagram`,
    `would delete ${postRecordKey(other)} ${other}`,
    "no post for record strayrecordkey; left alone",
  ]);
});

test("writing is idempotent, and one failed post doesn't stop or hide the rest", async () => {
  const calls = [];
  const records = {};
  const agent = repo(calls);
  agent.com.atproto.repo.createRecord = async (input) => {
    calls.push(["createRecord", input]);
    if (input.rkey === postRecordKey(other)) throw new Error("PDS is down");
    records[input.rkey] = stored({ ...input.record, thumbnail: buildPostRecord(source()).thumbnail });
  };
  const options = () => ({
    api: site([source(), source({ id: other })]),
    fetcher: pds(records),
    authorization: { agent, scope, pdsUrl: new URL("https://pds.test") },
    log: () => {},
  });
  expect(await reconcilePostRecords(options())).toMatchObject({ create: 1, failed: 1 });
  calls.length = 0;
  expect(await reconcilePostRecords({ ...options(), job })).toMatchObject({ none: 1, create: 0 });
  expect(calls).toEqual([]);
});

test("a full run stops at the first scope refusal instead of repeating it for every post", async () => {
  const calls = [];
  await expect(
    reconcilePostRecords({
      api: site([source(), source({ id: other })]),
      fetcher: pds({}),
      authorization: { agent: repo(calls), scope: "atproto", pdsUrl: new URL("https://pds.test") },
      log: () => {},
    }),
  ).rejects.toThrow(RELINK);
  expect(calls).toEqual([]);
});

test("a record that can't be written after publishing is reported, never thrown or called done", async () => {
  const lines = [];
  const oauth = (agent, granted = scope) => ({
    agent: async () => ({ agent, scope: granted, pdsUrl: new URL("https://pds.test") }),
  });
  const options = { api: site([source()]), fetcher: pds({}), log: (line) => lines.push(line) };
  expect(await syncPostRecord(job, { ...options, oauth: oauth(repo([])) })).toBe("create");
  expect(lines).toEqual([`Post record ${postRecordKey(job)}: create`]);
  lines.length = 0;
  expect(await syncPostRecord(job, { ...options, oauth: oauth(repo([], new Error("PDS is down"))) })).toBe("failed");
  expect(lines).toEqual([
    `Post record for ${job} was NOT written: PDS is down. Repair it with: bun run publisher post-records --write`,
  ]);
  lines.length = 0;
  const signedOut = { agent: async () => Promise.reject(new Error("Grain / Bluesky is signed out.")) };
  expect(await syncPostRecord(job, { ...options, oauth: signedOut })).toBe("failed");
  expect(lines[0]).toContain("was NOT written: Grain / Bluesky is signed out.");
  lines.length = 0;
  for (let i = 0; i < 3; i++)
    expect(await syncPostRecord(job, { ...options, oauth: oauth(repo([]), "atproto") })).toBe("failed");
  expect(lines).toEqual([`Post records are NOT being written. ${RELINK}`]);
});

test("a repository that never answers holds the queue only until the deadline", async () => {
  const lines = [];
  const stalled = { agent: () => new Promise(() => {}) };
  const started = Date.now();
  expect(
    await syncPostRecord(job, { api: site([source()]), oauth: stalled, deadline: 30, log: (line) => lines.push(line) }),
  ).toBe("failed");
  expect(Date.now() - started).toBeLessThan(2000);
  expect(lines).toEqual([
    `Post record for ${job} was NOT written: no answer within 0.03 s, though the write may still land. Repair it with: bun run publisher post-records --write`,
  ]);
});
