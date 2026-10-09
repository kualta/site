import { parsePostUri } from "./urls";
import { normalizeBlueskyPost } from "@/lib/activity/providers/bluesky";
import { attachLinkPreviews } from "@/lib/activity/link-preview";
import type { BlueskyActivity } from "@/lib/activity/types";

export type PublicPostResult = { status: 200; event: BlueskyActivity } | { status: 404 | 503 };
/** Always use public AppView data: no visitor authorization enters server caches. */
export async function loadPublicPost(
  uri: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = 3_000,
  previewTimeoutMs = 1_500,
): Promise<PublicPostResult> {
  if (!parsePostUri(uri)) return { status: 404 };
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const url = new URL("https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts");
    url.searchParams.append("uris", uri);
    const result = await Promise.race([
      (async (): Promise<PublicPostResult> => {
        const response = await fetcher(url, { signal: abort.signal });
        if (!response.ok) return { status: 503 };
        const body = await response.json();
        if (!Array.isArray(body.posts)) return { status: 503 };
        const raw = body.posts.find((post: { uri?: string }) => post?.uri === uri);
        if (!raw) return { status: 404 };
        const event = normalizeBlueskyPost(raw);
        return event ? { status: 200, event } : { status: 503 };
      })(),
      new Promise<PublicPostResult>((resolve) => {
        timer = setTimeout(() => {
          abort.abort();
          resolve({ status: 503 });
        }, timeoutMs);
      }),
    ]);
    if (result.status !== 200) return result;
    // the card has its own budget, so a slow one costs the page its card, never the post
    const [event] = await attachLinkPreviews([result.event], [], fetcher, previewTimeoutMs);
    return { status: 200, event: event as BlueskyActivity };
  } catch {
    return { status: 503 };
  } finally {
    clearTimeout(timer);
  }
}
