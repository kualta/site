import type { AppBskyFeedPost } from "@atproto/api";
import type { BlueskyAuthSnapshot } from "./auth";
import type { ComposerAttachment } from "./media";
import { parsePostUri, sitePostPath } from "./urls";

export interface PublishedFeedPost {
  uri: string;
  cid: string;
  record: AppBskyFeedPost.Record;
  author: NonNullable<BlueskyAuthSnapshot["profile"]>;
  media: { url: string; alt: string; video: boolean }[];
  canonical?: HTMLElement;
}
const posts = new Map<string, PublishedFeedPost>();
export function getPublishedFeedPost(uri: string) {
  return posts.get(uri);
}
function release(post: PublishedFeedPost) {
  for (const media of post.media) URL.revokeObjectURL(media.url);
  post.media = [];
}
/** Only retain acknowledged writes in this browser's memory, never shared/private state. */
export function rememberPublishedPost(
  result: { uri: string; cid: string; record: AppBskyFeedPost.Record },
  author: PublishedFeedPost["author"],
  attachments: ComposerAttachment[],
): PublishedFeedPost {
  if (parsePostUri(result.uri)?.did !== author.did || !result.cid)
    throw new Error("Published post identity could not be verified. Check Bluesky before retrying.");
  const post: PublishedFeedPost = {
    ...result,
    author,
    media: attachments.map((file) => ({
      url: URL.createObjectURL(file.file),
      alt: file.alt,
      video: file.file.type.startsWith("video/"),
    })),
  };
  const previous = posts.get(post.uri);
  if (previous) release(previous);
  posts.set(post.uri, post);
  window.dispatchEvent(new Event("bluesky:published"));
  void hydratePublishedPost(post.uri);
  return post;
}
/** Same URI reconciles by identity, not event IDs or AppView indexing timestamps. */
export function reconcilePublishedRows(rows: HTMLElement[]): HTMLElement[] {
  for (const row of rows) {
    const card = row.querySelector<HTMLElement>("[data-post-uri]");
    const uri = card?.dataset.postUri;
    const post = uri && posts.get(uri);
    if (
      post &&
      !row.dataset.publishedRetained &&
      card?.dataset.postCid === post.cid &&
      card.dataset.postAction === "post"
    ) {
      post.canonical = row.cloneNode(true) as HTMLElement;
      release(post);
    }
  }
  const local = [...posts.values()]
    .sort((a, b) => b.record.createdAt.localeCompare(a.record.createdAt))
    .map((post) => {
      if (post.canonical) {
        const row = post.canonical.cloneNode(true) as HTMLElement;
        const onServerPage = rows.some((candidate) => {
          const card = candidate.querySelector<HTMLElement>("[data-post-uri]");
          return (
            !candidate.dataset.publishedRetained &&
            card?.dataset.postUri === post.uri &&
            card.dataset.postAction === "post" &&
            card.dataset.postCid === post.cid
          );
        });
        if (!onServerPage) {
          delete row.dataset.activityCursor;
          row.dataset.publishedRetained = "true";
        }
        return row;
      }
      const row = document.createElement("li");
      row.dataset.postUri = post.uri;
      row.dataset.activityRow = `published:${post.uri}:${post.cid}`;
      row.dataset.activityOccurredAt = post.record.createdAt;
      const card = document.createElement("published-feed-post");
      card.dataset.uri = post.uri;
      row.append(card);
      return row;
    });
  const merged = rows.filter((row) => {
    const card = row.querySelector<HTMLElement>("[data-post-uri]");
    return card?.dataset.postAction !== "post" || !posts.has(card.dataset.postUri ?? "");
  });
  for (const row of local) {
    const timestamp = row.dataset.activityOccurredAt || "";
    const index = merged.findIndex(
      (other) => other.dataset.activityOccurredAt && other.dataset.activityOccurredAt < timestamp,
    );
    if (index < 0) merged.push(row);
    else merged.splice(index, 0, row);
  }
  return merged;
}
export function restorePublishedRows(list: HTMLOListElement) {
  // Keep already loaded historical rows when an acknowledged post arrives.
  const rows = [...list.children] as HTMLElement[];
  list.replaceChildren(...reconcilePublishedRows(rows.filter((row) => !row.querySelector("published-feed-post"))));
}
async function hydratePublishedPost(uri: string) {
  for (const delay of [0, 1000, 2000, 5000, 10000, 30000]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const post = posts.get(uri);
    if (!post || post.canonical) return;
    try {
      const response = await fetch(`${sitePostPath(uri)}/row`, { signal: AbortSignal.timeout(4000) });
      if (!response.ok) continue;
      const template = document.createElement("template");
      template.innerHTML = await response.text();
      const row = template.content.querySelector<HTMLElement>("li[data-activity-row]");
      const card = row?.querySelector<HTMLElement>("[data-post-uri]");
      if (
        !row ||
        card?.dataset.postUri !== uri ||
        card.dataset.postCid !== post.cid ||
        card.dataset.postAction !== "post"
      )
        continue;
      post.canonical = row;
      release(post);
      window.dispatchEvent(new Event("bluesky:published"));
      return;
    } catch {
      /* The repo write succeeded; public indexing can arrive later. */
    }
  }
}

/** Historical pages may overlap a locally retained acknowledged post. */
export function uniqueHistoricalRows(list: HTMLElement, rows: HTMLElement[]): HTMLElement[] {
  const seen = new Set(
    [...list.querySelectorAll<HTMLElement>("[data-post-uri]")].map(
      (card) => `${card.dataset.postAction || "post"}:${card.dataset.postUri}`,
    ),
  );
  return rows.filter((row) => {
    const card = row.querySelector<HTMLElement>("[data-post-uri]");
    if (!card) return true;
    const key = `${card.dataset.postAction || "post"}:${card.dataset.postUri}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Derive the replacement boundary from server rows before adding local posts. */
export function mergeNewestRows(existing: HTMLElement[], incoming: HTMLElement[]): HTMLElement[] {
  if (!incoming.length) return reconcilePublishedRows(existing);
  const anchor = incoming[incoming.length - 1].dataset.activityRow;
  const index = anchor ? existing.findIndex((row) => row.dataset.activityRow === anchor) : -1;
  const merged = reconcilePublishedRows([...incoming, ...(index < 0 ? [] : existing.slice(index + 1))]);
  const signature = (rows: HTMLElement[]) =>
    rows
      .map(
        (row) =>
          `${row.dataset.activityRow || "boundary"}:${row.dataset.activityCount || ""}:${
            row.dataset.activityCursor || ""
          }:${row.querySelector<HTMLElement>("[data-post-cid]")?.dataset.postCid || ""}`,
      )
      .join("|");
  return signature(existing) === signature(merged) ? existing : merged;
}
