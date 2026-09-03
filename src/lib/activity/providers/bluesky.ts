import type { ActivityEvent, ActivityProvider, BlueskyActivity, ProviderContext } from "../types";
import { sanitizeBlueskyPostView } from "../bluesky-post";
import { asRecord, safeDate, stringField } from "../validation";

const BLUESKY_ACTOR = "kualta.dev";
const BLUESKY_API = "https://public.api.bsky.app";
const REPOST_REASON = "app.bsky.feed.defs#reasonRepost";

function parsePostUri(uri: string): { did: string; rkey: string } | undefined {
  const match = uri.match(/^at:\/\/(did:[^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/);
  if (!match) return undefined;
  return { did: match[1], rkey: match[2] };
}

function normalizeBlueskyItem(value: unknown): BlueskyActivity | undefined {
  const item = asRecord(value);
  const post = asRecord(item?.post);
  const postView = sanitizeBlueskyPostView(post);
  const record = asRecord(postView?.record);
  const reason = asRecord(item?.reason);
  const author = asRecord(postView?.author);
  const uri = stringField(asRecord(postView), "uri");

  if (!item || !postView || !record || !author || !uri) return undefined;

  const uriParts = parsePostUri(uri);
  const handle = stringField(author, "handle");
  const text = record.text;
  if (!uriParts || !handle || typeof text !== "string") return undefined;

  let action: BlueskyActivity["action"] = "post";
  let occurredAt = safeDate(postView.indexedAt);

  if (stringField(reason, "$type") === REPOST_REASON) {
    action = "repost";
    occurredAt = safeDate(reason?.indexedAt);
  } else if (asRecord(record.reply) || asRecord(item.reply)) {
    action = "reply";
  }

  if (!occurredAt) return undefined;

  const displayName = stringField(author, "displayName")?.trim();

  return {
    id: `bluesky:${action}:${uri}:${occurredAt}`,
    source: "bluesky",
    action,
    occurredAt,
    uri,
    url: `https://bsky.app/profile/${uriParts.did}/post/${uriParts.rkey}`,
    text,
    author: {
      handle,
      ...(displayName ? { displayName } : {}),
    },
    post: postView,
  };
}

export function normalizeBlueskyFeed(value: unknown): BlueskyActivity[] {
  const feed = asRecord(value)?.feed;
  if (!Array.isArray(feed)) throw new Error("Bluesky returned an invalid author feed");

  const events: BlueskyActivity[] = [];
  for (const item of feed) {
    const event = normalizeBlueskyItem(item);
    if (!event) throw new Error("Bluesky returned a malformed feed item");
    if (event.action === "reply") continue;
    events.push(event);
  }
  return events;
}

async function fetchBlueskyActivity(context: ProviderContext): Promise<ActivityEvent[]> {
  const url = new URL(`${BLUESKY_API}/xrpc/app.bsky.feed.getAuthorFeed`);
  url.searchParams.set("actor", BLUESKY_ACTOR);
  url.searchParams.set("limit", "100");
  // replies read as fragments of someone else's conversation, and dropping them
  // upstream spends the hundred-item budget on posts instead
  url.searchParams.set("filter", "posts_no_replies");

  const response = await context.fetch(url, { signal: context.signal });
  if (!response.ok) throw new Error(`Bluesky request failed with status ${response.status}`);

  return normalizeBlueskyFeed(await response.json());
}

export const blueskyProvider: ActivityProvider = {
  id: "bluesky",
  fetch: fetchBlueskyActivity,
};
