import { expect, test } from "bun:test";
import {
  apiMediaId,
  collectAnalytics,
  extractMetrics,
  reelsOwner,
  tiktokInsights,
  tiktokRetention,
  tweetVideoKey,
  xiaohongshuRetention,
  xRetention,
  youtubeRetention,
} from "./analytics.mjs";
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
test("YouTube counts come from a public read, and a failed Studio read leaves them standing", async () => {
  const result = await collectAnalytics(
    { platform: "youtube", job_id: "fixture", url: "https://www.youtube.com/shorts/abcdefghijk" },
    {
      open: async () => {
        throw new Error("Chrome is busy");
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
test("a YouTube post's likes and replies come from its public page, never a neighbour's or a rounded one", async () => {
  const renderer = (postId, likes, replies) => ({
    backstagePostRenderer: {
      postId,
      voteCount: { simpleText: likes },
      actionButtons: {
        commentActionButtonsRenderer: { replyButton: { buttonRenderer: { text: { simpleText: replies } } } },
      },
    },
  });
  const data = { contents: [renderer("UgkxOther0000", "99", "99"), renderer("UgkxMine00000", "1,204", "8")] };
  const page = `<script>var ytInitialData = ${JSON.stringify(data)};</script>`;
  const result = await collectAnalytics(
    { platform: "youtube", job_id: "fixture", url: "https://www.youtube.com/post/UgkxMine00000" },
    {
      fetcher: async (url) => {
        expect(url).toBe("https://www.youtube.com/post/UgkxMine00000");
        return new Response(page);
      },
      open: async () => {
        throw new Error("must not open a browser");
      },
    },
  );
  expect(result).toEqual({ metrics: { likes: 1204, comments: 8 } });
  expect(extractMetrics("youtube", "UgkxMine00000", renderer("UgkxMine00000", "1.2K", "3"))).toEqual({
    comments: 3,
  });
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
/** Studio's analytics reply: a retention card per video and the video's own details beside it. */
const studioScreen = (videoId, retentionValues = [216.9, 140.2, 98.4]) => ({
  cards: [
    {
      keyMetricCardData: { keyMetricTabs: [] },
      sideEntities: { videos: [{ entityData: { videoId, lengthSeconds: "29" } }] },
    },
    {
      audienceRetentionHighlightsCardData: {
        videosData: [
          { videoId: "someoneElse", metricTotals: { avgViewDurationMillis: 1 }, retentionValues: [1] },
          {
            videoId,
            metricTotals: { avgViewDurationMillis: 39786, avgPercentageWatched: 1.3719, views: 1096 },
            retentionValues,
          },
        ],
      },
    },
  ],
});
test("YouTube retention is the exact video's lifetime card, kept only once Studio has processed it", () => {
  // 39786 of 29000 ms is the 137% Studio shows for a looping short.
  expect(youtubeRetention("KL28a6vW98E", studioScreen("KL28a6vW98E"))).toEqual({
    average_watch_ms: 39786,
    duration_ms: 29000,
  });
  expect(youtubeRetention("KL28a6vW98E", studioScreen("KL28a6vW98E", []))).toEqual({});
  expect(youtubeRetention("missing0000", studioScreen("KL28a6vW98E"))).toEqual({});
});
test("a YouTube video's retention comes from its Studio page, let in as headless Chrome", async () => {
  let closed = false;
  let opened;
  const result = await collectAnalytics(
    { platform: "youtube", job_id: "fixture", url: "https://www.youtube.com/shorts/KL28a6vW98E" },
    {
      stateDir: "/unused",
      youtube: { create: async () => youtubeClient(1213, 30, "4 Comments") },
      open: async (path, headless) => {
        expect(path).toBe("/unused/youtube");
        expect(headless).toBe(true);
        let wanted;
        return {
          pages: () => [
            {
              waitForResponse: (match) =>
                new Promise((resolve) => {
                  wanted = { match, resolve };
                }),
              goto: async (url) => {
                opened = url;
                const reply = (path, data) => ({
                  ok: () => true,
                  url: () => `https://studio.youtube.com/youtubei/v1/yta_web/${path}?alt=json`,
                  json: async () => data,
                });
                for (const response of [reply("get_cards", {}), reply("get_screen", studioScreen("KL28a6vW98E"))])
                  if (wanted.match(response)) wanted.resolve(response);
              },
            },
          ],
          close: async () => {
            closed = true;
          },
        };
      },
    },
  );
  expect(opened).toBe(
    "https://studio.youtube.com/video/KL28a6vW98E/analytics/tab-overview/period-default?approve_browser_access=true",
  );
  expect(result).toEqual({
    metrics: { views: 1213, likes: 30, comments: 4, average_watch_ms: 39786, duration_ms: 29000 },
  });
  expect(closed).toBe(true);
});
/** TikTok Studio's insight reply, as its `_realtime` kinds come back. */
const tiktokInsight = (id, views, average) => ({
  status_code: 0,
  video_info: { aweme_id: id, video: { duration: 28075 } },
  realtime_total_video_views: { value: { status: 0, value: views } },
  video_per_duration_realtime: { value: { status: 0, value: average } },
});
test("TikTok retention is Studio's average watch time, never a private or unplayed video's zero", () => {
  expect(tiktokRetention("77", tiktokInsight("77", 3, 6.06))).toEqual({ average_watch_ms: 6060, duration_ms: 28075 });
  expect(tiktokRetention("77", tiktokInsight("77", 0, 0))).toEqual({});
  expect(tiktokRetention("77", tiktokInsight("78", 3, 6.06))).toEqual({});
  expect(tiktokRetention("77", { ...tiktokInsight("77", 3, 6.06), status_code: 8 })).toEqual({});
  const url = new URL(tiktokInsights("77", -300));
  expect(url.searchParams.get("tz_offset")).toBe("-18000");
  expect(JSON.parse(url.searchParams.get("type_requests"))).toContainEqual({
    insigh_type: "video_per_duration_realtime",
    aweme_id: "77",
  });
});
test("TikTok retention is read with the session's cookies after the post's counts, and only for videos", async () => {
  const read = async (url) => {
    const asked = [];
    const result = await collectAnalytics(
      { platform: "tiktok", job_id: "fixture", url },
      {
        stateDir: "/unused",
        open: async () => ({
          pages: () => [
            {
              setDefaultTimeout: () => {},
              on: () => {},
              goto: async () => {},
              evaluate: async () => ({ item: { id: "123456789", stats: { playCount: 3, diggCount: 1 } } }),
              waitForTimeout: async () => {},
            },
          ],
          request: {
            get: async (url) => {
              asked.push(url);
              return { json: async () => tiktokInsight("123456789", 3, 6.06) };
            },
          },
          close: async () => {},
        }),
      },
    );
    return { result, asked };
  };
  const video = await read("https://www.tiktok.com/@_/video/123456789");
  expect(video.result).toEqual({ metrics: { views: 3, likes: 1, average_watch_ms: 6060, duration_ms: 28075 } });
  expect(video.asked).toHaveLength(1);
  expect(new URL(video.asked[0]).pathname).toBe("/aweme/v2/data/insight/");
  const photo = await read("https://www.tiktok.com/@_/photo/123456789");
  expect(photo.result).toEqual({ metrics: { views: 3, likes: 1 } });
  expect(photo.asked).toEqual([]);
});
/** X's video analytics reply for one video. */
const xDashboard = (key, starts, average) => ({
  data: {
    api_media_v2: {
      media_key: key,
      average_watch_time_for_video: average,
      media_info: { duration_millis: 14000 },
      video_quartile_views: [
        { stage: "Start", total: String(starts) },
        { stage: "Complete", total: "20" },
      ],
    },
  },
});
const tweet = (id, media) => ({ rest_id: id, legacy: { favorite_count: 6, extended_entities: { media } } });
test("X watch time is the exact post's video, read by the id X's own analytics page takes", () => {
  const video = { type: "video", media_key: "13_2105023866871365633" };
  expect(tweetVideoKey("1", { data: [tweet("2", [{ type: "video", media_key: "7_9" }]), tweet("1", [video])] })).toBe(
    video.media_key,
  );
  expect(tweetVideoKey("1", tweet("1", [{ type: "animated_gif", media_key: "16_5" }]))).toBeNull();
  expect(tweetVideoKey("1", tweet("1", [{ type: "photo", media_key: "3_5" }]))).toBeNull();
  // Matches the id X asked for this video by in its own request.
  expect(apiMediaId(video.media_key)).toBe("QXBpTWVkaWE6DAAECgABHTaMDdSWQAEAAA==");
  expect(xRetention(video.media_key, xDashboard(video.media_key, 828, 3918))).toEqual({
    average_watch_ms: 3918,
    duration_ms: 14000,
  });
  expect(xRetention(video.media_key, xDashboard(video.media_key, 0, 0))).toEqual({});
  expect(xRetention(video.media_key, xDashboard("13_1", 828, 3918))).toEqual({});
});
test("an X video's watch time comes from its analytics page after the post's counts", async () => {
  const key = "13_2105023866871365633";
  const visited = [];
  let listener;
  let wanted;
  const json = (url, data) => ({
    ok: () => true,
    url: () => url,
    headers: () => ({ "content-type": "application/json" }),
    json: async () => data,
  });
  const result = await collectAnalytics(
    { platform: "twitter", job_id: "fixture", url: "https://x.com/kualts/status/2105024184535400918" },
    {
      stateDir: "/unused",
      open: async () => ({
        pages: () => [
          {
            setDefaultTimeout: () => {},
            on: (_event, handler) => {
              listener = handler;
            },
            waitForResponse: (match) =>
              new Promise((resolve) => {
                wanted = { match, resolve };
              }),
            goto: async (url) => {
              visited.push(url);
              if (url.includes("/status/")) {
                const post = {
                  ...tweet("2105024184535400918", [{ type: "video", media_key: key }]),
                  views: { count: "1300" },
                };
                listener(json("https://x.com/i/api/graphql/abc/TweetDetail", { data: post }));
                return;
              }
              const reply = json(
                "https://x.com/i/api/graphql/d-U1bmXeRLzJuX2RBbrJxg/videoDetailsProviderQuery",
                xDashboard(key, 828, 3918),
              );
              if (wanted.match(reply)) wanted.resolve(reply);
            },
            evaluate: async () => [],
            waitForTimeout: async () => {},
          },
        ],
        close: async () => {},
      }),
    },
  );
  expect(visited).toEqual([
    "https://x.com/kualts/status/2105024184535400918",
    `https://x.com/i/account_analytics/video/${encodeURIComponent("QXBpTWVkaWE6DAAECgABHTaMDdSWQAEAAA==")}`,
  ]);
  expect(result).toEqual({ metrics: { views: 1300, likes: 6, average_watch_ms: 3918, duration_ms: 14000 } });
});
test("Xiaohongshu watch time is a video note's data-center average, and none while it shows -1", () => {
  const reply = (average, views = 132) => ({
    code: 0,
    success: true,
    data: { view_time_avg_with_double: average, view_count: views },
  });
  const video = { type: "video", video_info: { duration: 37 } };
  expect(xiaohongshuRetention(reply(6.5), video)).toEqual({ average_watch_ms: 6500, duration_ms: 37000 });
  expect(xiaohongshuRetention(reply(-1), video)).toEqual({});
  expect(xiaohongshuRetention(reply(6.5, 0), video)).toEqual({});
  expect(xiaohongshuRetention(reply(6.5), { type: "normal" })).toEqual({});
  expect(xiaohongshuRetention({ code: -1, data: { view_time_avg_with_double: 6.5, view_count: 1 } }, video)).toEqual(
    {},
  );
  expect(xiaohongshuRetention(null, video)).toEqual({});
});
