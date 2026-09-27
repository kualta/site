import { useEffect, useRef } from "react";
import { AppBskyEmbedGallery, AppBskyEmbedImages, AppBskyEmbedVideo } from "@atproto/api";
import type { CommentPost } from "@/lib/bluesky/comments";
function Video({ playlist, poster }: { playlist: string; poster?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (element.canPlayType("application/vnd.apple.mpegurl")) {
      element.src = playlist;
      return;
    }
    let disposed = false;
    let destroy: (() => void) | undefined;
    void import("hls.js").then(({ default: Hls }) => {
      if (disposed || !Hls.isSupported()) return;
      const hls = new Hls();
      hls.loadSource(playlist);
      hls.attachMedia(element);
      destroy = () => hls.destroy();
    });
    return () => {
      disposed = true;
      destroy?.();
    };
  }, [playlist]);
  return <video ref={ref} controls playsInline poster={poster} className="mt-3 w-full rounded-lg" />;
}
export default function CommentMedia({ post }: { post: CommentPost }) {
  const images = AppBskyEmbedImages.isView(post.embed)
    ? post.embed.images
    : AppBskyEmbedGallery.isView(post.embed)
      ? post.embed.items.filter(AppBskyEmbedGallery.isViewImage).map((image) => ({ ...image, thumb: image.thumbnail }))
      : [];
  if (images.length)
    return (
      <div className="mt-3 grid grid-cols-2 gap-2">
        {images.map((image) => (
          <a key={image.fullsize} href={image.fullsize} target="_blank" rel="noopener noreferrer">
            <img src={image.thumb} alt={image.alt} loading="lazy" className="w-full rounded-lg" />
          </a>
        ))}
      </div>
    );
  if (AppBskyEmbedVideo.isView(post.embed))
    return <Video playlist={post.embed.playlist} poster={post.embed.thumbnail} />;
  return null;
}
