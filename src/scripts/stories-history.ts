import { getBlueskyAuthSnapshot, subscribeBlueskyAuth } from "@/lib/bluesky/auth";
import { readStories, storyDays, type StoryDay } from "@/lib/videos";
import { openStories, ringState, type StoryAuthor, warmWhenNear } from "./stories-viewer";

/** History is read a hundred media posts a page; this many reach back years. */
const HISTORY_PAGES = 50;

/**
 * Signed in as the owner, the row of stories goes on past the ones still up into every day of past stories, read from
 * Bluesky in the owner's own browser. Signing out takes them away again.
 */
export function mountStoryHistory(root: HTMLElement): () => void {
  const list = root.querySelector<HTMLElement>("[data-stories-list]");
  const owner = root.dataset.owner;
  if (!list || !owner) return () => {};
  const author: StoryAuthor = {
    name: root.dataset.authorName || "kualta",
    avatar: root.dataset.authorAvatar || undefined,
  };
  const listeners = new AbortController();
  let days: StoryDay[] = [];
  let items: HTMLElement[] = [];
  let loading: AbortController | undefined;

  function paint(): void {
    for (const [position, item] of items.entries()) {
      const button = item.querySelector<HTMLElement>("button");
      if (button && days[position]) button.dataset.state = ringState(days[position].stories);
    }
  }

  function dayItem(day: StoryDay, position: number): HTMLElement {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "story-day";
    button.setAttribute(
      "aria-label",
      `${day.label}: ${day.stories.length} ${day.stories.length === 1 ? "story" : "stories"}`,
    );
    const ring = document.createElement("span");
    ring.className = "story-ring";
    const cover = day.stories.at(-1)?.thumbnail;
    if (cover) {
      const image = new Image();
      image.alt = "";
      image.decoding = "async";
      image.loading = position < 8 ? "eager" : "lazy";
      image.src = cover;
      ring.append(image);
    }
    const label = document.createElement("span");
    label.className = "story-day-label";
    label.textContent = day.label;
    button.append(ring, label);
    button.addEventListener("click", () =>
      openStories(
        days.map((each) => each.stories),
        position,
        button,
        author,
      ),
    );
    warmWhenNear(button);
    item.append(button);
    return item;
  }

  function clear(): void {
    loading?.abort();
    loading = undefined;
    for (const item of items) item.remove();
    items = [];
    days = [];
  }

  async function load(): Promise<void> {
    const controller = new AbortController();
    loading = controller;
    const status = document.createElement("li");
    status.className = "stories-status";
    status.textContent = "Loading your stories…";
    status.setAttribute("role", "status");
    list!.append(status);
    try {
      const stories = await readStories(
        (input, init) =>
          fetch(input, {
            ...init,
            signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]),
          }),
        HISTORY_PAGES,
      );
      if (controller.signal.aborted) return;
      days = storyDays(stories);
      items = days.map(dayItem);
      list!.append(...items);
      paint();
    } catch {
      // Bluesky couldn't be read; the stories still up stay, and the next sign-in tries again.
    } finally {
      status.remove();
      if (loading === controller) loading = undefined;
    }
  }

  function follow(): void {
    const isOwner = getBlueskyAuthSnapshot().profile?.did === owner;
    if (isOwner && !loading && !items.length) void load();
    else if (!isOwner && (loading || items.length)) clear();
  }

  const unsubscribe = subscribeBlueskyAuth(follow);
  follow();
  document.addEventListener("stories:seen", paint, { signal: listeners.signal });
  return () => {
    unsubscribe();
    clear();
    listeners.abort();
  };
}
