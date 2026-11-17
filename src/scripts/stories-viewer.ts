import type Hls from "hls.js";
import { createPreviewStream } from "./activity-video-stream";

/** A story as a page hands it over: what `Story` in lib/videos holds. */
export interface ViewerStory {
  rkey: string;
  url: string;
  date: string;
  kind: "photo" | "video";
  src: string;
  thumbnail?: string;
  alt: string;
  width: number;
  height: number;
}
/** Whose stories they are, for the viewer's header. */
export interface StoryAuthor {
  name: string;
  avatar?: string;
}
interface Showing {
  story: ViewerStory;
  element: HTMLImageElement | HTMLVideoElement;
  hls?: Hls;
  /** a photo counts down only once it has loaded */
  ready: boolean;
}

/** How long a photo stays up, as on Instagram. */
const PHOTO_MS = 5000;
/** A press held this long pauses rather than taps. */
const HOLD_MS = 200;
/** A drag this far down closes the viewer. */
const SWIPE_CLOSE_PX = 80;
const SEEN_KEY = "stories-seen";

/** Sound is asked for once a page; after that the viewer keeps what the viewer or the browser settled on. */
let muted: boolean | undefined;
let watched: Set<string> | undefined;

/** The stories this browser has watched, read once a page. */
function seen(): Set<string> {
  if (watched) return watched;
  try {
    const list: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]");
    watched = new Set(Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : []);
  } catch {
    watched = new Set();
  }
  return watched;
}

/** Whether every one of these has been watched here; a ring then turns grey, as on Instagram. */
function allSeen(stories: { rkey: string }[]): boolean {
  const list = seen();
  return stories.every((story) => list.has(story.rkey));
}

/** Notes a story as watched and tells every ring on the page. */
function markSeen(rkey: string): void {
  const list = seen();
  if (list.has(rkey)) return;
  list.add(rkey);
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...list].slice(-2000)));
  } catch {}
  document.dispatchEvent(new CustomEvent("stories:seen"));
}

/** How a ring around these stories looks: colored with one left to watch here, grey once all are, none without any. */
export function ringState(stories: { rkey: string }[]): "none" | "seen" | "unseen" {
  if (!stories.length) return "none";
  return allSeen(stories) ? "seen" : "unseen";
}

/** Fetches the video player as a pointer or focus reaches a ring, so a story can play the moment it opens. */
export function warmWhenNear(ring: HTMLElement, signal?: AbortSignal): void {
  for (const event of ["pointerenter", "focus", "touchstart"])
    ring.addEventListener(event, () => void import("hls.js"), { once: true, passive: true, signal });
}

const dayLabel = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });

/** "Nov 16, 13:40": the date and time written in the story, on the clock it was posted with. */
export function storyTime(date: string): string {
  const day = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(day.getTime()) ? "" : `${dayLabel.format(day)}, ${date.slice(11, 16)}`;
}

/** How long ago a story went up, the way Instagram writes it: now, 12m, 5h, 3d, 2w, 1y. */
export function storyAge(date: string, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - Date.parse(date)) / 60_000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 7)}w`;
  return `${Math.floor(days / 365)}y`;
}

type Open = (groups: ViewerStory[][], group: number, opener: HTMLElement | null, author: StoryAuthor) => void;
let mounted: Open | undefined;

/** Opens the page's story viewer on a group of stories; the groups after it follow on. */
export function openStories(...args: Parameters<Open>): void {
  mounted?.(...args);
}

/**
 * The page's story viewer, shown the way Instagram shows stories: a bar per story along the top, photos for five
 * seconds and videos for their length, tapping the right side for the next and the left third for the one before,
 * holding to pause, and swiping down to close. A group starts at its first story not watched yet.
 */
export function mountStoryViewer(viewer: HTMLElement): () => void {
  const frame = viewer.querySelector<HTMLElement>("[data-story-frame]");
  const media = viewer.querySelector<HTMLElement>("[data-story-media]");
  const bars = viewer.querySelector<HTMLElement>("[data-story-bars]");
  const time = viewer.querySelector<HTMLTimeElement>("[data-story-time]");
  const link = viewer.querySelector<HTMLAnchorElement>("[data-story-link]");
  const authorImage = viewer.querySelector<HTMLImageElement>("[data-story-author-avatar]");
  const authorName = viewer.querySelector<HTMLElement>("[data-story-name]");
  const pauseButton = viewer.querySelector<HTMLButtonElement>("[data-story-pause]");
  const muteButton = viewer.querySelector<HTMLButtonElement>("[data-story-mute]");
  if (!frame || !media || !bars || !time || !link) return () => {};
  viewer.tabIndex = -1;

  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  let groups: ViewerStory[][] = [];
  let group = -1;
  let index = 0;
  let paused = false;
  let elapsed = 0;
  let last = 0;
  let frameRequest = 0;
  let generation = 0;
  let showing: Showing | undefined;
  let opener: HTMLElement | null = null;

  function showSound(): void {
    frame!.dataset.muted = String(muted === true);
    muteButton?.setAttribute("aria-label", muted ? "Unmute" : "Mute");
  }

  function showPaused(): void {
    frame!.dataset.paused = String(paused);
    pauseButton?.setAttribute("aria-label", paused ? "Play" : "Pause");
  }

  /** Each bar fills while its story is up; the ones before it stay full. */
  function progress(share: number): void {
    for (const [position, bar] of [...bars!.children].entries())
      (bar as HTMLElement).style.setProperty(
        "--progress",
        String(position < index ? 1 : position === index ? Math.min(1, Math.max(0, share)) : 0),
      );
  }

  function release(): void {
    generation++;
    if (!showing) return;
    showing.hls?.destroy();
    if (showing.element instanceof HTMLVideoElement) {
      showing.element.pause();
      showing.element.removeAttribute("src");
      showing.element.load();
    }
    showing = undefined;
    media!.replaceChildren();
  }

  function playVideo(video: HTMLVideoElement): void {
    video.muted = muted ?? false;
    void video.play().catch((error: unknown) => {
      // a play cut short by the stream attaching isn't the browser refusing sound
      if (video.muted || (error as Error | undefined)?.name !== "NotAllowedError") return;
      // without a gesture yet, the browser only lets it run silent
      muted = true;
      showSound();
      video.muted = true;
      return video.play().catch(() => {});
    });
  }

  async function attach(video: HTMLVideoElement, entry: Showing, src: string): Promise<void> {
    const mine = generation;
    const { default: HlsPlayer } = await import("hls.js");
    if (mine !== generation) return;
    if (HlsPlayer.isSupported()) {
      const hls = createPreviewStream(HlsPlayer);
      hls.on(HlsPlayer.Events.ERROR, (_event, data) => {
        if (data.fatal && mine === generation) next();
      });
      hls.loadSource(src);
      hls.attachMedia(video);
      entry.hls = hls;
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) video.src = src;
    if (!paused) playVideo(video);
  }

  function show(groupIndex: number, storyIndex: number): void {
    release();
    const list = groups[groupIndex];
    if (groupIndex !== group || bars!.children.length !== list.length)
      bars!.replaceChildren(
        ...list.map(() => {
          const bar = document.createElement("span");
          bar.className = "story-bar";
          return bar;
        }),
      );
    group = groupIndex;
    index = storyIndex;
    elapsed = 0;
    const story = list[storyIndex];
    markSeen(story.rkey);
    // how long ago, as Instagram shows it; the exact time, on the clock it was posted with, on hover
    time!.dateTime = story.date;
    time!.textContent = storyAge(story.date);
    time!.title = storyTime(story.date);
    link!.href = story.url;
    // A story shaped like the frame fills it, cropping its sides as Instagram does: a 9:16 story is about 22% wider than
    // a 19.5:9 phone screen. Any other shape, a square or 4:5 photo, shows whole.
    const frameRatio = frame!.clientWidth / frame!.clientHeight || 9 / 16;
    media!.dataset.fit = Math.abs(story.width / story.height - frameRatio) / frameRatio < 0.3 ? "cover" : "contain";
    if (story.kind === "photo") {
      const image = new Image();
      image.alt = story.alt;
      image.decoding = "async";
      const entry: Showing = { story, element: image, ready: false };
      image.addEventListener("load", () => (entry.ready = true), { once: true });
      // a photo that won't load moves on after its time, like one that did
      image.addEventListener("error", () => (entry.ready = true), { once: true });
      image.src = story.src;
      if (image.complete) entry.ready = true;
      media!.append(image);
      showing = entry;
    } else {
      const video = document.createElement("video");
      video.playsInline = true;
      video.preload = "auto";
      if (story.thumbnail) video.poster = story.thumbnail;
      video.setAttribute("aria-label", story.alt || "Story video");
      const entry: Showing = { story, element: video, ready: true };
      video.addEventListener("ended", () => entry === showing && next(), options);
      media!.append(video);
      showing = entry;
      void attach(video, entry, story.src);
    }
    // the next photo is fetched while this one is up, so it shows at once
    const following = list[storyIndex + 1] ?? groups[groupIndex + 1]?.[0];
    if (following?.kind === "photo") new Image().src = following.src;
  }

  function next(): void {
    if (group < 0) return;
    if (index + 1 < groups[group].length) show(group, index + 1);
    else if (group + 1 < groups.length) show(group + 1, 0);
    else close();
  }

  function previous(): void {
    if (group < 0) return;
    if (index > 0) show(group, index - 1);
    else if (group > 0) show(group - 1, groups[group - 1].length - 1);
    else show(group, 0);
  }

  function setPaused(value: boolean): void {
    paused = value;
    showPaused();
    if (showing?.element instanceof HTMLVideoElement) {
      if (paused) showing.element.pause();
      else playVideo(showing.element);
    }
  }

  function tick(now: number): void {
    const step = last ? now - last : 0;
    last = now;
    let share = 0;
    if (showing?.story.kind === "photo") {
      if (showing.ready && !paused) elapsed += step;
      share = elapsed / PHOTO_MS;
    } else if (showing?.element instanceof HTMLVideoElement) {
      const { currentTime, duration } = showing.element;
      share = Number.isFinite(duration) && duration > 0 ? currentTime / duration : 0;
    }
    progress(share);
    if (showing?.story.kind === "photo" && elapsed >= PHOTO_MS) next();
    if (group >= 0) frameRequest = requestAnimationFrame(tick);
  }

  function open(list: ViewerStory[][], groupIndex: number, from: HTMLElement | null, author: StoryAuthor): void {
    if (!list[groupIndex]?.length) return;
    release();
    groups = list;
    group = -1;
    opener = from;
    if (authorName) authorName.textContent = author.name;
    if (authorImage) {
      authorImage.hidden = !author.avatar;
      if (author.avatar) authorImage.src = author.avatar;
    }
    viewer.hidden = false;
    document.documentElement.dataset.storyOpen = "";
    paused = false;
    showPaused();
    showSound();
    last = 0;
    // a group starts at its first story not seen yet, or from the beginning once all have been
    const unseen = groups[groupIndex].findIndex((story) => !seen().has(story.rkey));
    show(groupIndex, unseen < 0 ? 0 : unseen);
    cancelAnimationFrame(frameRequest);
    frameRequest = requestAnimationFrame(tick);
    viewer.focus();
  }

  function close(): void {
    if (group < 0) return;
    release();
    group = -1;
    cancelAnimationFrame(frameRequest);
    viewer.hidden = true;
    delete document.documentElement.dataset.storyOpen;
    opener?.focus();
  }

  // A tap goes forward or back; a hold pauses until let go; a drag down closes.
  let press: { x: number; y: number; timer: number; held: boolean } | undefined;
  frame.addEventListener(
    "pointerdown",
    (event) => {
      if ((event.target as Element).closest("button, a") || event.button !== 0) return;
      const timer = window.setTimeout(() => {
        if (!press) return;
        press.held = true;
        setPaused(true);
      }, HOLD_MS);
      press = { x: event.clientX, y: event.clientY, timer, held: false };
    },
    options,
  );
  frame.addEventListener(
    "pointerup",
    (event) => {
      if (!press) return;
      const { x, y, timer, held } = press;
      press = undefined;
      clearTimeout(timer);
      if (event.clientY - y > SWIPE_CLOSE_PX) return close();
      if (held) return setPaused(false);
      const bounds = frame.getBoundingClientRect();
      if (x - bounds.left < bounds.width / 3) previous();
      else next();
    },
    options,
  );
  frame.addEventListener(
    "pointercancel",
    () => {
      if (!press) return;
      clearTimeout(press.timer);
      if (press.held) setPaused(false);
      press = undefined;
    },
    options,
  );
  // a long press on a phone would otherwise open the image menu
  frame.addEventListener("contextmenu", (event) => event.preventDefault(), options);

  viewer.querySelector("[data-story-previous]")?.addEventListener("click", previous, options);
  viewer.querySelector("[data-story-next]")?.addEventListener("click", next, options);
  viewer.querySelector("[data-story-close]")?.addEventListener("click", close, options);
  pauseButton?.addEventListener("click", () => setPaused(!paused), options);
  muteButton?.addEventListener(
    "click",
    () => {
      muted = !muted;
      showSound();
      if (showing?.element instanceof HTMLVideoElement) showing.element.muted = muted;
    },
    options,
  );
  // a click on the dark around the story closes it
  viewer.addEventListener("click", (event) => event.target === viewer && close(), options);
  document.addEventListener(
    "keydown",
    (event) => {
      if (group < 0 || event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "arrowright") next();
      else if (key === "arrowleft") previous();
      else if (key === "escape") close();
      else if (key === " " || key === "k") setPaused(!paused);
      else if (key === "m") muteButton?.click();
      else return;
      event.preventDefault();
    },
    options,
  );
  document.addEventListener("visibilitychange", () => document.hidden && group >= 0 && setPaused(true), options);
  mounted = open;

  return () => {
    close();
    listeners.abort();
    if (mounted === open) mounted = undefined;
  };
}
