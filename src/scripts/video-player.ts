import type Hls from "hls.js";
import { initializeVideoControls } from "./activity-video-controls";
import { createVideoStream } from "./activity-video-stream";

/**
 * Brings server-rendered player markup to life: a frame with `data-src`, its
 * video and the shared controls. Returns what tears it down again.
 */
export function mountVideoPlayer(frame: HTMLElement): () => void {
  const video = frame.querySelector("video");
  const src = frame.dataset.src;
  if (!video || !src) return () => {};
  const error = frame.querySelector<HTMLElement>("[data-video-error]");
  let disposed = false;
  let hls: Hls | undefined;
  const release = initializeVideoControls(frame, video, { keyboard: "page" });

  function fail(): void {
    if (!disposed && error) error.hidden = false;
  }

  video.addEventListener("error", fail);
  void (async () => {
    try {
      const { default: HlsPlayer } = await import("hls.js");
      if (disposed) return;
      if (HlsPlayer.isSupported()) {
        hls = createVideoStream(HlsPlayer, frame);
        hls.on(HlsPlayer.Events.ERROR, (_event, data) => {
          if (data.fatal) fail();
        });
        hls.loadSource(src);
        hls.attachMedia(video);
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = src;
      } else {
        throw new Error("HLS unavailable");
      }
      if (frame.dataset.autoplay === undefined) return;
      // a browser that withholds sound should still play rather than sit on the poster
      void video.play().catch(() => {
        video.muted = true;
        return video.play().catch(() => {});
      });
    } catch {
      fail();
    }
  })();

  return () => {
    disposed = true;
    release();
    video.removeEventListener("error", fail);
    video.pause();
    hls?.destroy();
    video.removeAttribute("src");
    video.load();
  };
}
