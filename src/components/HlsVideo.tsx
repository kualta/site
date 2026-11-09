import { useEffect, useRef, useState } from "react";

interface Props {
  src: string;
  poster?: string;
  label: string;
  autoPlay?: boolean;
  unavailable?: string;
}

/** Bluesky serves video as HLS: Safari plays it natively, everything else through hls.js. */
export default function HlsVideo({
  src,
  poster,
  label,
  autoPlay = false,
  unavailable = "Video unavailable. Open the post on Bluesky to watch.",
}: Props) {
  const ref = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let disposed = false;
    let destroy: (() => void) | undefined;
    setFailed(false);
    import("hls.js")
      .then(({ default: Hls }) => {
        if (disposed) return;
        if (!Hls.isSupported()) {
          if (video.canPlayType("application/vnd.apple.mpegurl")) video.src = src;
          else setFailed(true);
          return;
        }
        const hls = new Hls({ capLevelToPlayerSize: true });
        hls.loadSource(src);
        hls.attachMedia(video);
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (data.fatal) setFailed(true);
        });
        destroy = () => hls.destroy();
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
      destroy?.();
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [src]);
  return (
    <>
      <video
        ref={ref}
        controls
        playsInline
        autoPlay={autoPlay}
        preload="metadata"
        poster={poster}
        aria-label={label}
        onError={() => setFailed(true)}
      />
      {failed && <p>{unavailable}</p>}
    </>
  );
}
