import { uploadMedia, type ComposerAttachment } from "./media";
import { AppBskyFeedPost, RichText, Agent, type AppBskyFeedDefs } from "@atproto/api";

export async function fetchInteractionPost(agent: Agent, uri: string) {
  const { data } = await agent.getPosts({ uris: [uri] });
  const post = data.posts.find((candidate) => candidate.uri === uri);
  if (!post) throw new Error("This post is no longer available.");
  return post;
}

/** The most URIs app.bsky.feed.getPosts accepts in one call. */
const GET_POSTS_LIMIT = 25;

type PostWaiter = { resolve: (post: AppBskyFeedDefs.PostView) => void; reject: (cause: unknown) => void };

/**
 * Queue URIs for `windowMs`, then load them in shared getPosts calls, so a feed's
 * rows mounting together cost a request or two rather than one each.
 */
export function createPostLoader(getPosts: (uris: string[]) => Promise<AppBskyFeedDefs.PostView[]>, windowMs = 10) {
  let queue = new Map<string, PostWaiter[]>();
  function flush() {
    const batch = queue;
    queue = new Map();
    const uris = [...batch.keys()];
    for (let start = 0; start < uris.length; start += GET_POSTS_LIMIT) {
      const chunk = uris.slice(start, start + GET_POSTS_LIMIT);
      // each chunk settles on its own, so a failed call only costs its own rows
      Promise.resolve()
        .then(() => getPosts(chunk))
        .then(
          (posts) => {
            for (const uri of chunk) {
              const post = posts.find((candidate) => candidate.uri === uri);
              for (const waiter of batch.get(uri) ?? []) {
                if (post) waiter.resolve(post);
                else waiter.reject(new Error("This post is no longer available."));
              }
            }
          },
          (cause) => {
            for (const uri of chunk) for (const waiter of batch.get(uri) ?? []) waiter.reject(cause);
          },
        );
    }
  }
  return (uri: string) =>
    new Promise<AppBskyFeedDefs.PostView>((resolve, reject) => {
      if (!queue.size) setTimeout(flush, windowMs);
      queue.set(uri, [...(queue.get(uri) ?? []), { resolve, reject }]);
    });
}

let publicAgent: Agent | undefined;
/** Counts for signed-out visitors, from the public AppView, with no viewer state. */
export const fetchPublicPost = createPostLoader(async (uris) => {
  publicAgent ??= new Agent({ service: "https://public.api.bsky.app" });
  const { data } = await publicAgent.getPosts({ uris });
  return data.posts;
});

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
