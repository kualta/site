export const platforms = [
  "grain",
  "instagram",
  "bluesky",
  "twitter",
  "farcaster",
  "lens",
  "xiaohongshu",
  "youtube",
  "tiktok",
] as const;
export type Platform = (typeof platforms)[number];
/** What a post carries, decided by its attachments: none, photos, one video, or photos and videos together. */
export const kinds = ["text", "photo", "video", "mixed"] as const;
export type PostKind = (typeof kinds)[number];
export type MetadataPolicy = "remove-location" | "remove-all";
export const platformNames: Record<Platform, string> = {
  grain: "Grain",
  instagram: "Instagram",
  bluesky: "Bluesky",
  twitter: "X / Twitter",
  farcaster: "Farcaster",
  lens: "Lens",
  xiaohongshu: "Xiaohongshu",
  youtube: "YouTube",
  tiktok: "TikTok",
};
export const kindNames: Record<PostKind, string> = { text: "Text", photo: "Photo", video: "Video", mixed: "Media" };
export const support: Record<Platform, readonly PostKind[]> = {
  grain: ["photo"],
  // Instagram carousels, X, Farcaster and Lens mix photos and videos; Bluesky's gallery, Xiaohongshu's notes, TikTok's
  // photo posts and YouTube's posts hold photos only.
  instagram: ["photo", "video", "mixed"],
  bluesky: ["text", "photo", "video"],
  twitter: ["text", "photo", "video", "mixed"],
  farcaster: ["text", "photo", "video", "mixed"],
  lens: ["text", "photo", "video", "mixed"],
  xiaohongshu: ["photo", "video"],
  // Photos go to TikTok as a photo post and to YouTube as a post on the channel's Posts tab.
  youtube: ["photo", "video"],
  tiktok: ["photo", "video"],
};
/** Photos and videos in one post: Instagram's carousel holds 20, and its web uploader drops any past that. */
export const MAX_PHOTOS = 20;
/** Destinations that take fewer photos or videos per post than MAX_PHOTOS. TikTok takes 35. */
export const photoLimits: Partial<Record<Platform, number>> = {
  twitter: 4,
  farcaster: 2,
  lens: 4,
  // Bluesky's gallery asks apps to stop at 10 of the 20 it can hold.
  bluesky: 10,
  youtube: 10,
  xiaohongshu: 18,
};
/** Longest video, in seconds, where a destination has a limit. */
export const videoLimits: Partial<Record<Platform, number>> = { bluesky: 180 };
/**
 * Whether a destination publishes the post's title, so a post to it needs one: Grain's galleries and YouTube's
 * videos have one, YouTube's posts don't. Xiaohongshu has its own Chinese title.
 */
export const needsTitle = (platform: Platform, kind: PostKind): boolean =>
  platform === "grain" || (platform === "youtube" && kind === "video");
/** YouTube shows a post on the channel's Posts tab to everyone: it has no private or unlisted posts. */
export const publicOnly = (platform: Platform, kind: PostKind): boolean => platform === "youtube" && kind === "photo";
/**
 * Posts only a helper that knows them can publish: an older one would upload photos to YouTube and TikTok as videos,
 * and post a mixed post to Farcaster and Lens as text alone.
 */
export const carouselTargets: readonly (readonly [Platform, PostKind])[] = [
  ["tiktok", "photo"],
  ["youtube", "photo"],
  ["farcaster", "mixed"],
  ["lens", "mixed"],
];
export const MAX_PRESETS = 24;

export function postKind(files: readonly { type: string }[]): PostKind {
  if (!files.length) return "text";
  const videos = files.filter((file) => file.type.startsWith("video/")).length;
  if (!videos) return "photo";
  return files.length === 1 ? "video" : "mixed";
}
/** Why a destination can't take this post, or null when it can. `seconds` is unknown until read. */
export function unsupported(platform: Platform, kind: PostKind, photos: number, seconds?: number): string | null {
  const takes = support[platform];
  if (!takes.includes(kind)) {
    if (kind === "mixed") {
      if (takes.includes("photo") && takes.includes("video")) return "takes photos or one video";
      return takes.includes("photo") ? "takes only photos" : "takes one video";
    }
    if (takes.includes("photo") && takes.includes("video")) return "needs media";
    return takes.includes("photo") ? "needs photos" : "needs a video";
  }
  const photoLimit = photoLimits[platform];
  if (kind !== "video" && photoLimit && photos > photoLimit)
    return `takes up to ${photoLimit} ${kind === "photo" ? "photos" : "photos and videos"}`;
  const videoLimit = videoLimits[platform];
  if (kind === "video" && videoLimit && seconds !== undefined && seconds > videoLimit)
    return `takes videos up to ${videoLimit / 60} minutes`;
  return null;
}
export interface VideoShape {
  seconds: number;
  width: number;
  height: number;
}
/** What a video becomes where the platform names it: every Instagram video is a reel, and YouTube makes vertical or square ones up to 3 minutes Shorts. */
export function videoFormat(platform: Platform, video?: VideoShape): string | null {
  if (platform === "instagram") return "Reel";
  if (platform === "youtube" && video && video.height >= video.width && video.seconds <= 180) return "Short";
  return null;
}
/**
 * What a post becomes where the platform names it, so the owner sees what goes out before it does: one video is a
 * Reel on Instagram, more than one item is a carousel, and photos on YouTube are a post rather than a video.
 */
export function postFormat(platform: Platform, kind: PostKind, count: number, video?: VideoShape): string | null {
  if (kind === "video") return videoFormat(platform, video);
  if (kind === "text") return null;
  if (platform === "youtube") return "Post";
  if (count > 1 && (platform === "instagram" || platform === "tiktok" || platform === "xiaohongshu")) return "Carousel";
  if (platform === "tiktok") return "Photo";
  if (platform === "bluesky" && count > 4) return "Gallery";
  return null;
}
/** A horizontal video short enough for YouTube to make it a Short once it's reframed to vertical. */
export function reframesToShort(video?: VideoShape): boolean {
  return !!video && video.width > video.height && video.seconds <= 180;
}
/** Text posts have no title, so lists show their first line instead. */
export function postLabel(post: { title: string; caption: string }): string {
  return post.title || post.caption.trim().split("\n")[0].slice(0, 80) || "Untitled";
}
/** A saved set of destinations and defaults; the post's attachments decide which of them apply. */
export interface Preset {
  id: string;
  name: string;
  platforms: Platform[];
  metadata: Record<Platform, MetadataPolicy>;
  caption: string;
  visibility: "PUBLIC" | "UNLISTED" | "PRIVATE";
}
export interface Preferences {
  version: 1;
  active: string;
  presets: Preset[];
}
export const STORAGE_KEY = "publisher.preferences.v1";
export function defaultMetadata(): Record<Platform, MetadataPolicy> {
  return {
    grain: "remove-location",
    instagram: "remove-location",
    bluesky: "remove-location",
    twitter: "remove-all",
    farcaster: "remove-all",
    lens: "remove-all",
    xiaohongshu: "remove-all",
    youtube: "remove-location",
    tiktok: "remove-location",
  };
}
function preset(id: string, name: string, destinations: Platform[]): Preset {
  return { id, name, platforms: destinations, metadata: defaultMetadata(), caption: "", visibility: "PRIVATE" };
}
export function defaultPreferences(): Preferences {
  return {
    version: 1,
    active: "text",
    presets: [
      preset("photo", "Photo", ["instagram", "grain"]),
      preset("video", "Long video", ["youtube"]),
      preset("text", "Text post", ["bluesky", "twitter"]),
      preset("short", "Short-form video", ["instagram", "youtube", "xiaohongshu", "tiktok", "twitter", "bluesky"]),
    ],
  };
}
/** Read untrusted local storage without permitting invalid destination/policy values. */
export function parsePreferences(raw: string | null): Preferences {
  if (!raw) return defaultPreferences();
  try {
    const value = JSON.parse(raw);
    if (
      value.version !== 1 ||
      !Array.isArray(value.presets) ||
      !value.presets.length ||
      value.presets.length > MAX_PRESETS
    )
      return defaultPreferences();
    const presets: Preset[] = [];
    const defaults = defaultPreferences().presets;
    const legacyNames: Record<string, string> = { text: "Text", video: "Video", short: "Short video" };
    for (const p of value.presets) {
      if (
        !p ||
        typeof p.id !== "string" ||
        !/^[a-zA-Z0-9-]{1,64}$/.test(p.id) ||
        presets.some((prev) => prev.id === p.id)
      )
        continue;
      const metadata = defaultMetadata();
      for (const platform of platforms)
        if (p.metadata?.[platform] === "remove-all" || p.metadata?.[platform] === "remove-location")
          metadata[platform] = p.metadata[platform];
      // Presets saved with a content kind keep their destinations; the kind no longer limits them.
      // Rename only unchanged built-in labels, preserving custom names and settings.
      const name =
        legacyNames[p.id] && p.name === legacyNames[p.id] ? defaults.find((item) => item.id === p.id)?.name : p.name;
      presets.push({
        id: p.id,
        name: typeof name === "string" ? name.slice(0, 50) : "Preset",
        platforms: platforms.filter((platform) => Array.isArray(p.platforms) && p.platforms.includes(platform)),
        metadata,
        visibility: ["PUBLIC", "UNLISTED", "PRIVATE"].includes(p.visibility) ? p.visibility : "PRIVATE",
        caption: typeof p.caption === "string" ? p.caption.slice(0, 5000) : "",
      });
    }
    if (!presets.length) return defaultPreferences();
    return { version: 1, active: presets.some((p) => p.id === value.active) ? value.active : presets[0].id, presets };
  } catch {
    return defaultPreferences();
  }
}
