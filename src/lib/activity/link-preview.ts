import type { Post as BlueskyPostView } from "@astro-community/astro-embed-bluesky";
import type { ActivityEvent, ActivityFetch, LinkPreview } from "./types";
import { asRecord } from "./validation";

// the service the Bluesky app builds its own link cards from, so a card here
// matches the one the post would have carried; it also proxies the thumbnail,
// so a visitor's browser never contacts the linked site
const CARD_API = "https://cardyb.bsky.app/v1/extract";
const CARD_IMAGE_HOST = "cardyb.bsky.app";
const LINK_FACET = "app.bsky.richtext.facet#link";
const MAX_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 300;
const MAX_DESCRIPTION_LENGTH = 1000;
// a refresh never waits on more cards than this; the rest follow next minute
const MAX_LOOKUPS = 8;
const LOOKUP_TIMEOUT_MS = 3_000;

type Uri = LinkPreview["uri"];

function webUrl(value: unknown): Uri | undefined {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || url.protocol === "http:") return url.href as Uri;
  } catch {}
  return undefined;
}

function cardImage(value: unknown): Uri | undefined {
  const url = webUrl(value);
  if (!url) return undefined;
  const { protocol, hostname } = new URL(url);
  return protocol === "https:" && hostname === CARD_IMAGE_HOST ? url : undefined;
}

function clippedText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

/** The first web link in a post with no embed; anything embedded already has its own card. */
export function previewableLink(post: BlueskyPostView): string | undefined {
  if (post.embed) return undefined;
  const facets = asRecord(post.record)?.facets;
  if (!Array.isArray(facets)) return undefined;

  let first: { start: number; uri: string } | undefined;
  for (const value of facets) {
    const facet = asRecord(value);
    const start = asRecord(facet?.index)?.byteStart;
    const features = facet?.features;
    if (typeof start !== "number" || !Array.isArray(features) || (first && first.start <= start)) continue;

    const link = features.map(asRecord).find((feature) => feature?.$type === LINK_FACET);
    const uri = webUrl(link?.uri);
    if (uri) first = { start, uri };
  }
  return first?.uri;
}

export function sanitizeLinkPreview(value: unknown): LinkPreview | null | undefined {
  if (value === null) return null;

  const preview = asRecord(value);
  const uri = webUrl(preview?.uri);
  const title = clippedText(preview?.title, MAX_TITLE_LENGTH);
  const description = clippedText(preview?.description, MAX_DESCRIPTION_LENGTH);
  if (!uri || (!title && !description)) return undefined;

  const thumb = cardImage(preview?.thumb);
  return { uri, title, description, ...(thumb ? { thumb } : {}) };
}

/**
 * A card, null when the page has nothing to show, or undefined when the
 * lookup itself failed and is worth asking again.
 */
async function lookUpLinkPreview(
  link: string,
  fetch: ActivityFetch,
  signal: AbortSignal,
): Promise<LinkPreview | null | undefined> {
  try {
    const url = new URL(CARD_API);
    url.searchParams.set("url", link);
    const response = await fetch(url, { signal, headers: { accept: "application/json" } });
    // the service answers 400 for a page it could not read
    if (response.status === 400) return null;
    if (!response.ok) return undefined;

    const card = asRecord(await response.json());
    if (!card) return undefined;
    return (
      sanitizeLinkPreview({ uri: link, title: card.title, description: card.description, thumb: card.image }) ?? null
    );
  } catch {
    return undefined;
  }
}

/**
 * Gives each bare link its card. Posts cannot be edited, so a card found once
 * is carried forward from `known` rather than looked up again every minute.
 */
export async function attachLinkPreviews(
  events: readonly ActivityEvent[],
  known: readonly ActivityEvent[],
  fetch: ActivityFetch,
  timeoutMs = LOOKUP_TIMEOUT_MS,
): Promise<ActivityEvent[]> {
  const previews = new Map<string, LinkPreview | null>();
  for (const event of known) {
    if (event.source === "bluesky" && event.linkPreview !== undefined) previews.set(event.uri, event.linkPreview);
  }

  const wanted = new Map<string, string>();
  for (const event of events) {
    if (event.source !== "bluesky" || previews.has(event.uri) || wanted.size >= MAX_LOOKUPS) continue;
    const link = previewableLink(event.post);
    if (link) wanted.set(event.uri, link);
  }

  if (wanted.size > 0) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lookups = Promise.all(
      [...wanted].map(async ([uri, link]) => {
        const preview = await lookUpLinkPreview(link, fetch, controller.signal);
        if (preview !== undefined) previews.set(uri, preview);
      }),
    );
    try {
      await Promise.race([
        lookups,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve();
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  return events.map((event) => {
    if (event.source !== "bluesky" || !previews.has(event.uri)) return event;
    return { ...event, linkPreview: previews.get(event.uri) };
  });
}
