import { expect, test } from "bun:test";
import { collectAnalytics, extractMetrics } from "./analytics.mjs";
import { recordKey } from "../lib/atproto-content.mjs";
test("browser metrics match only the exact post and keep absent counts unknown", () => {
  expect(
    extractMetrics("twitter", "12345", {
      data: [
        { rest_id: "other", views: { count: "9000" }, legacy: { favorite_count: 200 } },
        { rest_id: "12345", views: { count: "100" }, legacy: { favorite_count: 0, reply_count: 2 } },
      ],
    }),
  ).toEqual({ views: 100, likes: 0, comments: 2 });
  expect(
    extractMetrics("instagram", "abcde", {
      shortcode: "abcde",
      edge_media_preview_like: { count: 12 },
      edge_media_to_comment: { count: 3 },
    }),
  ).toEqual({ likes: 12, comments: 3 });
  expect(
    extractMetrics("tiktok", "12345", {
      id: "12345",
      stats: { playCount: 100, diggCount: 10, shareCount: 2, commentCount: 4, collectCount: 1 },
    }),
  ).toEqual({ views: 100, likes: 10, shares: 2, comments: 4, saves: 1 });
  expect(
    extractMetrics("xiaohongshu", "abcde", {
      noteId: "abcde",
      interactInfo: { likedCount: "10", collectedCount: "2", commentCount: "1", shareCount: "0" },
    }),
  ).toEqual({ likes: 10, saves: 2, comments: 1, shares: 0 });
  expect(extractMetrics("instagram", "abcde", { shortcode: "abcde", like_count: -1, play_count: "1.2K" })).toEqual({});
});
test("public AT metrics read the exact publication without opening a browser", async () => {
  const actor = "did:plc:jhvnnnd3adml7t6anu3ay7ip",
    job = "fixture";
  for (const platform of ["bluesky", "grain"]) {
    const id = recordKey(`publisher:${platform}:${job}`);
    const uri = `at://${actor}/${platform === "grain" ? "social.grain.gallery" : "app.bsky.feed.post"}/${id}`;
    const target = {
      platform,
      job_id: job,
      url:
        platform === "grain"
          ? `https://grain.social/profile/${actor}/gallery/${id}`
          : `https://bsky.app/profile/${actor}/post/${id}`,
    };
    const result = await collectAnalytics(target, {
      open: async () => {
        throw Error("must not open");
      },
      fetcher: async (url) => {
        expect(decodeURIComponent(url)).toContain(uri);
        return Response.json(
          platform === "grain"
            ? { gallery: { uri, favCount: 4, commentCount: 0 } }
            : { posts: [{ uri, likeCount: 4, replyCount: 0, repostCount: 1 }] },
        );
      },
    });
    expect(result.metrics.likes).toBe(4);
    expect(result.metrics.views).toBeUndefined();
    expect(result.metrics.comments).toBe(0);
  }
});
test("untrusted URLs never open a browser and upstream errors never become zero metrics", async () => {
  let opened = false;
  const result = await collectAnalytics(
    { platform: "twitter", url: "https://evil.example/status/12345" },
    {
      open: async () => {
        opened = true;
      },
    },
  );
  expect(opened).toBe(false);
  expect(result.error).toBeTruthy();
  expect(result.metrics).toBeUndefined();
});

test("YouTube collection uses the saved session, checks video identity, and closes Chrome", async () => {
  let closed = false;
  const result = await collectAnalytics(
    { platform: "youtube", job_id: "fixture", url: "https://youtu.be/abcdefghijk" },
    {
      stateDir: "/unused",
      open: async (path, headless) => {
        expect(path).toBe("/unused/youtube");
        expect(headless).toBe(true);
        return {
          pages: () => [{ setDefaultTimeout: () => {} }],
          cookies: async () => [{ name: "session", value: "fixture" }],
          close: async () => {
            closed = true;
          },
        };
      },
      youtube: {
        create: async (options) => {
          expect(options.cookie).toBe("session=fixture");
          return { getInfo: async (id) => ({ basic_info: { id, view_count: 42, like_count: 0 } }) };
        },
      },
    },
  );
  expect(result).toEqual({ metrics: { views: 42, likes: 0 } });
  expect(closed).toBe(true);
});
test("browser collection reads embedded counts without clicking or publishing", async () => {
  let closed = false;
  const result = await collectAnalytics(
    { platform: "tiktok", job_id: "fixture", url: "https://www.tiktok.com/@kualta/video/123456789" },
    {
      stateDir: "/unused",
      open: async () => ({
        pages: () => [
          {
            setDefaultTimeout: () => {},
            on: () => {},
            goto: async (url) => expect(url).toBe("https://www.tiktok.com/@kualta/video/123456789"),
            evaluate: async () => ({ item: { id: "123456789", stats: { playCount: 100, diggCount: 5 } } }),
            waitForTimeout: async () => {},
          },
        ],
        close: async () => {
          closed = true;
        },
      }),
    },
  );
  expect(result).toEqual({ metrics: { views: 100, likes: 5 } });
  expect(closed).toBe(true);
});
