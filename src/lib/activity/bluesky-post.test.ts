import { describe, expect, test } from "bun:test";
import type { Post as BlueskyPostView } from "@astro-community/astro-embed-bluesky";
import { canRenderBlueskyPost, sanitizeBlueskyPostView } from "./bluesky-post";

const DID = "did:plc:jhvnnnd3adml7t6anu3ay7ip";
const CID = "bafyreid3l3mpwbadpafmoajnc2ukaaf42cmnti6shcomrrqnqq4ctap5xy";
const TIME = "2026-08-30T12:00:00Z";
const URI = `at://${DID}/app.bsky.feed.post/post1`;

function postView(extra: Record<string, unknown> = {}): BlueskyPostView {
  return {
    uri: URI,
    cid: CID,
    indexedAt: TIME,
    author: {
      did: DID,
      handle: "kualta.dev",
      displayName: "ku",
    },
    record: {
      $type: "app.bsky.feed.post",
      createdAt: TIME,
      text: "hello from Bluesky",
    },
    ...extra,
  } as BlueskyPostView;
}

describe("sanitizeBlueskyPostView", () => {
  test("retains render data while removing viewer and unused AppView fields", () => {
    const sanitized = sanitizeBlueskyPostView(
      postView({
        debug: { trace: "internal" },
        likeCount: 42,
        viewer: {},
        embed: {
          $type: "app.bsky.embed.images#view",
          images: [
            {
              alt: "a tiny frog",
              thumb: "https://cdn.bsky.app/frog-thumb.jpg",
              fullsize: "https://cdn.bsky.app/frog.jpg",
            },
          ],
        },
      }),
    );

    expect(sanitized).toBeDefined();
    expect(sanitized?.embed?.$type).toBe("app.bsky.embed.images#view");
    expect(JSON.stringify(sanitized)).not.toContain("viewer");
    expect(JSON.stringify(sanitized)).not.toContain("debug");
    expect(JSON.stringify(sanitized)).not.toContain("likeCount");
  });

  test("rejects incomplete post views", () => {
    expect(sanitizeBlueskyPostView({ uri: URI })).toBeUndefined();
  });
});

describe("canRenderBlueskyPost", () => {
  test("allows supported media", () => {
    const post = postView({
      embed: {
        $type: "app.bsky.embed.external#view",
        external: {
          uri: "https://kualta.dev/",
          title: "kualta",
          description: "home",
        },
      },
    });

    expect(canRenderBlueskyPost(post)).toBe(true);
  });

  test("falls back for moderation labels, including self-labels", () => {
    const labeled = postView({
      labels: [{ src: DID, uri: URI, val: "porn", cts: TIME }],
    });
    const selfLabeled = postView({
      record: {
        $type: "app.bsky.feed.post",
        createdAt: TIME,
        text: "content warning",
        labels: {
          $type: "com.atproto.label.defs#selfLabels",
          values: [{ val: "graphic-media" }],
        },
      },
    });

    expect(canRenderBlueskyPost(labeled)).toBe(false);
    expect(canRenderBlueskyPost(selfLabeled)).toBe(false);
  });

  test("falls back for embed types the package cannot render", () => {
    const futureEmbed = postView({
      embed: { $type: "app.bsky.embed.future#view" },
    });

    expect(canRenderBlueskyPost(futureEmbed)).toBe(false);
  });
});
