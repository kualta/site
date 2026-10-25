import { canRenderBlueskyPost } from "@/lib/activity/bluesky-post";
import { normalizeBlueskyPost } from "@/lib/activity/providers/bluesky";
import type { BlueskyActivity } from "@/lib/activity/types";
import { asRecord } from "@/lib/activity/validation";
import { parsePostUri } from "./urls";

const SITE_AUTHOR_DID = "did:plc:jhvnnnd3adml7t6anu3ay7ip";
export interface PostConversation {
  comment: BlueskyActivity;
  replies: BlueskyActivity[];
}

/** Only public, renderable comments with a verified direct reply from the site author. */
export function postConversations(value: unknown, uri: string): PostConversation[] {
  const root = asRecord(value);
  const rootPost = normalizeBlueskyPost(root?.post);
  if (
    root?.$type !== "app.bsky.feed.defs#threadViewPost" ||
    rootPost?.uri !== uri ||
    !canRenderBlueskyPost(rootPost.post)
  )
    return [];
  const conversations: PostConversation[] = [];
  const seen = new Set<string>([uri]);
  function visit(value: unknown, parentUri: string, depth: number) {
    const node = asRecord(value);
    if (depth > 6 || node?.$type !== "app.bsky.feed.defs#threadViewPost") return;
    const comment = normalizeBlueskyPost(node.post);
    if (
      !comment ||
      seen.has(comment.uri) ||
      !canRenderBlueskyPost(comment.post) ||
      comment.post.record.reply?.parent.uri !== parentUri
    )
      return;
    seen.add(comment.uri);
    const children = Array.isArray(node.replies) ? node.replies : [];
    const replyUris = new Set<string>();
    const replies = children.flatMap((child) => {
      const entry = asRecord(child);
      if (entry?.$type !== "app.bsky.feed.defs#threadViewPost") return [];
      const reply = normalizeBlueskyPost(entry.post);
      if (
        !reply ||
        replyUris.has(reply.uri) ||
        reply.post.author.did !== SITE_AUTHOR_DID ||
        reply.post.record.reply?.parent.uri !== comment.uri ||
        !canRenderBlueskyPost(reply.post)
      )
        return [];
      replyUris.add(reply.uri);
      return [reply];
    });
    if (comment.post.author.did !== SITE_AUTHOR_DID && replies.length) {
      conversations.push({ comment, replies });
    }
    for (const child of children) visit(child, comment.uri, depth + 1);
  }
  for (const child of Array.isArray(root.replies) ? root.replies : []) visit(child, uri, 1);
  return conversations;
}

export async function loadPostConversations(
  uri: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = 3_000,
): Promise<PostConversation[] | null> {
  if (!parsePostUri(uri)) return null;
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const url = new URL("https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread");
    url.searchParams.set("uri", uri);
    url.searchParams.set("depth", "6");
    url.searchParams.set("parentHeight", "0");
    return await Promise.race([
      (async () => {
        const response = await fetcher(url, { signal: abort.signal });
        if (!response.ok) return null;
        const body = asRecord(await response.json());
        if (!body?.thread) return null;
        return postConversations(body.thread, uri);
      })(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          abort.abort();
          resolve(null);
        }, timeoutMs);
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
