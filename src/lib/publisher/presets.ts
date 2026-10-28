export const platforms = ["grain", "instagram", "bluesky", "twitter", "xiaohongshu", "youtube", "tiktok"] as const;
export type Platform = (typeof platforms)[number];
/** What a post carries, decided by its attachments: none, photos, or one video. */
export const kinds = ["text", "photo", "video"] as const;
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
export const kindNames: Record<PostKind, string> = { text: "Text", photo: "Photo", video: "Video" };
export const support: Record<Platform, readonly PostKind[]> = {
  grain: ["photo"],
  instagram: ["photo", "video"],
  bluesky: ["text", "photo", "video"],
  twitter: ["text", "photo", "video"],
  xiaohongshu: ["photo", "video"],
  youtube: ["video"],
  tiktok: ["video"],
};
export const MAX_PHOTOS = 10;
/** Destinations that take fewer photos per post than MAX_PHOTOS. */
export const photoLimits: Partial<Record<Platform, number>> = { twitter: 4 };
/** Longest video, in seconds, where a destination has a limit. */
export const videoLimits: Partial<Record<Platform, number>> = { bluesky: 180 };
/** Text length per destination, in characters, for the composer's counter. */
export const textLimits: Partial<Record<Platform, number>> = {
  twitter: 280,
  bluesky: 300,
  xiaohongshu: 1000,
  instagram: 2200,
};
/** Destinations that publish a title, so a post to them needs one. */
export const titled: readonly Platform[] = ["grain", "youtube", "xiaohongshu"];
export const MAX_PRESETS = 24;

export function postKind(files: readonly { type: string }[]): PostKind {
  if (!files.length) return "text";
  return files[0].type.startsWith("video/") ? "video" : "photo";
}
/** Why a destination can't take this post, or null when it can. `seconds` is unknown until read. */
export function unsupported(platform: Platform, kind: PostKind, photos: number, seconds?: number): string | null {
  const takes = support[platform];
  if (!takes.includes(kind)) {
    if (takes.includes("photo") && takes.includes("video")) return "needs media";
    return takes.includes("photo") ? "needs photos" : "needs a video";
  }
  const photoLimit = photoLimits[platform];
  if (kind === "photo" && photoLimit && photos > photoLimit) return `takes up to ${photoLimit} photos`;
  const videoLimit = videoLimits[platform];
  if (kind === "video" && videoLimit && seconds !== undefined && seconds > videoLimit)
    return `takes videos up to ${videoLimit / 60} minutes`;
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
      preset("text", "Text", ["bluesky", "twitter"]),
      preset("photo", "Photo", ["instagram", "grain"]),
      preset("video", "Video", ["youtube"]),
      preset("short", "Short video", ["youtube", "xiaohongshu", "tiktok", "twitter", "bluesky"]),
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
      presets.push({
        id: p.id,
        name: typeof p.name === "string" ? p.name.slice(0, 50) : "Preset",
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
