function formatTime(seconds: number): string {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

export function initializeVideoControls(frame: HTMLElement, video: HTMLVideoElement): () => void {
  const toggle = frame.querySelector<HTMLButtonElement>(".video-toggle")!;
  const mute = frame.querySelector<HTMLButtonElement>(".video-mute")!;
  const fullscreen = frame.querySelector<HTMLButtonElement>(".video-fullscreen")!;
  const seek = frame.querySelector<HTMLInputElement>(".video-seek")!;
  const volume = frame.querySelector<HTMLInputElement>(".video-volume-range")!;
  const time = frame.querySelector<HTMLElement>(".video-time")!;
  const loading = frame.querySelector<HTMLElement>(".video-loading")!;
  const listeners = new AbortController();
  const options = { signal: listeners.signal };

  function setIcon(selector: string, visible: boolean): void {
    frame.querySelector<HTMLElement>(selector)!.hidden = !visible;
  }

  function updatePlayback(): void {
    toggle.setAttribute("aria-label", video.paused ? "Play" : "Pause");
    setIcon("[data-play-icon]", video.paused);
    setIcon("[data-pause-icon]", !video.paused);
    loading.hidden = video.paused || video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
  }

  function updateTime(): void {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    seek.disabled = duration <= 0;
    seek.max = String(duration || 100);
    seek.value = String(video.currentTime);
    seek.style.setProperty("--progress", `${duration > 0 ? (video.currentTime / duration) * 100 : 0}%`);
    seek.setAttribute("aria-valuetext", `${formatTime(video.currentTime)} of ${formatTime(duration)}`);
    time.textContent = `${formatTime(video.currentTime)} / ${formatTime(duration)}`;
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

  function updateFullscreen(): void {
    const active = document.fullscreenElement === frame;
    fullscreen.setAttribute("aria-label", active ? "Exit fullscreen" : "Enter fullscreen");
    setIcon("[data-expand-icon]", !active);
    setIcon("[data-collapse-icon]", active);
  }

  toggle.addEventListener("click", togglePlayback, options);
  video.addEventListener("click", togglePlayback, options);
  mute.addEventListener(
    "click",
    () => {
      const silent = video.muted || video.volume === 0;
      if (video.volume === 0) video.volume = 1;
      video.muted = !silent;
    },
    options,
  );
  seek.addEventListener(
    "input",
    () => {
      video.currentTime = Number(seek.value);
      updateTime();
    },
    options,
  );
  volume.addEventListener(
    "input",
    () => {
      video.muted = false;
      video.volume = Number(volume.value);
    },
    options,
  );
  fullscreen.hidden = !document.fullscreenEnabled;
  fullscreen.addEventListener(
    "click",
    () => {
      const change = document.fullscreenElement === frame ? document.exitFullscreen() : frame.requestFullscreen();
      void change.catch(() => {
        fullscreen.hidden = true;
      });
    },
    options,
  );
  document.addEventListener("fullscreenchange", updateFullscreen, options);
  frame.addEventListener(
    "keydown",
    (event) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement) return;
      if (event.key === " " || event.key.toLowerCase() === "k") {
        event.preventDefault();
        togglePlayback();
      }
    },
    options,
  );
  for (const event of ["play", "pause", "playing", "waiting", "canplay", "ended"]) {
    video.addEventListener(event, updatePlayback, options);
  }
  for (const event of ["timeupdate", "durationchange", "loadedmetadata"]) {
    video.addEventListener(event, updateTime, options);
  }
  video.addEventListener("volumechange", updateVolume, options);
  updatePlayback();
  updateTime();
  updateVolume();
  return () => listeners.abort();
}
