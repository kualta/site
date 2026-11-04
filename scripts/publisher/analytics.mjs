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
    // A YouTube post shows likes and replies as text; a rounded "1.2K" stays unknown rather than guessed.
    if (platform === "youtube" && item.postId === id) {
      const text = (value) =>
        (value?.simpleText ?? value?.runs?.map((run) => run.text).join("") ?? "").replace(/,/g, "").trim();
      values = {
        likes: text(item.voteCount),
        comments: text(item.actionButtons?.commentActionButtonsRenderer?.replyButton?.buttonRenderer?.text),
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
/**
 * A video's lifetime retention from YouTube Studio's analytics reply. Studio takes up to two days to process it, and
 * until then the retention curve is empty and the totals beside it are provisional, so they're left out.
 * Studio's own "average percentage viewed" divides by the whole-second length, so that's the length kept.
 */
export function youtubeRetention(id, payload) {
  let totals;
  let length;
  walk(payload, (item) => {
    if (item.videoId !== id) return;
    if (item.metricTotals && item.retentionValues?.length) totals = item.metricTotals;
    if (/^\d+$/.test(item.lengthSeconds ?? "")) length = Number(item.lengthSeconds) * 1000;
  });
  return totals ? counts({ average_watch_ms: Math.round(totals.avgViewDurationMillis), duration_ms: length }) : {};
}
/** TikTok Studio's numbers for one of the account's videos: only the `_realtime` kinds stay filled in as it ages. */
export function tiktokInsights(id, utcOffset = -new Date().getTimezoneOffset()) {
  const kinds = ["video_info", "video_view_realtime", "video_per_duration_realtime"];
  const requests = JSON.stringify(kinds.map((kind) => ({ insigh_type: kind, aweme_id: id })));
  return `https://www.tiktok.com/aweme/v2/data/insight/?locale=en&aid=1988&tz_offset=${
    utcOffset * 60
  }&type_requests=${encodeURIComponent(requests)}`;
}
/** Average watch time is play time over plays, replays included, as Studio shows it. A private or unplayed video has none. */
export function tiktokRetention(id, data) {
  const value = (key) => (data?.[key]?.value?.status === 0 ? data[key].value.value : undefined);
  if (data?.status_code !== 0 || data.video_info?.aweme_id !== id || !value("realtime_total_video_views")) return {};
  return counts({
    average_watch_ms: Math.round(value("video_per_duration_realtime") * 1000),
    duration_ms: data.video_info.video?.duration,
  });
}
/** The key X's analytics know this exact post's video by. GIFs and photos have none. */
export function tweetVideoKey(id, payload) {
  let key = null;
  walk(payload, (item) => {
    if (item.rest_id !== id && item.id_str !== id) return;
    const media = (item.legacy || item).extended_entities?.media ?? [];
    key ??= media.find((m) => m.type === "video" && /^(?:7|13)_\d+$/.test(m.media_key ?? ""))?.media_key ?? null;
  });
  return key;
}
/** The id X's video analytics page takes: a small binary record around the media key, with X's own type numbers. */
export function apiMediaId(key) {
  const [kind, number] = key.split("_");
  const bytes = Buffer.alloc(25);
  bytes.write("ApiMedia:");
  bytes[9] = 0x0c;
  bytes.writeUInt16BE({ 13: 4, 7: 12 }[kind], 10);
  bytes[12] = 0x0a;
  bytes.writeUInt16BE(1, 13);
  bytes.writeBigUInt64BE(BigInt(number), 15);
  return bytes.toString("base64");
}
/** X's lifetime average watch time is per start, autoplay included. A video nobody started has none. */
export function xRetention(key, payload) {
  const media = payload?.data?.api_media_v2;
  const starts = Number(media?.video_quartile_views?.find((stage) => stage.stage === "Start")?.total);
  if (media?.media_key !== key || !(starts > 0)) return {};
  return counts({
    average_watch_ms: Math.round(media.average_watch_time_for_video),
    duration_ms: media.media_info?.duration_millis,
  });
}
/**
 * Xiaohongshu's data center figures for a video note. Below zero means it has none to show, as before the account has
 * data access. The note list gives the length in whole seconds.
 */
export function xiaohongshuRetention(reply, note) {
  const data = reply?.code === 0 ? reply.data : null;
  const average = data?.view_time_avg_with_double;
  if (note?.type !== "video" || typeof average !== "number" || average < 0 || !(data.view_count > 0)) return {};
  return counts({ average_watch_ms: Math.round(average * 1000), duration_ms: note.video_info?.duration * 1000 });
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
    const { id, url, post: youtubePost } = deletionDestination(target.platform, target.url, { id: target.job_id });
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
    /** Opens a creator page and reads the reply that carries its numbers. Awaited together, neither can go unhandled. */
    const replyTo = async (page, address, endpoint) => {
      const [response] = await Promise.all([
        page.waitForResponse((reply) => reply.ok() && endpoint.test(reply.url()), { timeout: 30_000 }),
        page.goto(address, { waitUntil: "domcontentloaded", timeout: 30_000 }),
      ]);
      return response.json();
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
      // No RedNote page asks for the data center's figures, so the note manager asks, signed by its own signer.
      if (metrics.views && note.type === "video") {
        try {
          const reply = await page.evaluate(
            async (path) => {
              const signed = window._webmsxyw(path, undefined);
              const response = await fetch(path, { headers: { "X-s": signed["X-s"], "X-t": String(signed["X-t"]) } });
              return response.ok ? response.json() : null;
            },
            `/api/galaxy/creator/datacenter/note/base?note_id=${encodeURIComponent(id)}`,
          );
          Object.assign(metrics, xiaohongshuRetention(reply, note));
        } catch {
          // The note list's counts still stand.
        }
      }
    } else if (target.platform === "youtube" && youtubePost) {
      // A post's page carries its counts in ytInitialData: read publicly, else in the signed-in profile.
      const response = await fetcher(url, {
        headers: { "Accept-Language": "en" },
        signal: AbortSignal.timeout(20_000),
      }).catch(() => null);
      const html = response?.ok ? await response.text() : "";
      const initial = html.match(/var ytInitialData = (\{.*?\});<\/script>/s)?.[1];
      metrics = initial ? extractMetrics("youtube", id, JSON.parse(initial)) : {};
      if (!Object.keys(metrics).length) {
        context = await open(join(stateDir, target.platform), true);
        const page = context.pages()[0] || (await context.newPage());
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        metrics = extractMetrics("youtube", id, await page.evaluate(() => window.ytInitialData ?? null));
      }
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
      // Only the channel sees how long people watched, in Studio. Headless Chrome needs letting in on every load.
      if (metrics.views) {
        try {
          context ??= await open(join(stateDir, target.platform), true);
          const page = context.pages()[0] || (await context.newPage());
          const reply = await replyTo(
            page,
            `https://studio.youtube.com/video/${id}/analytics/tab-overview/period-default?approve_browser_access=true`,
            /^https:\/\/studio\.youtube\.com\/youtubei\/v1\/yta_web\/get_screen/,
          );
          Object.assign(metrics, youtubeRetention(id, reply));
        } catch {
          // The public counts still stand.
        }
      }
    } else {
      context = await open(join(stateDir, target.platform), true);
      const page = context.pages()[0] || (await context.newPage());
      page.setDefaultTimeout(20_000);
      metrics = {};
      let videoKey = null;
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
          .then((data) => {
            Object.assign(metrics, extractMetrics(target.platform, id, data));
            if (target.platform === "twitter") videoKey ??= tweetVideoKey(id, data);
          })
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
        if (target.platform === "twitter") videoKey ??= tweetVideoKey(id, embedded);
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
      // X shows watch time on the video's own analytics page, which comes with Premium.
      if (target.platform === "twitter" && videoKey && metrics.views) {
        try {
          const reply = await replyTo(
            page,
            `https://x.com/i/account_analytics/video/${encodeURIComponent(apiMediaId(videoKey))}`,
            /^https:\/\/(?:[\w-]+\.)?x\.com\/i\/api\/graphql\/[\w-]+\/videoDetailsProviderQuery/,
          );
          Object.assign(metrics, xRetention(videoKey, reply));
        } catch {
          // The post's own counts still stand.
        }
      }
      // Studio answers its own unsigned request with the session's cookies, without loading Studio.
      if (target.platform === "tiktok" && metrics.views && !new URL(url).pathname.includes("/photo/")) {
        try {
          const response = await context.request.get(tiktokInsights(id), { timeout: 20_000 });
          Object.assign(metrics, tiktokRetention(id, await response.json()));
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
