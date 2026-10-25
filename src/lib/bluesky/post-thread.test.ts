import { expect, test } from "bun:test";
import { loadPostConversations, postConversations } from "./post-thread";

const owner = "did:plc:jhvnnnd3adml7t6anu3ay7ip";
const reader = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
function post(key: string, did = owner, parent?: { uri: string; cid: string }) {
  return {
    uri: `at://${did}/app.bsky.feed.post/${key}`,
    cid: "bafyreid3l3mpwbadpafmoajnc2ukaaf42cmnti6shcomrrqnqq4ctap5xy",
    author: { did, handle: did === owner ? "kualta.dev" : "reader.test" },
    indexedAt: "2026-10-23T12:00:00Z",
    record: {
      $type: "app.bsky.feed.post",
      text: key,
      createdAt: "2026-10-23T12:00:00Z",
      ...(parent
        ? {
            reply: {
              root: { uri: `at://${owner}/app.bsky.feed.post/root`, cid: parent.cid },
              parent: { uri: parent.uri, cid: parent.cid },
            },
          }
        : {}),
    },
  };
}
const root = post("root");
const comment = post("comment", reader, root);
const reply = post("reply", owner, comment);
const node = (post: unknown, replies: unknown[] = []) => ({
  $type: "app.bsky.feed.defs#threadViewPost",
  post,
  replies,
});
const tree = (children: unknown[]) => node(root, children);

test("expands only comments with the site author's direct replies, retaining all replies once", () => {
  const other = post("other", reader, root);
  const second = post("second", owner, comment);
  const result = postConversations(
    tree([node(other), node(comment, [node(reply), node(reply), node(second)])]),
    root.uri,
  );
  expect(result.map(({ comment, replies }) => [comment.uri, replies.map((reply) => reply.uri)])).toEqual([
    [comment.uri, [reply.uri, second.uri]],
  ]);
});

test("finds nested conversations without connecting unrelated posts", () => {
  const nested = post("nested", reader, reply);
  const nestedReply = post("nestedReply", owner, nested);
  const unrelated = post("unrelated", owner, root);
  const result = postConversations(
    tree([node(comment, [node(reply, [node(nested, [node(nestedReply)])]), node(unrelated)])]),
    root.uri,
  );
  expect(result.map(({ comment }) => comment.uri)).toEqual([comment.uri, nested.uri]);
  expect(result[0].replies.map((reply) => reply.uri)).toEqual([reply.uri]);
});

test("omits blocked, deleted, moderated, mismatched and self-thread content", () => {
  const labeled = { ...reply, labels: [{ src: owner, uri: reply.uri, val: "porn", cts: "2026-10-23T12:00:00Z" }] };
  const spoofed = { ...reply, author: { did: reader, handle: "kualta.dev" } };
  const self = post("self", owner, root);
  expect(
    postConversations(
      tree([
        node(comment, [node(labeled), node(spoofed), { $type: "app.bsky.feed.defs#blockedPost", uri: reply.uri }]),
        node(self, [node(post("selfReply", owner, self))]),
        { $type: "app.bsky.feed.defs#notFoundPost", uri: comment.uri },
      ]),
      root.uri,
    ),
  ).toEqual([]);
  expect(postConversations(tree([node(comment, [node(reply)])]), comment.uri)).toEqual([]);
});

test("uses anonymous bounded reads and removes viewer metadata", async () => {
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.hostname).toBe("public.api.bsky.app");
    expect(url.searchParams.get("parentHeight")).toBe("0");
    expect(init?.headers).toBeUndefined();
    return Response.json({ thread: tree([node(comment, [node({ ...reply, viewer: { like: "private" } })])]) });
  }) as unknown as typeof fetch;
  expect(JSON.stringify(await loadPostConversations(root.uri, fetcher))).not.toContain("private");
  expect(await loadPostConversations("invalid", fetcher)).toBeNull();
  expect(
    await loadPostConversations(root.uri, (async () => new Response(null, { status: 503 })) as unknown as typeof fetch),
  ).toBeNull();
  expect(
    await loadPostConversations(root.uri, (async () => {
      throw new Error("Offline");
    }) as unknown as typeof fetch),
  ).toBeNull();
  expect(
    await loadPostConversations(root.uri, (() => new Promise(() => {})) as unknown as typeof fetch, 20),
  ).toBeNull();
});
