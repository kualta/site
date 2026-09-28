export const platforms = ["grain", "instagram", "bluesky", "twitter", "xiaohongshu", "youtube", "tiktok"] as const;
export type Platform = (typeof platforms)[number];
export type MediaKind = "photo" | "video";
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
export const support: Record<Platform, readonly MediaKind[]> = {
  grain: ["photo"],
  instagram: ["photo", "video"],
  bluesky: ["photo", "video"],
  twitter: ["photo", "video"],
  xiaohongshu: ["photo", "video"],
  youtube: ["video"],
  tiktok: ["video"],
};
export interface Preset {
  id: string;
  name: string;
  kind: MediaKind;
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
export function defaultPreferences(): Preferences {
  return {
    version: 1,
    active: "photo",
    presets: [
      {
        id: "photo",
        name: "Photo",
        kind: "photo",
        platforms: ["instagram", "grain"],
        metadata: defaultMetadata(),
        caption: "",
        visibility: "PRIVATE",
      },
      {
        id: "video",
        name: "Video",
        kind: "video",
        platforms: ["youtube", "xiaohongshu", "tiktok", "twitter", "bluesky"],
        metadata: defaultMetadata(),
        caption: "",
        visibility: "PRIVATE",
      },
    ],
  };
}
/** Read untrusted local storage without permitting invalid destination/policy values. */
export function parsePreferences(raw: string | null): Preferences {
  if (!raw) return defaultPreferences();
  try {
    const value = JSON.parse(raw);
    if (value.version !== 1 || !Array.isArray(value.presets) || !value.presets.length || value.presets.length > 20)
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
      if (p.kind !== "photo" && p.kind !== "video") continue;
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
    return { version: 1, active: presets.some((p) => p.id === value.active) ? value.active : presets[0].id, presets };
  } catch {
    return defaultPreferences();
  }
}
