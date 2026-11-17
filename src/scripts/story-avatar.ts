import identity from "../../atproto.config.json";
import { liveStories, normalizeStoryPost, type Story } from "@/lib/videos";
import { openStories, ringState, type StoryAuthor, warmWhenNear } from "./stories-viewer";

/** The account's stories still up, and its picture, from its latest media posts on Bluesky. */
async function readLive(signal: AbortSignal): Promise<{ stories: Story[]; avatar?: string }> {
  const url = new URL("https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed");
  url.searchParams.set("actor", identity.did);
  url.searchParams.set("filter", "posts_with_media");
  url.searchParams.set("limit", "50");
  const response = await fetch(url, { signal });
  if (!response.ok) return { stories: [] };
  const body: { feed?: { post?: { author?: { did?: string; avatar?: unknown } }; reason?: unknown }[] } =
    await response.json();
  const feed = Array.isArray(body.feed) ? body.feed : [];
  const stories = feed.flatMap((item) => {
    const story = item.reason ? undefined : normalizeStoryPost(item.post);
    return story ? [story] : [];
  });
  const avatar = feed.find((item) => item.post?.author?.did === identity.did)?.post?.author?.avatar;
  return {
    stories: liveStories(stories),
    avatar: typeof avatar === "string" && avatar.startsWith("https://") ? avatar : undefined,
  };
}

/**
 * The owner's picture in a story ring: colored while a story posted in the last day hasn't been watched here, grey once
 * all have, and none without one. Pressing it plays them.
 */
export function mountStoryAvatar(root: HTMLElement): () => void {
  const button = root.querySelector<HTMLButtonElement>("button");
  const ring = root.querySelector<HTMLElement>(".story-ring");
  if (!button || !ring) return () => {};
  let data: { author?: StoryAuthor; stories?: Story[] | null } = {};
  try {
    data = JSON.parse(root.querySelector("[data-story-avatar-data]")?.textContent || "{}");
  } catch {}
  const author: StoryAuthor = { name: data.author?.name ?? "kualta", avatar: data.author?.avatar };
  let stories = data.stories ?? [];
  const listeners = new AbortController();
  const options = { signal: listeners.signal };

  function paint(): void {
    button!.dataset.state = ringState(stories);
    button!.disabled = !stories.length;
    button!.setAttribute("aria-label", stories.length ? `${author.name}'s story` : author.name);
  }

  paint();
  if (!data.stories)
    void readLive(listeners.signal)
      .then((live) => {
        stories = live.stories;
        if (live.avatar && !author.avatar) {
          author.avatar = live.avatar;
          const image = new Image();
          image.alt = "";
          image.decoding = "async";
          image.src = live.avatar;
          ring.replaceChildren(image);
        }
        paint();
      })
      .catch(() => {});
  button.addEventListener("click", () => openStories([stories], 0, button, author), options);
  warmWhenNear(button, listeners.signal);
  document.addEventListener("stories:seen", paint, options);
  return () => listeners.abort();
}
