export const platforms = ["grain", "instagram", "bluesky", "twitter", "xiaohongshu", "youtube", "tiktok"] as const;
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
  xiaohongshu: "Xiaohongshu",
  youtube: "YouTube",
  tiktok: "TikTok",
};
export const kindNames: Record<PostKind, string> = { text: "Text", photo: "Photo", video: "Video", mixed: "Media" };
export const support: Record<Platform, readonly PostKind[]> = {
  grain: ["photo"],
  // Instagram carousels and X posts mix photos and videos; elsewhere a post is photos or one video.
  instagram: ["photo", "video", "mixed"],
  bluesky: ["text", "photo", "video"],
  twitter: ["text", "photo", "video", "mixed"],
  xiaohongshu: ["photo", "video"],
  youtube: ["video"],
  tiktok: ["video"],
};
export const MAX_PHOTOS = 10;
/** Destinations that take fewer photos or videos per post than MAX_PHOTOS. */
export const photoLimits: Partial<Record<Platform, number>> = { twitter: 4 };
/** Longest video, in seconds, where a destination has a limit. */
export const videoLimits: Partial<Record<Platform, number>> = { bluesky: 180 };
/** Destinations that publish the post's title, so a post to them needs one; Xiaohongshu has its own Chinese title. */
export const titled: readonly Platform[] = ["grain", "youtube"];
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
