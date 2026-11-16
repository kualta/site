import type Hls from "hls.js";
import { createPreviewStream } from "./activity-video-stream";

interface Story {
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
interface Day {
  day: string;
  label: string;
  stories: Story[];
}
interface Showing {
  story: Story;
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

function readSeen(): Set<string> {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]");
    return new Set(Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function writeSeen(seen: Set<string>): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-2000)));
  } catch {}
}

/**
 * Stories the way Instagram shows them: one day at a time, a bar per story along the top, photos for five seconds and
 * videos for their length, tapping the right side for the next and the left third for the one before, holding to
 * pause, and swiping down to close. Days follow on from one another.
 */
export function mountStories(root: HTMLElement): () => void {
  let days: Day[] = [];
  try {
    days = JSON.parse(root.querySelector("[data-stories-data]")?.textContent || "{}").days ?? [];
  } catch {}
  const viewer = root.querySelector<HTMLElement>("[data-story-viewer]");
  const frame = root.querySelector<HTMLElement>("[data-story-frame]");
  const media = root.querySelector<HTMLElement>("[data-story-media]");
  const bars = root.querySelector<HTMLElement>("[data-story-bars]");
  const time = root.querySelector<HTMLTimeElement>("[data-story-time]");
  const link = root.querySelector<HTMLAnchorElement>("[data-story-link]");
  const pauseButton = root.querySelector<HTMLButtonElement>("[data-story-pause]");
  const muteButton = root.querySelector<HTMLButtonElement>("[data-story-mute]");
  const trayButtons = [...root.querySelectorAll<HTMLButtonElement>("[data-story-day]")];
  if (!viewer || !frame || !media || !bars || !time || !link || !days.length) return () => {};
  viewer.tabIndex = -1;

  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  const seen = readSeen();
  let day = -1;
  let index = 0;
  let paused = false;
  let elapsed = 0;
  let last = 0;
  let frameRequest = 0;
  let generation = 0;
  let showing: Showing | undefined;
  let opener: HTMLElement | null = null;

  function markTray(): void {
    for (const [position, button] of trayButtons.entries())
      button.dataset.seen = String(days[position]?.stories.every((story) => seen.has(story.rkey)) ?? false);
  }

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

  function show(dayIndex: number, storyIndex: number): void {
    release();
    const list = days[dayIndex].stories;
    if (dayIndex !== day || bars!.children.length !== list.length)
      bars!.replaceChildren(
        ...list.map(() => {
          const bar = document.createElement("span");
          bar.className = "story-bar";
          return bar;
        }),
      );
    day = dayIndex;
    index = storyIndex;
    elapsed = 0;
    const story = list[storyIndex];
    seen.add(story.rkey);
    writeSeen(seen);
    markTray();
    time!.dateTime = story.date;
    // the clock it was posted on, as written in its date
    time!.textContent = `${days[dayIndex].label}, ${story.date.slice(11, 16)}`;
    link!.href = story.url;
    // A story shaped like the frame fills it, cropping its sides as Instagram does: a 9:16 story is about 22% wider than
    // a 19.5:9 phone screen. Any other shape, a square or 4:5 photo, shows whole.
    const frameRatio = frame!.clientWidth / frame!.clientHeight || 9 / 16;
    const fit = Math.abs(story.width / story.height - frameRatio) / frameRatio < 0.3 ? "cover" : "contain";
    media!.dataset.fit = fit;
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
    const following = list[storyIndex + 1] ?? days[dayIndex + 1]?.stories[0];
    if (following?.kind === "photo") new Image().src = following.src;
  }

  function next(): void {
    if (day < 0) return;
    if (index + 1 < days[day].stories.length) show(day, index + 1);
    else if (day + 1 < days.length) show(day + 1, 0);
    else close();
  }

  function previous(): void {
    if (day < 0) return;
    if (index > 0) show(day, index - 1);
    else if (day > 0) show(day - 1, days[day - 1].stories.length - 1);
    else show(day, 0);
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
    if (day >= 0) frameRequest = requestAnimationFrame(tick);
  }

  function open(dayIndex: number, from: HTMLElement | null): void {
    opener = from;
    viewer!.hidden = false;
    document.documentElement.dataset.storyOpen = "";
    paused = false;
    showPaused();
    showSound();
    last = 0;
    // a day starts at its first story not seen yet, or from the beginning once all have been
    const unseen = days[dayIndex].stories.findIndex((story) => !seen.has(story.rkey));
    show(dayIndex, unseen < 0 ? 0 : unseen);
    cancelAnimationFrame(frameRequest);
    frameRequest = requestAnimationFrame(tick);
    viewer!.focus();
  }

  function close(): void {
    if (day < 0) return;
    release();
    day = -1;
    cancelAnimationFrame(frameRequest);
    viewer!.hidden = true;
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

  for (const button of trayButtons) {
    button.addEventListener("click", () => open(Number(button.dataset.storyDay), button), options);
    // the player is fetched as the pointer or focus arrives, so a video can start as soon as its day opens
    for (const event of ["pointerenter", "focus", "touchstart"])
      button.addEventListener(event, () => void import("hls.js"), { ...options, once: true, passive: true });
  }
  root.querySelector("[data-story-previous]")?.addEventListener("click", previous, options);
  root.querySelector("[data-story-next]")?.addEventListener("click", next, options);
  root.querySelector("[data-story-close]")?.addEventListener("click", close, options);
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
      if (day < 0 || event.metaKey || event.ctrlKey || event.altKey) return;
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
  document.addEventListener("visibilitychange", () => document.hidden && day >= 0 && setPaused(true), options);
  markTray();

  return () => {
    close();
    listeners.abort();
  };
}
