export const platforms = ["grain", "instagram", "bluesky", "twitter", "xiaohongshu", "youtube", "tiktok"] as const;
export type Platform = (typeof platforms)[number];
export const kinds = ["text", "photo", "video", "short"] as const;
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
export const kindNames: Record<PostKind, string> = {
  text: "Text",
  photo: "Photo",
  video: "Video",
  short: "Short video",
};
export const support: Record<Platform, readonly PostKind[]> = {
  grain: ["photo"],
  instagram: ["photo", "video", "short"],
  bluesky: ["text", "photo", "video", "short"],
  twitter: ["text", "photo", "video", "short"],
  xiaohongshu: ["photo", "video", "short"],
  youtube: ["video", "short"],
  tiktok: ["video", "short"],
};
export const MAX_PHOTOS = 10;
/** Destinations that take fewer photos per post than MAX_PHOTOS. */
export const photoLimits: Partial<Record<Platform, number>> = { twitter: 4 };
/** YouTube Shorts and Bluesky both stop at three minutes. */
export const SHORT_MAX_SECONDS = 180;
export const MAX_PRESETS = 24;

/** The uploaded file type behind each kind: text has none, short video is a video. */
export function mediaKind(kind: PostKind): "photo" | "video" | null {
  if (kind === "text") return null;
  return kind === "photo" ? "photo" : "video";
}
/** Text posts have no title, so lists show their first line instead. */
export function postLabel(post: { title: string; caption: string }): string {
  return post.title || post.caption.trim().split("\n")[0].slice(0, 80) || "Untitled";
}
export interface Preset {
  id: string;
  name: string;
  kind: PostKind;
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
const defaultPlatforms: Record<PostKind, Platform[]> = {
  text: ["bluesky", "twitter"],
  photo: ["instagram", "grain"],
  video: ["youtube"],
  short: ["youtube", "xiaohongshu", "tiktok", "twitter", "bluesky"],
};
function defaultPreset(kind: PostKind): Preset {
  return {
    id: kind,
    name: kindNames[kind],
    kind,
    platforms: defaultPlatforms[kind],
    metadata: defaultMetadata(),
    caption: "",
    visibility: "PRIVATE",
  };
}
export function defaultPreferences(): Preferences {
  return { version: 1, active: "photo", presets: kinds.map(defaultPreset) };
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
      if (!kinds.includes(p.kind)) continue;
      const metadata = defaultMetadata();
      for (const platform of platforms)
        if (p.metadata?.[platform] === "remove-all" || p.metadata?.[platform] === "remove-location")
          metadata[platform] = p.metadata[platform];
      presets.push({
        id: p.id,
        name: typeof p.name === "string" ? p.name.slice(0, 50) : "Preset",
        kind: p.kind,
        platforms: platforms.filter(
          (platform) =>
            Array.isArray(p.platforms) && p.platforms.includes(platform) && support[platform].includes(p.kind),
        ),
        metadata,
        visibility: ["PUBLIC", "UNLISTED", "PRIVATE"].includes(p.visibility) ? p.visibility : "PRIVATE",
        caption: typeof p.caption === "string" ? p.caption.slice(0, 5000) : "",
      });
    }
    if (!presets.length) return defaultPreferences();
    // Every content tab needs a preset, including kinds added after these were saved.
    for (const kind of kinds)
      if (!presets.some((p) => p.kind === kind) && presets.length < MAX_PRESETS) {
        const preset = defaultPreset(kind);
        if (presets.some((p) => p.id === preset.id)) preset.id = crypto.randomUUID();
        presets.push(preset);
      }
    return { version: 1, active: presets.some((p) => p.id === value.active) ? value.active : presets[0].id, presets };
  } catch {
    return defaultPreferences();
  }
}
