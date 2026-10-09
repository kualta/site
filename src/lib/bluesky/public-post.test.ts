import { expect, test } from "bun:test";
import { loadPublicPost } from "./public-post";
import { parsePostUri, sitePostPath, sitePostUrl, blueskyPostUrl, postUriFromPath } from "./urls";
const did = "did:plc:jhvnnnd3adml7t6anu3ay7ip";
const uri = `at://${did}/app.bsky.feed.post/post1`;
const post = {
  uri,
  cid: "bafyreid3l3mpwbadpafmoajnc2ukaaf42cmnti6shcomrrqnqq4ctap5xy",
  indexedAt: "2026-10-04T12:00:00Z",
  author: { did, handle: "kualta.dev", viewer: { muted: true } },
  record: { $type: "app.bsky.feed.post", text: "Hello", createdAt: "2026-10-04T12:00:00Z" },
  viewer: { like: "at://did:plc:jhvnnnd3adml7t6anu3ay7ip/app.bsky.feed.like/private" },
};
const response = (body: unknown) => (async () => Response.json(body)) as unknown as typeof fetch;
test("permalinks round trip safe verified DID and record keys", () => {
  expect(postUriFromPath(sitePostPath(uri))).toBe(uri);
  expect(postUriFromPath(`${sitePostPath(uri)}/row`)).toBe(uri);
  expect(sitePostUrl(uri)).toStartWith("https://kualta.dev/post/");
  expect(blueskyPostUrl(uri)).toBe(`https://bsky.app/profile/${did}/post/post1`);
  for (const key of ["..", ".", "bad/path", "evil?query", "evil#hash"])
    expect(parsePostUri(`at://${did}/app.bsky.feed.post/${key}`)).toBeUndefined();
  expect(postUriFromPath(`/post/${did}/%2Fsecret`)).toBe("");
  expect(postUriFromPath("/post/%ZZ/post1")).toBe("");
});
test("public reads verify author and discard private viewer fields", async () => {
  const result = await loadPublicPost(uri, response({ posts: [post] }));
  expect(result.status).toBe(200);
  if (result.status === 200) {
    expect(result.event.text).toBe("Hello");
    expect(JSON.stringify(result)).not.toContain("private");
    expect(result.event.post.author).not.toHaveProperty("viewer");
  }
  expect(
    (
      await loadPublicPost(
        uri,
        response({ posts: [{ ...post, author: { ...post.author, did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa" } }] }),
      )
    ).status,
  ).toBe(503);
});
test("a bare link gets its card, and a slow card never costs the post", async () => {
  const link = "https://example.com/";
  const linked = {
    ...post,
    record: {
      ...post.record,
      text: link,
      facets: [{ index: { byteStart: 0, byteEnd: link.length }, features: [{ $type: "app.bsky.richtext.facet#link", uri: link }] }],
    },
  };
  const upstream = (card: () => Promise<Response>) =>
    (async (input: RequestInfo | URL) =>
      String(input).startsWith("https://cardyb.bsky.app/") ? card() : Response.json({ posts: [linked] })) as typeof fetch;

  const result = await loadPublicPost(uri, upstream(async () => Response.json({ title: "Example Domain", description: "" })));
  expect(result.status === 200 && result.event.linkPreview).toEqual({ uri: link, title: "Example Domain", description: "" });

  const slow = await loadPublicPost(uri, upstream(() => new Promise(() => {})), 3_000, 20);
  expect(slow.status).toBe(200);
  expect(slow.status === 200 && slow.event).not.toHaveProperty("linkPreview");
});
test("missing, invalid, malformed, failed and hung upstream are bounded and honest", async () => {
  expect((await loadPublicPost(uri, response({ posts: [] }))).status).toBe(404);
  expect((await loadPublicPost("invalid", response({ posts: [post] }))).status).toBe(404);
  expect((await loadPublicPost(uri, response(null))).status).toBe(503);
  expect(
    (await loadPublicPost(uri, (async () => new Response("error", { status: 500 })) as unknown as typeof fetch)).status,
  ).toBe(503);
  const start = performance.now();
  expect((await loadPublicPost(uri, (() => new Promise(() => {})) as unknown as typeof fetch, 20)).status).toBe(503);
  expect(performance.now() - start).toBeLessThan(200);
  const hungJson = (async () => ({
    ok: true,
    json: () => new Promise(() => {}),
  })) as unknown as unknown as typeof fetch;
  expect((await loadPublicPost(uri, hungJson, 20)).status).toBe(503);
});
