import { describe, expect, test } from "bun:test";
import {
  commentRecord,
  linksToArticle,
  loadArticleComments,
  mergeComments,
  threadComments,
  publishArticleComment,
  visibleComment,
  type CommentPost,
} from "./comments";
import type { Agent, AppBskyFeedDefs } from "@atproto/api";

const url = "https://kualta.dev/posts/hello";
function post(id: string, link = url): CommentPost {
  return {
    uri: `at://did:plc:alice/app.bsky.feed.post/${id}`,
    cid: `cid-${id}`,
    author: { did: "did:plc:alice", handle: "alice.test" },
    indexedAt: "2026-09-27T00:00:00Z",
    record: commentRecord("hello", link, "Hello"),
  };
}

describe("article discussion records", () => {
  test("ties comments to the exact canonical article rather than a fuzzy search match", () => {
    expect(linksToArticle(post("1"), url)).toBe(true);
    expect(linksToArticle(post("1", `${url}/?utm_source=bsky#comments`), url)).toBe(true);
    expect(linksToArticle(post("1", `${url}-other`), url)).toBe(false);
    expect(linksToArticle(post("1", "https://evil.test/posts/hello"), url)).toBe(false);
  });
  test("supports existing Bluesky posts linking through facets", () => {
    const value = post("1");
    value.record = {
      $type: "app.bsky.feed.post",
      text: "article",
      createdAt: value.indexedAt,
      facets: [
        { index: { byteStart: 0, byteEnd: 7 }, features: [{ $type: "app.bsky.richtext.facet#link", uri: url }] },
      ],
    };
    expect(linksToArticle(value, url)).toBe(true);
  });
  test("posts a public link card and keeps the original thread root on nested replies", () => {
    const root = post("root");
    const firstReply = { ...post("reply"), record: commentRecord("First reply", url, "Hello", root) };
    const nested = commentRecord(" Second reply ", url, "Hello", firstReply);
    expect(nested.text).toBe("Second reply");
    expect(nested.reply).toEqual({
      root: { uri: root.uri, cid: root.cid },
      parent: { uri: firstReply.uri, cid: firstReply.cid },
    });
    expect(nested.embed).toEqual({
      $type: "app.bsky.embed.external",
      external: { uri: url, title: "Hello", description: "" },
    });
  });
  test("enforces Bluesky grapheme length including composite emoji", () => {
    expect(() => commentRecord(" ", url, "Hello")).toThrow();
    expect(() => commentRecord("x".repeat(301), url, "Hello")).toThrow();
    expect(() => commentRecord("👨‍👩‍👧‍👦".repeat(300), url, "Hello")).toThrow();
    expect(commentRecord("👨‍👩‍👧‍👦".repeat(100), url, "Hello").text).toBe("👨‍👩‍👧‍👦".repeat(100));
  });
  test("deduplicates replies discovered in multiple thread results and omits hidden content", () => {
    const root = post("root");
    const reply = post("reply");
    const hidden = {
      ...post("hidden"),
      labels: [{ src: "did:plc:labeler", uri: "test", val: "!hide", cts: root.indexedAt }],
    };
    const thread: AppBskyFeedDefs.ThreadViewPost = {
      $type: "app.bsky.feed.defs#threadViewPost",
      post: root,
      replies: [
        { $type: "app.bsky.feed.defs#threadViewPost", post: reply },
        { $type: "app.bsky.feed.defs#threadViewPost", post: hidden },
        { $type: "app.bsky.feed.defs#blockedPost", uri: "blocked", blocked: true, author: { did: "did:plc:blocked" } },
      ],
    };
    expect(threadComments(thread).map((p) => p.uri)).toEqual([root.uri, reply.uri]);
    expect(mergeComments([root, reply], threadComments(thread))).toHaveLength(2);
  });
  test("reads by exact URL with pagination and retains roots when a thread fails", async () => {
    let params: unknown;
    const root = post("root");
    const agent = {
      app: {
        bsky: {
          feed: {
            searchPosts: async (input: unknown) => {
              params = input;
              return { data: { posts: [root, post("unrelated", `${url}-other`)], cursor: "next" } };
            },
          },
        },
      },
      getPostThread: async () => {
        throw new Error("network failure");
      },
    } as unknown as Agent;
    const result = await loadArticleComments(agent, url, "previous");
    expect(params).toEqual({ q: "*", url, sort: "latest", limit: 20, cursor: "previous" });
    expect(result.posts).toEqual([root]);
    expect(result.cursor).toBe("next");
    expect(result.incomplete).toBe(true);
  });
});

test("filters author moderation and blocks as well as post labels", () => {
  expect(visibleComment({ ...post("1"), author: { ...post("1").author, viewer: { muted: true } } })).toBe(false);
  expect(
    visibleComment({
      ...post("1"),
      author: {
        ...post("1").author,
        labels: [{ src: "did:plc:labeler", uri: "test", val: "!warn", cts: "2026-09-27T00:00:00Z" }],
      },
    }),
  ).toBe(false);
});

test("refreshes reply state and rejects a newly closed thread before posting", async () => {
  let writes = 0;
  const agent = {
    getPosts: async () => ({
      data: { posts: [{ ...post("root"), cid: "fresh-cid", viewer: { replyDisabled: true } }] },
    }),
    post: async () => {
      writes++;
    },
  } as unknown as Agent;
  await expect(publishArticleComment(agent, "Reply", url, "Hello", post("root"))).rejects.toThrow(
    "Replies are disabled",
  );
  expect(writes).toBe(0);
});

test("publishes replies using the current parent CID and canonical article embed", async () => {
  let written: unknown;
  const currentParent = { ...post("root"), cid: "fresh-cid" };
  const agent = {
    getPosts: async () => ({ data: { posts: [currentParent] } }),
    post: async (record: unknown) => {
      written = record;
      return { uri: post("new").uri, cid: "new-cid" };
    },
  } as unknown as Agent;
  const result = await publishArticleComment(agent, "A reply", url, "Hello", post("root"));
  expect(result.record.reply?.parent).toEqual({ uri: currentParent.uri, cid: "fresh-cid" });
  expect(result.record.reply?.root).toEqual({ uri: currentParent.uri, cid: "fresh-cid" });
  expect(written).toBe(result.record);
  expect(linksToArticle({ ...post("new"), record: result.record }, url)).toBe(true);
});
