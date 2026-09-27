import { blueskyProfileUrl } from "@/lib/bluesky/urls";
import { BskyAgent, RichText, AppBskyFeedPost, AppBskyFeedDefs } from "@atproto/api";
import { fetchInteractionPost } from "./interactions";
import type { Agent } from "@atproto/api";

export type CommentPost = AppBskyFeedDefs.PostView;
export const publicCommentsAgent = new BskyAgent({ service: "https://api.bsky.app" });

function normalizedUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol)) return null;
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/$/, "") || "/";
    return url.toString();
  } catch {
    return null;
  }
}

/** Search can fuzzy-match URLs; only include links to this exact article. */
export function linksToArticle(post: CommentPost, articleUrl: string): boolean {
  if (!AppBskyFeedPost.isRecord(post.record)) return false;
  const record = post.record as AppBskyFeedPost.Record;
  const links =
    record.facets?.flatMap((facet) =>
      facet.features.flatMap((feature) =>
        feature.$type === "app.bsky.richtext.facet#link" && "uri" in feature && typeof feature.uri === "string"
          ? [feature.uri]
          : [],
      ),
    ) ?? [];
  const embed = record.embed;
  if (
    embed?.$type === "app.bsky.embed.external" &&
    "external" in embed &&
    typeof embed.external === "object" &&
    embed.external !== null &&
    "uri" in embed.external
  ) {
    links.push(String(embed.external.uri));
  }
  const target = normalizedUrl(articleUrl);
  return target !== null && links.some((link) => normalizedUrl(link) === target);
}

export function visibleComment(post: CommentPost): boolean {
  return (
    !post.author.viewer?.blockedBy &&
    !post.author.viewer?.blocking &&
    !post.author.viewer?.muted &&
    ![...(post.labels ?? []), ...(post.author.labels ?? [])].some(
      (label) => !label.neg && ["!hide", "!warn", "porn", "sexual", "graphic-media"].includes(label.val),
    )
  );
}

export function threadComments(thread: AppBskyFeedDefs.ThreadViewPost): CommentPost[] {
  const result: CommentPost[] = [];
  const visit = (node: AppBskyFeedDefs.ThreadViewPost) => {
    if (!visibleComment(node.post)) return;
    result.push(node.post);
    for (const reply of node.replies ?? []) {
      if (AppBskyFeedDefs.isThreadViewPost(reply)) visit(reply);
    }
  };
  visit(thread);
  return result;
}

export function mergeComments(existing: CommentPost[], incoming: CommentPost[]): CommentPost[] {
  return [...new Map([...existing, ...incoming].map((post) => [post.uri, post])).values()];
}

export async function loadArticleComments(agent: Agent, url: string, cursor?: string) {
  const { data } = await agent.app.bsky.feed.searchPosts({ q: "*", url, sort: "latest", limit: 20, cursor });
  const roots = data.posts.filter((post) => linksToArticle(post, url) && visibleComment(post));
  const threads = await Promise.allSettled(
    roots.map((post) => agent.getPostThread({ uri: post.uri, depth: 6, parentHeight: 0 })),
  );
  let posts = roots;
  for (const thread of threads) {
    if (thread.status === "fulfilled" && AppBskyFeedDefs.isThreadViewPost(thread.value.data.thread)) {
      posts = mergeComments(posts, threadComments(thread.value.data.thread));
    }
  }
  return { posts, cursor: data.cursor, incomplete: threads.some((thread) => thread.status === "rejected") };
}

export function commentRecord(
  text: string,
  articleUrl: string,
  title: string,
  parent?: CommentPost,
): AppBskyFeedPost.Record {
  const richText = new RichText({ text: text.trim() });
  if (!richText.text || richText.graphemeLength > 300) throw new Error("Write a comment of 1–300 characters.");
  if (new TextEncoder().encode(richText.text).length > 3000)
    throw new Error("This comment contains too many complex characters. Please shorten it.");
  const parentRecord = parent?.record as AppBskyFeedPost.Record | undefined;
  return {
    $type: "app.bsky.feed.post",
    text: richText.text,
    createdAt: new Date().toISOString(),
    embed: { $type: "app.bsky.embed.external", external: { uri: articleUrl, title, description: "" } },
    ...(parent
      ? {
          reply: {
            parent: { uri: parent.uri, cid: parent.cid },
            root:
              AppBskyFeedPost.isRecord(parentRecord) && parentRecord.reply
                ? parentRecord.reply.root
                : { uri: parent.uri, cid: parent.cid },
          },
        }
      : {}),
  };
}

export function commentUrl(post: Pick<CommentPost, "uri" | "author">): string {
  return `${blueskyProfileUrl(post.author.did)}/post/${encodeURIComponent(post.uri.split("/").pop() ?? "")}`;
}

export async function publishArticleComment(
  agent: Agent,
  text: string,
  url: string,
  title: string,
  parent?: CommentPost,
) {
  const freshParent = parent ? await fetchInteractionPost(agent, parent.uri) : undefined;
  if (freshParent?.viewer?.replyDisabled) throw new Error("Replies are disabled for this post.");
  if (freshParent && !visibleComment(freshParent)) throw new Error("This conversation is unavailable.");
  const record = commentRecord(text, url, title, freshParent);
  const richText = new RichText({ text: record.text });
  await richText.detectFacets(publicCommentsAgent);
  record.facets = richText.facets;
  const result = await agent.post(record);
  return { ...result, record };
}
