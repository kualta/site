import type Hls from "hls.js";
import type { BlueskyMedia } from "@/lib/activity/bluesky-media";
import { createPreviewStream } from "./activity-video-stream";

interface Preview {
  button: HTMLElement;
  item: BlueskyMedia;
  video?: HTMLVideoElement;
  hls?: Hls;
  /** invalidates an in-flight start once the preview stops being the active one */
  generation: number;
  ratio: number;
}

/** Below this the video is mostly off screen, and whatever sits above it deserves the playback. */
const VISIBLE_ENOUGH = 0.55;

/** A video the reader turned the sound on for keeps it until it is scrolled this far away. */
const STILL_HEARD = 0.25;

/**
 * How much of the video the reader has, measured against the screen once the
 * video is taller than it — a portrait clip on a phone never fills a ratio.
 */
function coverage(entry: IntersectionObserverEntry): number {
  const screen = entry.rootBounds?.height ?? window.innerHeight;
  const measure = Math.min(entry.boundingClientRect.height, screen);
  return measure > 0 ? entry.intersectionRect.height / measure : 0;
}

const previews = new Map<HTMLElement, Preview>();
let observer: IntersectionObserver | undefined;
let active: Preview | undefined;
/** The one video playing with sound, because the reader clicked it. */
let heard: Preview | undefined;
let suspended = false;

/** Autoplay is motion nobody asked for, and a metered connection pays for it by the megabyte. */
function autoplayWanted(): boolean {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  return !(navigator as { connection?: { saveData?: boolean } }).connection?.saveData;
}

function createPreviewVideo(item: BlueskyMedia, button: HTMLElement): HTMLVideoElement {
  const video = document.createElement("video");
  video.className = "activity-video-preview";
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = "none";
  video.tabIndex = -1;
  // The thumbnail underneath and the button's own label already carry this frame.
  video.setAttribute("aria-hidden", "true");
  if (item.thumbnail) video.poster = item.thumbnail;
  // Only a frame that actually arrived is worth covering the thumbnail with.
  video.addEventListener("playing", () => {
    button.dataset.previewPlaying = "true";
  });
  return video;
}

function label(preview: Preview): void {
  const alt = preview.item.alt ? `: ${preview.item.alt}` : "";
  preview.button.setAttribute("aria-label", preview === heard ? `Open video${alt}` : `Play video with sound${alt}`);
}

/** Sound belongs to the click that asked for it, so a video that loses its turn goes quiet again. */
function hush(preview: Preview): void {
  if (heard === preview) heard = undefined;
  preview.button.removeAttribute("data-preview-sound");
  if (preview.video) preview.video.muted = true;
  label(preview);
}

function stop(preview: Preview): void {
  preview.generation++;
  preview.button.removeAttribute("data-preview-playing");
  hush(preview);
  preview.video?.pause();
}

/** Frees the stream once a preview leaves the screen; a long feed would otherwise keep every one. */
function release(preview: Preview): void {
  stop(preview);
  preview.hls?.destroy();
  preview.hls = undefined;
  if (preview.video) {
    preview.video.removeAttribute("src");
    preview.video.load();
    preview.video.remove();
    preview.video = undefined;
  }
}

async function play(preview: Preview): Promise<void> {
  const generation = ++preview.generation;
  const video = preview.video ?? createPreviewVideo(preview.item, preview.button);
  preview.video = video;
  if (!video.isConnected) preview.button.append(video);
  if (!preview.hls && !video.src) {
    const { default: HlsPlayer } = await import("hls.js");
    if (preview.generation !== generation) return;
    if (HlsPlayer.isSupported()) {
      const hls = createPreviewStream(HlsPlayer);
      // A preview that cannot load falls back to its thumbnail instead of an error.
      hls.on(HlsPlayer.Events.ERROR, (_event, data) => {
        if (data.fatal) release(preview);
      });
      hls.loadSource(preview.item.src);
      hls.attachMedia(video);
      preview.hls = hls;
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = preview.item.src;
    } else {
      return;
    }
  }
  video.muted = preview !== heard;
  await video.play().catch(() => {
    // A browser that withholds sound still gets the silent preview; another click asks again.
    if (video.muted || preview.generation !== generation) return;
    hush(preview);
    // Low Power Mode and friends refuse even muted autoplay; the thumbnail stays.
    return video.play().catch(() => {});
  });
}

/** One video plays at a time: the one with sound, else the one the reader has most of on screen. */
function refresh(): void {
  if (heard && (suspended || heard.ratio < STILL_HEARD)) hush(heard);
  let best = heard;
  if (!best && !suspended && autoplayWanted()) {
    for (const preview of previews.values()) {
      if (preview.ratio >= VISIBLE_ENOUGH && (!best || preview.ratio > best.ratio)) best = preview;
    }
  }
  if (best === active) return;
  // A preview that lost its turn by scrolling away has no buffer worth keeping.
  if (active) (active.ratio === 0 ? release : stop)(active);
  active = best;
  if (active) void play(active);
}

function observe(preview: Preview): void {
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const seen = previews.get(entry.target as HTMLElement);
        if (!seen) continue;
        seen.ratio = coverage(entry);
        if (seen.ratio === 0 && seen !== active) release(seen);
      }
      refresh();
    },
    // A video taller than the screen tops out well below 1, so the steps stay low enough to catch it.
    { threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] },
  );
  observer.observe(preview.button);
}

/** Takes over a feed video's thumbnail: it plays muted once enough of it is on screen. */
export function registerVideoPreview(button: HTMLElement, item: BlueskyMedia): void {
  const existing = previews.get(button);
  if (existing) {
    observe(existing);
    return;
  }
  const preview: Preview = { button, item, generation: 0, ratio: 0 };
  previews.set(button, preview);
  label(preview);
  observe(preview);
}

/**
 * A click on a feed video plays it right there with sound, whether or not it
 * was already running silent. False once it has sound, when the click asks for
 * the full player instead, and for a video too far off screen to hear.
 */
export function hearVideoPreview(button: HTMLElement): boolean {
  const preview = previews.get(button);
  if (!preview || preview === heard || preview.ratio < STILL_HEARD) return false;
  heard = preview;
  preview.button.dataset.previewSound = "true";
  label(preview);
  if (preview === active) void play(preview);
  else refresh();
  return true;
}

/** Picks previews back up when their row returns to the document. */
export function reobserveVideoPreviews(root: ParentNode): void {
  for (const [button, preview] of previews) {
    if (root.contains(button)) observe(preview);
  }
}

/** Rows are replaced as the feed polls, so previews let go with the DOM they were built on. */
export function releaseVideoPreviews(root: ParentNode): void {
  for (const [button, preview] of previews) {
    if (!root.contains(button)) continue;
    if (active === preview) active = undefined;
    observer?.unobserve(button);
    release(preview);
    previews.delete(button);
  }
}

/** Where the reader is in a preview, so the viewer can pick the video up from there. */
export function getPreviewTime(button: HTMLElement): number | undefined {
  const video = previews.get(button)?.video;
  return video && video.currentTime > 0 ? video.currentTime : undefined;
}

/** Feed playback is pointless behind the open viewer, and doubles the bandwidth. */
export function suspendVideoPreviews(): void {
  suspended = true;
  refresh();
}

export function resumeVideoPreviews(): void {
  suspended = false;
  refresh();
}
