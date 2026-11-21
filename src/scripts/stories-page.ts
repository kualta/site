import { getBlueskyAuthSnapshot, subscribeBlueskyAuth } from "@/lib/bluesky/auth";
import { readStories, storyDays, type StoryDay } from "@/lib/videos";
import { renderCalendar } from "./stories-calendar";
import { openStories, type StoryAuthor } from "./stories-viewer";

/** History is read a hundred media posts a page; this many reach back years. */
const HISTORY_PAGES = 50;

/**
 * The stories page: everyone sees the stories still up; signed in as the owner, a calendar of every day with stories
 * follows, read from Bluesky in the owner's own browser. Signing out takes it away again.
 */
export function mountStoriesPage(root: HTMLElement): () => void {
  const found = root.querySelector<HTMLElement>("[data-stories-calendar]");
  const status = root.querySelector<HTMLElement>("[data-stories-status]");
  const owner = root.dataset.owner;
  if (!found || !owner) return () => {};
  const calendar: HTMLElement = found;
  const author: StoryAuthor = {
    name: root.dataset.authorName || "kualta",
    avatar: root.dataset.authorAvatar || undefined,
  };
  let days: StoryDay[] = [];
  let loading: AbortController | undefined;
  let shown = false;
  /** what the page says before the calendar, such as that no story is up */
  const resting = status?.textContent?.trim() ?? "";

  function say(text: string): void {
    if (!status) return;
    status.textContent = text;
    status.hidden = !text;
  }

  /** Plays the day at `position`; the days after it follow on. */
  function openDay(position: number, from: HTMLElement): void {
    openStories(
      days.map((day) => day.stories),
      position,
      from,
      author,
    );
  }

  function clear(): void {
    loading?.abort();
    loading = undefined;
    shown = false;
    days = [];
    calendar.replaceChildren();
    calendar.hidden = true;
    say(resting);
  }

  async function load(): Promise<void> {
    const controller = new AbortController();
    loading = controller;
    say("Loading your stories…");
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
      renderCalendar(calendar, days, openDay);
      calendar.hidden = false;
      shown = true;
      say(days.length ? "" : "No stories yet.");
    } catch {
      if (!controller.signal.aborted) say("Bluesky couldn't be read. Reload to try again.");
    } finally {
      if (loading === controller) loading = undefined;
    }
  }

  function follow(): void {
    const isOwner = getBlueskyAuthSnapshot().profile?.did === owner;
    if (isOwner && !loading && !shown) void load();
    else if (!isOwner && (loading || shown)) clear();
  }

  const unsubscribe = subscribeBlueskyAuth(follow);
  follow();
  return () => {
    unsubscribe();
    clear();
  };
}
