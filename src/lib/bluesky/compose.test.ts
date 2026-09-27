import { expect, test } from "bun:test";
import type { Agent } from "@atproto/api";
import { postText, publishProfilePost } from "./compose";

test("validates prose by graphemes and UTF-8 size", () => {
  expect(postText("  hello  ").text).toBe("hello");
  expect(postText("👨‍👩‍👧‍👦").graphemeLength).toBe(1);
  expect(() => postText("  ")).toThrow();
  expect(() => postText("x".repeat(301))).toThrow();
  expect(() => postText("👨‍👩‍👧‍👦".repeat(200))).toThrow();
});

test("publishes a standalone post with the visitor's authenticated agent", async () => {
  let written: unknown;
  const agent = {
    post: async (record: unknown) => {
      written = record;
      return { uri: "at://did:plc:visitor/app.bsky.feed.post/test", cid: "cid" };
    },
  } as unknown as Agent;
  const result = await publishProfilePost(agent, "hello world");
  expect(written).toMatchObject({ text: "hello world" });
  expect(written).not.toHaveProperty("reply");
  expect(written).not.toHaveProperty("embed");
  expect(result.uri).toContain("did:plc:visitor");
});
