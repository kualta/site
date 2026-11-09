import type Hls from "hls.js";
import { ownsKey } from "./activity-video-controls";
import { createPreviewStream } from "./activity-video-stream";

interface Short {
  section: HTMLElement;
  frame: HTMLElement;
  video: HTMLVideoElement;
  seek: HTMLInputElement | null;
  src: string;
  hls?: Hls;
  /** invalidates an attach still loading hls.js once the short is let go */
  generation: number;
}

/** Sound is asked for once; after that the feed keeps whatever the viewer or the browser settled on. */
let muted: boolean | undefined;

/**
 * A vertical feed of shorts: the one on screen plays on a loop, its neighbours
 * get their streams ready, and the address follows along.
 */
export function mountShortsFeed(root: HTMLElement): () => void {
  const shorts: Short[] = [...root.querySelectorAll<HTMLElement>("[data-short]")].flatMap((section) => {
    const frame = section.querySelector<HTMLElement>(".short-frame");
    const video = section.querySelector("video");
    const src = section.dataset.src;
    return frame && video && src
      ? [{ section, frame, video, seek: section.querySelector<HTMLInputElement>(".short-seek"), src, generation: 0 }]
      : [];
  });
  const previous = root.querySelector<HTMLButtonElement>("[data-short-previous]");
  const next = root.querySelector<HTMLButtonElement>("[data-short-next]");
  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let active = -1;
  let disposed = false;
  let frameRequest = 0;

  /** The feed fills the screen below the header, whatever height the header has. */
  function fit(): void {
    root.style.setProperty("--shorts-top", `${Math.round(root.getBoundingClientRect().top + window.scrollY)}px`);
  }

  function showSound(): void {
    root.dataset.muted = String(muted === true);
    for (const button of root.querySelectorAll<HTMLElement>("[data-short-mute]"))
      button.setAttribute("aria-label", muted ? "Unmute" : "Mute");
  }

  async function attach(short: Short | undefined): Promise<void> {
    if (!short || short.hls || short.video.getAttribute("src")) return;
    const generation = ++short.generation;
    const { default: HlsPlayer } = await import("hls.js");
    if (disposed || generation !== short.generation || short.hls) return;
    if (HlsPlayer.isSupported()) {
      const hls = createPreviewStream(HlsPlayer);
      hls.on(HlsPlayer.Events.ERROR, (_event, data) => {
        if (data.fatal) short.section.dataset.failed = "";
      });
      hls.loadSource(short.src);
      hls.attachMedia(short.video);
      short.hls = hls;
    } else if (short.video.canPlayType("application/vnd.apple.mpegurl")) {
      short.video.src = short.src;
    }
  }

  /** A short two away from the screen has no buffer worth the memory. */
  function detach(short: Short): void {
    short.generation++;
    short.video.pause();
    short.hls?.destroy();
    short.hls = undefined;
    if (short.video.getAttribute("src")) {
      short.video.removeAttribute("src");
      short.video.load();
    }
  }

  function play(short: Short): void {
    short.video.muted = muted ?? false;
    void short.video.play().catch(() => {
      if (short.video.muted) return;
      // without a gesture yet, the browser only lets it run silent
      muted = true;
      showSound();
      short.video.muted = true;
      return short.video.play().catch(() => {});
    });
  }

  async function activate(index: number): Promise<void> {
    if (index === active || disposed) return;
    const left = shorts[active];
    if (left) {
      left.video.pause();
      // coming back to a short starts it over, the way short feeds do
      if (left.video.readyState > 0) left.video.currentTime = 0;
    }
    active = index;
    for (const [position, short] of shorts.entries()) {
      if (Math.abs(position - index) > 1) detach(short);
    }
    if (previous) previous.disabled = index === 0;
    if (next) next.disabled = index === shorts.length - 1;
    const short = shorts[index];
    const { rkey, title } = short.section.dataset;
    if (rkey && location.pathname !== `/videos/${rkey}`) history.replaceState(history.state, "", `/videos/${rkey}`);
    if (title) document.title = title;
    await attach(short);
    if (disposed || active !== index) return;
    play(short);
    void attach(shorts[index + 1]);
    void attach(shorts[index - 1]);
  }

  function go(offset: number): void {
    const target = shorts[active + offset];
    target?.section.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
  }

  function toggle(short: Short | undefined): void {
    if (!short) return;
    if (short.video.paused) play(short);
    else short.video.pause();
  }

  /** The seek bar follows every frame, so a five-second loop still moves smoothly. */
  function tick(): void {
    const short = shorts[active];
    if (short?.seek && Number.isFinite(short.video.duration) && short.video.duration > 0) {
      const share = (short.video.currentTime / short.video.duration) * 100;
      short.seek.max = String(short.video.duration);
      short.seek.value = String(short.video.currentTime);
      short.seek.style.setProperty("--progress", `${share}%`);
    }
    frameRequest = requestAnimationFrame(tick);
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting || entry.intersectionRatio < 0.6) continue;
        const index = shorts.findIndex((short) => short.section === entry.target);
        if (index >= 0) void activate(index);
      }
    },
    { root, threshold: [0.6] },
  );

  for (const short of shorts) {
    observer.observe(short.section);
    short.video.addEventListener("click", () => toggle(short), options);
    for (const event of ["play", "pause"]) {
      short.video.addEventListener(
        event,
        () => {
          short.frame.dataset.paused = String(short.video.paused);
        },
        options,
      );
    }
    short.seek?.addEventListener(
      "input",
      () => {
        short.video.currentTime = Number(short.seek?.value);
      },
      options,
    );
  }
  for (const button of root.querySelectorAll<HTMLElement>("[data-short-mute]")) {
    button.addEventListener(
      "click",
      () => {
        muted = !muted;
        showSound();
        const short = shorts[active];
        if (short) short.video.muted = muted;
      },
      options,
    );
  }
  previous?.addEventListener("click", () => go(-1), options);
  next?.addEventListener("click", () => go(1), options);
  document.addEventListener(
    "keydown",
    (event) => {
      const key = event.key.toLowerCase();
      if (event.metaKey || event.ctrlKey || event.altKey || ownsKey(event.target, key)) return;
      if (key === "arrowdown" || key === "pagedown") go(1);
      else if (key === "arrowup" || key === "pageup") go(-1);
      else if (key === " " || key === "k") toggle(shorts[active]);
      else if (key === "m") root.querySelector<HTMLElement>("[data-short-mute]")?.click();
      else return;
      event.preventDefault();
    },
    options,
  );
  window.addEventListener("resize", fit, options);
  fit();
  showSound();
  frameRequest = requestAnimationFrame(tick);

  return () => {
    disposed = true;
    observer.disconnect();
    listeners.abort();
    cancelAnimationFrame(frameRequest);
    for (const short of shorts) detach(short);
  };
}
