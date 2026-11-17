import { getBlueskyAuthSnapshot, subscribeBlueskyAuth } from "@/lib/bluesky/auth";
import { readStories, storyDays, type StoryDay } from "@/lib/videos";
import { dayName, renderCalendar } from "./stories-calendar";
import { openStories, ringState, type StoryAuthor, warmWhenNear } from "./stories-viewer";

/** History is read a hundred media posts a page; this many reach back years. */
const HISTORY_PAGES = 50;
/** Whether the owner left the calendar open, kept in this browser. */
const CALENDAR_KEY = "stories-calendar";

/**
 * Signed in as the owner, the row of stories shows every day of past stories, earliest on the left and the stories still
 * up at the right end, so going right is always going later; a calendar lays the same days out by month. Both are read
 * from Bluesky in the owner's own browser, and signing out takes them away again.
 */
export function mountStoryHistory(root: HTMLElement): () => void {
  const list = root.querySelector<HTMLElement>("[data-stories-list]");
  const calendar = root.querySelector<HTMLElement>("[data-stories-calendar]");
  const toggle = root.querySelector<HTMLButtonElement>("[data-stories-calendar-toggle]");
  const owner = root.dataset.owner;
  if (!list || !owner) return () => {};
  const live = list.querySelector<HTMLElement>("li");
  const author: StoryAuthor = {
    name: root.dataset.authorName || "kualta",
    avatar: root.dataset.authorAvatar || undefined,
  };
  const listeners = new AbortController();
  let days: StoryDay[] = [];
  let items: HTMLElement[] = [];
  let loading: AbortController | undefined;

  /** Plays the day at `position`; the days after it follow on. */
  function openDay(position: number, from: HTMLElement): void {
    openStories(
      days.map((day) => day.stories),
      position,
      from,
      author,
    );
  }

  function paint(): void {
    for (const [position, item] of items.entries()) {
      const button = item.querySelector<HTMLElement>("button");
      if (button && days[position]) button.dataset.state = ringState(days[position].stories);
    }
  }

  function showCalendar(open: boolean): void {
    if (!calendar || !toggle) return;
    calendar.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    try {
      localStorage.setItem(CALENDAR_KEY, open ? "open" : "closed");
    } catch {}
  }

  function dayItem(day: StoryDay, position: number): HTMLElement {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "story-day";
    button.setAttribute("aria-label", dayName(day));
    const ring = document.createElement("span");
    ring.className = "story-ring";
    const cover = day.stories.at(-1)?.thumbnail;
    if (cover) {
      const image = new Image();
      image.alt = "";
      image.decoding = "async";
      // the row opens at its latest end
      image.loading = position >= days.length - 8 ? "eager" : "lazy";
      image.src = cover;
      ring.append(image);
    }
    const label = document.createElement("span");
    label.className = "story-day-label";
    label.textContent = day.label;
    button.append(ring, label);
    button.addEventListener("click", () => openDay(position, button));
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
    if (toggle) toggle.hidden = true;
    if (calendar) {
      calendar.hidden = true;
      calendar.replaceChildren();
    }
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
      // the stories still up are the latest, so they close the row
      if (live) list!.append(live);
      list!.scrollLeft = list!.scrollWidth;
      paint();
      if (calendar && toggle) {
        renderCalendar(calendar, days, openDay);
        toggle.hidden = false;
        let open = false;
        try {
          open = localStorage.getItem(CALENDAR_KEY) === "open";
        } catch {}
        showCalendar(open);
      }
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

  toggle?.addEventListener("click", () => showCalendar(calendar?.hidden ?? false), { signal: listeners.signal });
  const unsubscribe = subscribeBlueskyAuth(follow);
  follow();
  document.addEventListener("stories:seen", paint, { signal: listeners.signal });
  return () => {
    unsubscribe();
    clear();
    listeners.abort();
  };
}
