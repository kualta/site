import { describe, expect, test } from "bun:test";
import type { Agent } from "@atproto/api";
import { replyToPost, togglePostLike, togglePostRepost } from "./interactions";

const uri = "at://did:plc:author/app.bsky.feed.post/post";
function mockAgent(viewer: Record<string, unknown> = {}, reply?: unknown) {
  const calls: Array<[string, unknown]> = [];
  const post = {
    uri,
    cid: "fresh-cid",
    likeCount: 2,
    repostCount: 3,
    viewer,
    record: {
      $type: "app.bsky.feed.post",
      text: "Post",
      createdAt: new Date().toISOString(),
      ...(reply ? { reply } : {}),
    },
  };
  const agent = {
    getPosts: async () => ({ data: { posts: [post] } }),
    like: async (...args: unknown[]) => {
      calls.push(["like", args]);
      return { uri: "at://me/like/1" };
    },
    deleteLike: async (value: string) => {
      calls.push(["deleteLike", value]);
    },
    repost: async (...args: unknown[]) => {
      calls.push(["repost", args]);
      return { uri: "at://me/repost/1" };
    },
    deleteRepost: async (value: string) => {
      calls.push(["deleteRepost", value]);
    },
    post: async (value: unknown) => {
      calls.push(["post", value]);
      return { uri: "at://me/post/reply", cid: "reply-cid" };
    },
  } as unknown as Agent;
  return { agent, calls };
}

describe("Bluesky interactions", () => {
  test("likes the fresh post CID and returns viewer state", async () => {
    const { agent, calls } = mockAgent();
    const post = await togglePostLike(agent, uri);
    expect(calls).toEqual([["like", [uri, "fresh-cid"]]]);
    expect(post.viewer.like).toBe("at://me/like/1");
    expect(post.likeCount).toBe(3);
  });
  test("deletes the actual viewer like and repost records", async () => {
    const { agent, calls } = mockAgent({ like: "at://me/like/existing", repost: "at://me/repost/existing" });
    expect((await togglePostLike(agent, uri)).viewer.like).toBeUndefined();
    expect((await togglePostRepost(agent, uri)).viewer.repost).toBeUndefined();
    expect(calls).toEqual([
      ["deleteLike", "at://me/like/existing"],
      ["deleteRepost", "at://me/repost/existing"],
    ]);
  });
  test("undo uses the confirmed write even when AppView has not indexed it", async () => {
    const { agent, calls } = mockAgent();
    await togglePostLike(agent, uri, "at://me/like/just-created");
    await togglePostRepost(agent, uri, "at://me/repost/just-created");
    expect(calls).toEqual([
      ["deleteLike", "at://me/like/just-created"],
      ["deleteRepost", "at://me/repost/just-created"],
    ]);
  });
  test("replies retain the thread root and use a fresh parent reference", async () => {
    const root = { uri: "at://original/app.bsky.feed.post/root", cid: "root-cid" };
    const { agent, calls } = mockAgent({}, { root, parent: root });
    await replyToPost(agent, uri, " Hello ");
    expect(calls[0][1]).toMatchObject({ text: "Hello", reply: { root, parent: { uri, cid: "fresh-cid" } } });
  });
  test("top-level replies use the parent as root", async () => {
    const { agent, calls } = mockAgent();
    await replyToPost(agent, uri, "Hello");
    expect(calls[0][1]).toMatchObject({
      reply: { root: { uri, cid: "fresh-cid" }, parent: { uri, cid: "fresh-cid" } },
    });
  });
  test("rejects empty and overlong replies before writing", async () => {
    const { agent, calls } = mockAgent();
    await expect(replyToPost(agent, uri, " ")).rejects.toThrow("1–300");
    await expect(replyToPost(agent, uri, "a".repeat(301))).rejects.toThrow("1–300");
    expect(calls).toHaveLength(0);
  });
  test("respects disabled replies", async () => {
    const { agent, calls } = mockAgent({ replyDisabled: true });
    await expect(replyToPost(agent, uri, "Hello")).rejects.toThrow("disabled");
    expect(calls).toHaveLength(0);
  });
});
