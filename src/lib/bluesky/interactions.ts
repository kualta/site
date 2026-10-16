import { uploadMedia, type ComposerAttachment } from "./media";
import { AppBskyFeedPost, RichText, Agent, type AppBskyFeedDefs } from "@atproto/api";

export async function fetchInteractionPost(agent: Agent, uri: string) {
  const { data } = await agent.getPosts({ uris: [uri] });
  const post = data.posts.find((candidate) => candidate.uri === uri);
  if (!post) throw new Error("This post is no longer available.");
  return post;
}

/** Resolve viewer state and CID at action time, not from the shared feed cache. */
export async function togglePostLike(agent: Agent, uri: string, knownLike?: string | null) {
  const post = await fetchInteractionPost(agent, uri);
  const existing = knownLike === undefined ? post.viewer?.like : knownLike;
  if (existing) {
    await agent.deleteLike(existing);
    return { ...post, likeCount: Math.max(0, (post.likeCount ?? 1) - 1), viewer: { ...post.viewer, like: undefined } };
  }
  const like = await agent.like(post.uri, post.cid);
  return { ...post, likeCount: (post.likeCount ?? 0) + 1, viewer: { ...post.viewer, like: like.uri } };
}

export async function togglePostRepost(agent: Agent, uri: string, knownRepost?: string | null) {
  const post = await fetchInteractionPost(agent, uri);
  const existing = knownRepost === undefined ? post.viewer?.repost : knownRepost;
  if (existing) {
    await agent.deleteRepost(existing);
    return {
      ...post,
      repostCount: Math.max(0, (post.repostCount ?? 1) - 1),
      viewer: { ...post.viewer, repost: undefined },
    };
  }
  const repost = await agent.repost(post.uri, post.cid);
  return { ...post, repostCount: (post.repostCount ?? 0) + 1, viewer: { ...post.viewer, repost: repost.uri } };
}

/** Thrown when the earlier repost was deleted but its replacement was not written, so the post is no longer reposted. */
export class RepostRemovedError extends Error {
  constructor(readonly post: AppBskyFeedDefs.PostView) {
    super("Your earlier repost was removed, but the new one failed. Repost to try again.");
  }
}

/** The AppView ignores a second repost of the same post, so replace the existing record to resurface it in feeds. */
export async function repostAgain(agent: Agent, uri: string, knownRepost?: string | null) {
  const post = await fetchInteractionPost(agent, uri);
  const existing = knownRepost === undefined ? post.viewer?.repost : knownRepost;
  if (existing) await agent.deleteRepost(existing);
  // An existing record the AppView has not indexed yet is missing from repostCount.
  const indexed = post.viewer?.repost ? 1 : 0;
  try {
    const repost = await agent.repost(post.uri, post.cid);
    return {
      ...post,
      repostCount: (post.repostCount ?? 0) + 1 - indexed,
      viewer: { ...post.viewer, repost: repost.uri },
    };
  } catch (cause) {
    if (!existing) throw cause;
    throw new RepostRemovedError({
      ...post,
      repostCount: Math.max(0, (post.repostCount ?? 0) - indexed),
      viewer: { ...post.viewer, repost: undefined },
    });
  }
}

export async function replyToPost(agent: Agent, uri: string, text: string, images: ComposerAttachment[] = []) {
  const richText = new RichText({ text: text.trim() });
  if ((!richText.text && !images.length) || richText.graphemeLength > 300) throw new Error("Write a reply of 1–300 characters.");
  const post = await fetchInteractionPost(agent, uri);
  if (post.viewer?.replyDisabled) throw new Error("Replies are disabled for this post.");
  const parent = { uri: post.uri, cid: post.cid };
  const record = AppBskyFeedPost.isRecord(post.record) ? (post.record as AppBskyFeedPost.Record) : undefined;
  const root = record?.reply?.root ?? parent;
  await richText.detectFacets(new Agent({ service: "https://public.api.bsky.app" }));
  const embed = await uploadMedia(agent, images);
  return agent.post({ text: richText.text, facets: richText.facets, reply: { parent, root }, ...(embed ? { embed } : {}) });
}
