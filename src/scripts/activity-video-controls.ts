const VOLUME_KEY = "video-volume";
/** how long a resting pointer leaves the controls up on a playing video */
const IDLE_MS = 2500;

interface Options {
  /** "page" answers shortcuts anywhere on the page, for a page that is the video */
  keyboard?: "frame" | "page";
}

/** 0:07, 4:05, 1:02:03 */
export function formatTime(seconds: number): string {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const rest = String(value % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

function readVolume(): { volume: number; muted: boolean } | undefined {
  try {
    const saved = JSON.parse(localStorage.getItem(VOLUME_KEY) ?? "null");
    if (typeof saved?.volume === "number" && saved.volume >= 0 && saved.volume <= 1)
      return { volume: saved.volume, muted: saved.muted === true };
  } catch {}
}

/** Only what the viewer chose is kept, never a mute the browser imposed on autoplay. */
function saveVolume(video: HTMLVideoElement): void {
  try {
    localStorage.setItem(VOLUME_KEY, JSON.stringify({ volume: video.volume, muted: video.muted }));
  } catch {}
}

/** Typing, picking and dragging own their keys; everything else may drive the video. */
export function ownsKey(target: EventTarget | null, key: string): boolean {
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement
  )
    return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  // a focused button or link already answers space and enter itself
  return (key === " " || key === "enter") && target instanceof Element && !!target.closest("button, a[href]");
}

export function initializeVideoControls(
  frame: HTMLElement,
  video: HTMLVideoElement,
  settings: Options = {},
): () => void {
  const toggle = frame.querySelector<HTMLButtonElement>(".video-toggle")!;
  const mute = frame.querySelector<HTMLButtonElement>(".video-mute")!;
  const fullscreen = frame.querySelector<HTMLButtonElement>(".video-fullscreen")!;
  const seek = frame.querySelector<HTMLInputElement>(".video-seek")!;
  const volume = frame.querySelector<HTMLInputElement>(".video-volume-range")!;
  const time = frame.querySelector<HTMLElement>(".video-time")!;
  const loading = frame.querySelector<HTMLElement>(".video-loading")!;
  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  // iPhone has no element fullscreen, only the video's own
  const nativeFullscreen = (video as HTMLVideoElement & { webkitEnterFullscreen?: () => void }).webkitEnterFullscreen;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  function setIcon(selector: string, visible: boolean): void {
    frame.querySelector<HTMLElement>(selector)!.hidden = !visible;
  }

  function duration(): number {
    return Number.isFinite(video.duration) ? video.duration : 0;
  }

  /** The controls rise on any movement and sink once the pointer rests on a playing video. */
  function wake(): void {
    frame.removeAttribute("data-idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!video.paused) frame.dataset.idle = "";
    }, IDLE_MS);
  }

  function updatePlayback(): void {
    toggle.setAttribute("aria-label", video.paused ? "Play" : "Pause");
    setIcon("[data-play-icon]", video.paused);
    setIcon("[data-pause-icon]", !video.paused);
    frame.dataset.paused = String(video.paused);
    if (video.paused) frame.removeAttribute("data-idle");
    loading.hidden = video.paused || video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
  }

  /** How far the download runs ahead of the playhead. */
  function bufferedTo(): number {
    for (let index = 0; index < video.buffered.length; index++) {
      if (video.buffered.start(index) <= video.currentTime + 0.5 && video.currentTime <= video.buffered.end(index))
        return video.buffered.end(index);
    }
    return video.currentTime;
  }

  function updateTime(): void {
    const total = duration();
    seek.disabled = total <= 0;
    seek.max = String(total || 100);
    seek.value = String(video.currentTime);
    seek.style.setProperty("--progress", `${total > 0 ? (video.currentTime / total) * 100 : 0}%`);
    seek.style.setProperty("--buffered", `${total > 0 ? (bufferedTo() / total) * 100 : 0}%`);
    seek.setAttribute("aria-valuetext", `${formatTime(video.currentTime)} of ${formatTime(total)}`);
    time.textContent = `${formatTime(video.currentTime)} / ${formatTime(total)}`;
  }

  function updateVolume(): void {
    const silent = video.muted || video.volume === 0;
    mute.setAttribute("aria-label", silent ? "Unmute" : "Mute");
    setIcon("[data-volume-icon]", !silent);
    setIcon("[data-muted-icon]", silent);
    volume.value = String(silent ? 0 : video.volume);
    volume.style.setProperty("--progress", `${Number(volume.value) * 100}%`);
  }

  function togglePlayback(): void {
    if (video.paused) void video.play().catch(updatePlayback);
    else video.pause();
  }

  function toggleMute(): void {
    const silent = video.muted || video.volume === 0;
    if (video.volume === 0) video.volume = 1;
    video.muted = !silent;
    saveVolume(video);
  }

  function seekTo(seconds: number): void {
    const total = duration();
    if (total <= 0) return;
    video.currentTime = Math.min(Math.max(0, seconds), total);
    updateTime();
  }

  function toggleFullscreen(): void {
    if (!document.fullscreenEnabled) {
      nativeFullscreen?.call(video);
      return;
    }
    const change = document.fullscreenElement === frame ? document.exitFullscreen() : frame.requestFullscreen();
    void change.catch(() => {
      fullscreen.hidden = true;
    });
  }

  function updateFullscreen(): void {
    const active = document.fullscreenElement === frame;
    fullscreen.setAttribute("aria-label", active ? "Exit fullscreen" : "Enter fullscreen");
    setIcon("[data-expand-icon]", !active);
    setIcon("[data-collapse-icon]", active);
  }

  function onKey(event: KeyboardEvent): void {
    const key = event.key.toLowerCase();
    if (event.metaKey || event.ctrlKey || event.altKey || ownsKey(event.target, key)) return;
    if (key === " " || key === "k") togglePlayback();
    else if (key === "arrowleft" || key === "j") seekTo(video.currentTime - (key === "j" ? 10 : 5));
    else if (key === "arrowright" || key === "l") seekTo(video.currentTime + (key === "l" ? 10 : 5));
    else if (key === "home") seekTo(0);
    else if (key === "end") seekTo(duration());
    else if (/^[0-9]$/.test(key)) seekTo((duration() * Number(key)) / 10);
    else if (key === "m") toggleMute();
    else if (key === "f") toggleFullscreen();
    else return;
    event.preventDefault();
    wake();
  }

  const saved = readVolume();
  if (saved) {
    video.volume = saved.volume;
    if (saved.muted) video.muted = true;
  }
  toggle.addEventListener("click", togglePlayback, options);
  video.addEventListener("click", togglePlayback, options);
  video.addEventListener("dblclick", toggleFullscreen, options);
  mute.addEventListener("click", toggleMute, options);
  seek.addEventListener("input", () => seekTo(Number(seek.value)), options);
  volume.addEventListener(
    "input",
    () => {
      video.muted = false;
      video.volume = Number(volume.value);
      saveVolume(video);
    },
    options,
  );
  fullscreen.hidden = !document.fullscreenEnabled && !nativeFullscreen;
  fullscreen.addEventListener("click", toggleFullscreen, options);
  document.addEventListener("fullscreenchange", updateFullscreen, options);
  if (settings.keyboard === "page") document.addEventListener("keydown", onKey, options);
  else {
    // a click on the picture hands the keys to the player
    if (!frame.hasAttribute("tabindex")) frame.tabIndex = -1;
    frame.addEventListener("keydown", onKey, options);
    video.addEventListener("pointerdown", () => frame.focus({ preventScroll: true }), options);
  }
  for (const event of ["pointermove", "pointerdown"]) frame.addEventListener(event, wake, options);
  video.addEventListener("play", wake, options);
  for (const event of ["play", "pause", "playing", "waiting", "canplay", "ended"]) {
    video.addEventListener(event, updatePlayback, options);
  }
  for (const event of ["timeupdate", "durationchange", "loadedmetadata", "progress"]) {
    video.addEventListener(event, updateTime, options);
  }
  video.addEventListener("volumechange", updateVolume, options);
  updatePlayback();
  updateTime();
  updateVolume();
  return () => {
    clearTimeout(idleTimer);
    listeners.abort();
  };
}
