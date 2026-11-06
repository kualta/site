import type { Post } from "./server";

/** A YouTube video's own still, which stays up as long as the video does. A Short's comes pillarboxed, blurred at the sides. */
export function youtubeThumbnail(url: string | null | undefined) {
  const id = url?.match(/(?:youtu\.be\/|\/shorts\/|[?&]v=)([\w-]{11})/)?.[1];
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
}
/** The post's kept thumbnail, addressed by when it was saved so a new one is never served from cache. */
export const storedThumbnail = (job: string, savedAt: number) => `/api/publisher/thumbnails/${job}?v=${savedAt}`;

/** `upload` marks an upload, which expires: what to keep a thumbnail of while it's still there. */
export type PreviewSource = { src: string; video?: true; upload?: true };
const upload = (id: string) => `/api/publisher/media/${id}`;
/**
 * Where a post's picture can come from, best first: its kept thumbnail, its cover, a still from YouTube, then its
 * first photo or video. Uploads expire after seven days. A video file comes last because the browser downloads it to
 * show a frame.
 */
export function previewSources(
  post: Pick<Post, "kind" | "media" | "mediaKinds" | "cover">,
  links: (string | null | undefined)[],
  stored: string | null = null,
): PreviewSource[] {
  const sources: PreviewSource[] = [];
  if (stored) sources.push({ src: stored });
  if (post.cover) sources.push({ src: upload(post.cover), upload: true });
  const youtube = links.map(youtubeThumbnail).find(Boolean);
  if (youtube) sources.push({ src: youtube });
  const first = post.media[0];
  if (first) {
    const kind = post.mediaKinds?.[0] ?? post.kind;
    sources.push(
      kind === "photo"
        ? { src: upload(first), upload: true }
        : { src: `${upload(first)}#t=0.1`, video: true, upload: true },
    );
  }
  return sources;
}
