import { expect, test } from "bun:test";
import { collectAnalytics, extractMetrics, reelsOwner } from "./analytics.mjs";
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
  expect(extractMetrics("twitter", "1", { rest_id: "1", legacy: { retweet_count: 2, quote_count: 3 } })).toEqual({
    shares: 5,
  });
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
            : { posts: [{ uri, likeCount: 4, replyCount: 0, repostCount: 1, quoteCount: 2, bookmarkCount: 3 }] },
        );
      },
    });
    expect(result.metrics.likes).toBe(4);
    expect(result.metrics.views).toBeUndefined();
    expect(result.metrics.comments).toBe(0);
    if (platform === "bluesky") {
      expect(result.metrics.shares).toBe(3);
      expect(result.metrics.saves).toBe(3);
    }
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

const youtubeClient = (views, likes, comments) => ({
  getInfo: async (id) => ({ basic_info: { id, view_count: views, like_count: likes } }),
  getComments: async () => {
    if (comments === undefined) throw new Error("Comments are turned off");
    return { header: { count: { toString: () => comments } } };
  },
});
test("YouTube counts come from a public read, without opening Chrome", async () => {
  const result = await collectAnalytics(
    { platform: "youtube", job_id: "fixture", url: "https://www.youtube.com/shorts/abcdefghijk" },
    {
      open: async () => {
        throw new Error("must not open a browser");
      },
      youtube: {
        create: async (options) => {
          expect(options.cookie).toBeUndefined();
          return youtubeClient(1234, 7, "1,024 Comments");
        },
      },
    },
  );
  expect(result).toEqual({ metrics: { views: 1234, likes: 7, comments: 1024 } });
});
test("YouTube with comments turned off still reports its other counts", async () => {
  const result = await collectAnalytics(
    { platform: "youtube", job_id: "fixture", url: "https://youtu.be/abcdefghijk" },
    { youtube: { create: async () => youtubeClient(42, 0) } },
  );
  expect(result).toEqual({ metrics: { views: 42, likes: 0 } });
});
test("a video hidden from public reads falls back to the saved session and closes Chrome", async () => {
  let closed = false;
  const result = await collectAnalytics(
    { platform: "youtube", job_id: "fixture", url: "https://youtu.be/abcdefghijk" },
    {
      stateDir: "/unused",
      open: async (path, headless) => {
        expect(path).toBe("/unused/youtube");
        expect(headless).toBe(true);
        return {
          cookies: async () => [{ name: "__Secure-3PAPISID", value: "fixture" }],
          close: async () => {
            closed = true;
          },
        };
      },
      youtube: {
        create: async ({ cookie }) => {
          if (!cookie) return { getInfo: async () => ({ basic_info: {} }), getComments: async () => null };
          expect(cookie).toBe("__Secure-3PAPISID=fixture; SAPISID=fixture");
          return youtubeClient(42, undefined, "0 Comments");
        },
      },
    },
  );
  expect(result).toEqual({ metrics: { views: 42, comments: 0 } });
  expect(closed).toBe(true);
});
test("Instagram plays come from the owner's Reels tab, answered as text/javascript", async () => {
  const code = "DfLYVhISS4s";
  const visited = [];
  let listener;
  const reply = (url, type, data) => ({
    ok: () => true,
    url: () => url,
    headers: () => ({ "content-type": type }),
    json: async () => data,
  });
  const result = await collectAnalytics(
    { platform: "instagram", job_id: "fixture", url: `https://www.instagram.com/reel/${code}/` },
    {
      stateDir: "/unused",
      open: async () => ({
        pages: () => [
          {
            setDefaultTimeout: () => {},
            on: (_event, handler) => {
              listener = handler;
            },
            goto: async (url) => {
              visited.push(url);
              if (!url.endsWith("/reels/")) return;
              const media = { code, play_count: 93, view_count: null, like_count: 1 };
              listener(reply("https://www.instagram.com/static/x.js", "text/javascript", { code, play_count: 9000 }));
              listener(reply("https://www.instagram.com/api/graphql", "text/javascript; charset=utf-8", { media }));
            },
            evaluate: async () => [
              { code, user: { username: "kualtx" }, media_type: 2, like_count: 1, comment_count: 0, view_count: null },
            ],
            waitForTimeout: async () => {},
            mouse: { wheel: async () => {} },
          },
        ],
        close: async () => {},
      }),
    },
  );
  expect(visited).toEqual([`https://www.instagram.com/reel/${code}/`, "https://www.instagram.com/kualtx/reels/"]);
  expect(result).toEqual({ metrics: { views: 93, likes: 1, comments: 0 } });
});
test("only a video's owner is looked up, and only with a real username", () => {
  const video = { code: "abc", media_type: 2, user: { username: "kualtx" } };
  expect(reelsOwner("abc", [video])).toBe("kualtx");
  expect(reelsOwner("abc", [{ ...video, media_type: 1 }])).toBeNull();
  expect(reelsOwner("abc", [{ ...video, media_type: 8 }])).toBeNull();
  expect(reelsOwner("abc", [{ ...video, user: { username: "../evil" } }])).toBeNull();
  expect(reelsOwner("other", [video])).toBeNull();
  expect(reelsOwner("abc", undefined)).toBeNull();
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
test("Farcaster and Lens counts come from public reads, without opening a browser", async () => {
  const hash = "0xb379b21f150211f01be6796ad87879d3a9b74579";
  const open = async () => {
    throw new Error("must not open a browser");
  };
  const cast = await collectAnalytics(
    { platform: "farcaster", job_id: "job", url: `https://farcaster.xyz/~/conversations/${hash}` },
    {
      open,
      fetcher: async (url) => {
        const { pathname, searchParams } = new URL(url);
        if (pathname === "/v1/reactionsByCast")
          return Response.json({
            messages: searchParams.get("reaction_type") === "Like" ? [{ hash: "a" }, { hash: "b" }] : [{ hash: "c" }],
            nextPageToken: "",
          });
        expect(pathname).toBe("/v1/castsByParent");
        return Response.json({ messages: [], nextPageToken: "" });
      },
    },
  );
  expect(cast).toEqual({ metrics: { likes: 2, shares: 1, comments: 0 } });
  const lens = await collectAnalytics(
    { platform: "lens", job_id: "job", url: "https://hey.xyz/posts/abc123" },
    {
      open,
      fetcher: async () =>
        Response.json({
          data: { post: { isDeleted: false, stats: { comments: 1, reposts: 2, quotes: 0, reactions: 3, bookmarks: 4 } } },
        }),
    },
  );
  expect(lens).toEqual({ metrics: { likes: 3, comments: 1, shares: 2, saves: 4 } });
});
test("a Farcaster or Lens outage is an error, never zero", async () => {
  const fetcher = async () => {
    throw new Error("offline");
  };
  for (const target of [
    { platform: "farcaster", job_id: "job", url: "https://farcaster.xyz/~/conversations/0xb379b21f150211f01be6796ad87879d3a9b74579" },
    { platform: "lens", job_id: "job", url: "https://hey.xyz/posts/abc123" },
  ])
    expect((await collectAnalytics(target, { fetcher })).error).toBeString();
});
