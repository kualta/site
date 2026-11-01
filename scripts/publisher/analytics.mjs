import { join } from "node:path";
import { Innertube } from "youtubei.js";
import { openProfile } from "./browser.mjs";
import { deletionDestination } from "./delete.mjs";
import { castMetrics } from "./farcaster.mjs";
import { lensMetrics } from "./lens.mjs";
import { creatorOrigin, findNote } from "./rednote.mjs";

function counts(values) {
  return Object.fromEntries(
    Object.entries(values).flatMap(([key, value]) => {
      if (typeof value === "string" && /^\d+$/.test(value)) value = Number(value);
      return Number.isSafeInteger(value) && value >= 0 ? [[key, value]] : [];
    }),
  );
}
function walk(payload, visit) {
  const stack = [payload];
  let visited = 0;
  while (stack.length && visited++ < 50_000) {
    const item = stack.pop();
    if (!item || typeof item !== "object") continue;
    visit(item);
    for (const value of Object.values(item)) if (value && typeof value === "object") stack.push(value);
  }
}
/** Only the exact post's object contributes counts, never recommendations or account totals. */
export function extractMetrics(platform, id, payload) {
  const result = {};
  walk(payload, (item) => {
    let values;
    if (platform === "twitter" && (item.rest_id === id || item.id_str === id)) {
      const post = item.legacy || item;
      values = {
        views: item.views?.count,
        likes: post.favorite_count,
        comments: post.reply_count,
        shares: post.retweet_count + (post.quote_count ?? 0),
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
  });
  return result;
}
/** Whose Reels tab lists this post's plays, read from the post's own page. Photos and carousels have none. */
export function reelsOwner(id, payload) {
  let owner = null;
  let still = false;
  walk(payload, (item) => {
    if (item.code !== id && item.shortcode !== id) return;
    still ||= item.media_type === 1 || item.media_type === 8;
    const username = item.user?.username ?? item.owner?.username;
    if (/^[\w.]+$/.test(username ?? "")) owner = username;
  });
  return still ? null : owner;
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
    /** Comments can be turned off, which leaves that count unknown rather than failing the read. */
    const readYoutube = async (cookie) => {
      const client = await youtube.create({
        cookie,
        retrieve_player: false,
        fetch: (input, init) => fetcher(input, { ...init, signal: AbortSignal.timeout(20_000) }),
      });
      const info = await client.getInfo(id);
      if (info.basic_info.id !== id) throw new Error("Video not found");
      const comments = await client.getComments(id).catch(() => null);
      return counts({
        views: info.basic_info.view_count,
        likes: info.basic_info.like_count,
        comments: comments?.header?.count?.toString().replace(/\D/g, ""),
      });
    };
    let metrics;
    if (target.platform === "farcaster") metrics = counts(await castMetrics(id, { fetcher }));
    else if (target.platform === "lens") metrics = counts(await lensMetrics(id, { fetcher }));
    else if (target.platform === "bluesky" || target.platform === "grain") {
      const actor = new URL(target.url).pathname.split("/")[2];
      if (target.platform === "bluesky") {
        const uri = `at://${actor}/app.bsky.feed.post/${id}`;
        const data = await request(
          `https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(uri)}`,
        );
        const post = data.posts?.find((post) => post.uri === uri);
        metrics = counts({
          likes: post?.likeCount,
          comments: post?.replyCount,
          shares: post && post.repostCount + (post.quoteCount ?? 0),
          saves: post?.bookmarkCount,
        });
      } else {
        const uri = `at://${actor}/social.grain.gallery/${id}`;
        const data = await request(
          `https://grain.social/xrpc/social.grain.unspecced.getGallery?gallery=${encodeURIComponent(uri)}`,
        );
        if (data.gallery?.uri !== uri) throw new Error("Gallery not found");
        metrics = counts({ likes: data.gallery.favCount, comments: data.gallery.commentCount });
      }
    } else if (target.platform === "xiaohongshu") {
      context = await open(join(stateDir, target.platform), true);
      const page = context.pages()[0] || (await context.newPage());
      page.setDefaultTimeout(20_000);
      const { note } = await findNote(page, creatorOrigin(url), id);
      if (!note) throw new Error("Note not found in the creator center");
      metrics = counts({
        views: note.view_count,
        likes: note.likes,
        comments: note.comments_count,
        saves: note.collected_count,
        shares: note.shared_count,
      });
    } else if (target.platform === "youtube") {
      // Signed in, YouTube's reply leaves out the like count, and a public read needs no Chrome.
      metrics = await readYoutube().catch(() => ({}));
      if (metrics.views === undefined) {
        // A video only its owner can see, or YouTube turning an anonymous reader away.
        context = await open(join(stateDir, target.platform), true);
        const cookies = await context.cookies("https://www.youtube.com");
        let cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
        if (!cookies.some((c) => c.name === "SAPISID")) {
          const fallback = cookies.find((c) => c.name === "__Secure-3PAPISID");
          if (fallback) cookie += `; SAPISID=${fallback.value}`;
        }
        metrics = await readYoutube(cookie);
      }
    } else {
      context = await open(join(stateDir, target.platform), true);
      const page = context.pages()[0] || (await context.newPage());
      page.setDefaultTimeout(20_000);
      metrics = {};
      const pending = new Set();
      const hosts = {
        twitter: /^(?:[^.]+\.)?(?:x|twitter)\.com$/,
        instagram: /(^|\.)instagram\.com$/,
        tiktok: /(^|\.)tiktok\.com$/,
        xiaohongshu: /(^|\.)(?:xiaohongshu|rednote)\.com$/,
      };
      const structured = (response) => {
        const type = response.headers()["content-type"] ?? "";
        // Instagram's Reels tab answers with JSON labelled as text/javascript.
        return (
          type.includes("json") ||
          (target.platform === "instagram" &&
            type.includes("javascript") &&
            new URL(response.url()).pathname.endsWith("/graphql"))
        );
      };
      page.on("response", (response) => {
        if (!response.ok() || !hosts[target.platform].test(new URL(response.url()).hostname) || !structured(response))
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
      let embedded;
      while (!Object.keys(metrics).length && Date.now() < deadline) {
        embedded = await page.evaluate(() => {
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
      // A post's own page leaves out plays; its owner's Reels tab lists them.
      const owner = target.platform === "instagram" && metrics.views === undefined && reelsOwner(id, embedded);
      if (owner) {
        try {
          await page.goto(`https://www.instagram.com/${owner}/reels/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
          const scrolling = Date.now() + 12_000;
          while (metrics.views === undefined && Date.now() < scrolling) {
            await page.waitForTimeout(1000);
            await page.mouse.wheel(0, 4000);
          }
        } catch {
          // The post's own counts still stand.
        }
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
