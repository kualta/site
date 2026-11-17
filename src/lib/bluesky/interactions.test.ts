import { describe, expect, test } from "bun:test";
import type { Agent } from "@atproto/api";
import type { AppBskyFeedDefs } from "@atproto/api";
import {
  createPostLoader,
  RepostRemovedError,
  replyToPost,
  repostAgain,
  togglePostLike,
  togglePostRepost,
} from "./interactions";

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
  test("repost again replaces the existing record with a fresh one", async () => {
    const { agent, calls } = mockAgent({ repost: "at://me/repost/existing" });
    const post = await repostAgain(agent, uri);
    expect(calls).toEqual([
      ["deleteRepost", "at://me/repost/existing"],
      ["repost", [uri, "fresh-cid"]],
    ]);
    expect(post.viewer.repost).toBe("at://me/repost/1");
    expect(post.repostCount).toBe(3);
  });
  test("repost again counts a confirmed repost the AppView has not indexed", async () => {
    const { agent, calls } = mockAgent();
    const post = await repostAgain(agent, uri, "at://me/repost/just-created");
    expect(calls[0]).toEqual(["deleteRepost", "at://me/repost/just-created"]);
    expect(post.repostCount).toBe(4);
  });
  test("repost again reports the removed repost when the new write fails", async () => {
    const { agent } = mockAgent({ repost: "at://me/repost/existing" });
    agent.repost = async () => {
      throw new Error("offline");
    };
    const failure = await repostAgain(agent, uri).catch((cause) => cause);
    expect(failure).toBeInstanceOf(RepostRemovedError);
    expect(failure.post.viewer.repost).toBeUndefined();
    expect(failure.post.repostCount).toBe(2);
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

describe("public post loader", () => {
  const postAt = (index: number) => `at://did:plc:author/app.bsky.feed.post/${index}`;
  const view = (postUri: string) => ({ uri: postUri, likeCount: 1 }) as unknown as AppBskyFeedDefs.PostView;

  test("rows mounting together share getPosts calls of at most 25", async () => {
    const calls: string[][] = [];
    const load = createPostLoader(async (uris) => {
      calls.push(uris);
      return uris.map(view);
    }, 0);
    const uris = Array.from({ length: 30 }, (_, index) => postAt(index));
    const posts = await Promise.all([...uris, uris[0]].map(load));
    expect(calls.map((chunk) => chunk.length)).toEqual([25, 5]);
    expect(posts.map((post) => post.uri)).toEqual([...uris, uris[0]]);
  });
  test("a missing post or failed call rejects only its own rows", async () => {
    const load = createPostLoader(async (uris) => {
      if (uris.includes(postAt(99))) throw new Error("AppView down");
      return uris.filter((value) => value !== postAt(2)).map(view);
    }, 0);
    const [found, missing] = await Promise.allSettled([load(postAt(1)), load(postAt(2))]);
    expect(found).toMatchObject({ status: "fulfilled", value: { uri: postAt(1) } });
    expect(missing).toMatchObject({ status: "rejected", reason: { message: "This post is no longer available." } });
    await expect(load(postAt(99))).rejects.toThrow("AppView down");
    await expect(load(postAt(1))).resolves.toMatchObject({ uri: postAt(1) });
  });
});
