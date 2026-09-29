import { join } from "node:path";
import { Innertube } from "youtubei.js";
import { openProfile } from "./browser.mjs";
import { deletionDestination } from "./delete.mjs";

function counts(values) {
  return Object.fromEntries(
    Object.entries(values).flatMap(([key, value]) => {
      if (typeof value === "string" && /^\d+$/.test(value)) value = Number(value);
      return Number.isSafeInteger(value) && value >= 0 ? [[key, value]] : [];
    }),
  );
}
/** Only the exact post's object contributes counts, never recommendations or account totals. */
export function extractMetrics(platform, id, payload) {
  const result = {};
  const stack = [payload];
  let visited = 0;
  while (stack.length && visited++ < 50_000) {
    const item = stack.pop();
    if (!item || typeof item !== "object") continue;
    let values;
    if (platform === "twitter" && (item.rest_id === id || item.id_str === id)) {
      const post = item.legacy || item;
      values = {
        views: item.views?.count,
        likes: post.favorite_count,
        comments: post.reply_count,
        shares: post.retweet_count,
        saves: post.bookmark_count,
      };
    }
    if (platform === "instagram" && (item.code === id || item.shortcode === id)) {
      values = {
        views: item.play_count ?? item.video_view_count ?? item.view_count,
        likes: item.like_count ?? item.edge_media_preview_like?.count,
        comments: item.comment_count ?? item.edge_media_to_comment?.count,
      };
    }
    if (platform === "tiktok" && String(item.id) === id) {
      const stats = item.stats || item.statsV2 || {};
      values = {
        views: stats.playCount,
        likes: stats.diggCount,
        comments: stats.commentCount,
        shares: stats.shareCount,
        saves: stats.collectCount,
      };
    }
    if (platform === "xiaohongshu" && (item.note_id === id || item.noteId === id)) {
      const stats = item.interact_info || item.interactInfo || {};
      values = {
        views: item.view_count ?? item.viewCount,
        likes: stats.liked_count ?? stats.likedCount,
        comments: stats.comment_count ?? stats.commentCount,
        shares: stats.share_count ?? stats.shareCount,
        saves: stats.collected_count ?? stats.collectedCount,
      };
    }
    if (values) Object.assign(result, counts(values));
    for (const value of Object.values(item)) if (value && typeof value === "object") stack.push(value);
  }
  return result;
}
export async function collectAnalytics(
  target,
  { stateDir, open = openProfile, fetcher = fetch, youtube = Innertube } = {},
) {
  let context;
  try {
    const { id, url } = deletionDestination(target.platform, target.url, { id: target.job_id });
    const request = async (url) => {
      const response = await fetcher(url, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error("Metrics request failed");
      return response.json();
    };
    let metrics;
    if (target.platform === "bluesky" || target.platform === "grain") {
      const actor = new URL(target.url).pathname.split("/")[2];
      if (target.platform === "bluesky") {
        const uri = `at://${actor}/app.bsky.feed.post/${id}`;
        const data = await request(
          `https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(uri)}`,
        );
        const post = data.posts?.find((post) => post.uri === uri);
        metrics = counts({ likes: post?.likeCount, comments: post?.replyCount, shares: post?.repostCount });
      } else {
        const uri = `at://${actor}/social.grain.gallery/${id}`;
        const data = await request(
          `https://grain.social/xrpc/social.grain.unspecced.getGallery?gallery=${encodeURIComponent(uri)}`,
        );
        if (data.gallery?.uri !== uri) throw new Error("Gallery not found");
        metrics = counts({ likes: data.gallery.favCount, comments: data.gallery.commentCount });
      }
    } else {
      context = await open(join(stateDir, target.platform), true);
      const page = context.pages()[0] || (await context.newPage());
      page.setDefaultTimeout(20_000);
      if (target.platform === "youtube") {
        const cookies = await context.cookies("https://www.youtube.com");
        const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
        const client = await youtube.create({
          cookie,
          retrieve_player: false,
          fetch: (input, init) => fetcher(input, { ...init, signal: AbortSignal.timeout(20_000) }),
        });
        const info = await client.getInfo(id);
        if (info.basic_info.id !== id) throw new Error("Video not found");
        metrics = counts({ views: info.basic_info.view_count, likes: info.basic_info.like_count });
      } else {
        metrics = {};
        const pending = new Set();
        const hosts = {
          twitter: /^(?:[^.]+\.)?(?:x|twitter)\.com$/,
          instagram: /(^|\.)instagram\.com$/,
          tiktok: /(^|\.)tiktok\.com$/,
          xiaohongshu: /(^|\.)xiaohongshu\.com$/,
        };
        page.on("response", (response) => {
          if (
            !response.ok() ||
            !hosts[target.platform].test(new URL(response.url()).hostname) ||
            !response.headers()["content-type"]?.includes("json")
          )
            return;
          const task = response
            .json()
            .then((data) => Object.assign(metrics, extractMetrics(target.platform, id, data)))
            .catch(() => {})
            .finally(() => pending.delete(task));
          pending.add(task);
        });
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        const deadline = Date.now() + 15_000;
        while (!Object.keys(metrics).length && Date.now() < deadline) {
          const embedded = await page.evaluate(() => {
            const data = [...document.querySelectorAll('script[type="application/json"]')].map((script) => {
              try {
                return JSON.parse(script.textContent || "null");
              } catch {
                return null;
              }
            });
            if (window.__INITIAL_STATE__) data.push(window.__INITIAL_STATE__);
            return data;
          });
          Object.assign(metrics, extractMetrics(target.platform, id, embedded));
          if (!Object.keys(metrics).length) await page.waitForTimeout(1000);
        }
        await Promise.race([Promise.allSettled([...pending]), page.waitForTimeout(2000)]);
      }
    }
    return Object.keys(metrics).length
      ? { metrics }
      : { error: "Counts are unavailable. The platform may hide metrics or require reconnecting." };
  } catch {
    return { error: "Could not refresh metrics. Check the platform connection or try again later." };
  } finally {
    await context?.close().catch(() => {});
  }
}
