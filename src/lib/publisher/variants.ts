import type { Platform } from "./presets";

/** What the owner writes once; each platform's version is rendered from it. */
export interface PostText {
  title: string;
  caption: string;
  /** For X and Bluesky when the caption is longer than they allow. */
  short?: string;
  /** Without "#", most important first; each platform takes as many as it shows. */
  tags?: string[];
  /** Xiaohongshu publishes its own Simplified Chinese title, text and topics. */
  zh?: { title: string; text: string; topics: string[] };
}
/** Exactly what one platform receives. */
export interface Variant {
  title: string;
  text: string;
  /** Tags kept outside the text: Bluesky's hidden tags, Xiaohongshu's linked topics. */
  tags: string[];
}

/** How many tags each platform shows at the end of its text. X and Grain do nothing with them; Bluesky keeps its own hidden. */
export const tagCounts: Record<Platform, number> = {
  grain: 0,
  instagram: 5,
  instagram_story: 0,
  tiktok: 5,
  youtube: 3,
  twitter: 0,
  bluesky: 0,
  xiaohongshu: 5,
};
const BLUESKY_HIDDEN_TAGS = 8;
const tagPattern = /^(?=.*\p{L})[\p{L}\p{N}_]{1,64}$/u;

/** Tags from free text such as "#travel bogotá, 生活美学": letters, digits and _, at least one letter. */
export function parseTags(input: string): string[] {
  const seen = new Set<string>();
  return input
    .split(/[\s,，、#＃]+/)
    .filter((tag) => tagPattern.test(tag))
    .filter((tag) => !seen.has(tag.toLowerCase()) && seen.add(tag.toLowerCase()));
}
export const isTag = (tag: unknown): tag is string => typeof tag === "string" && tagPattern.test(tag);

export const bytes = (text: string) => new TextEncoder().encode(text).length;
export function graphemes(text: string): number {
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;
}
/** X counts most non-Latin characters and every emoji as 2, and every link as 23. */
export function xLength(text: string): number {
  let length = 0;
  const links = text.replace(/https?:\/\/\S+/g, () => {
    length += 23;
    return "";
  });
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(links)) {
    if (/\p{Extended_Pictographic}/u.test(segment)) {
      length += 2;
      continue;
    }
    for (const char of segment) {
      const code = char.codePointAt(0) ?? 0;
      const light =
        code <= 4351 ||
        (code >= 8192 && code <= 8205) ||
        (code >= 8208 && code <= 8223) ||
        (code >= 8242 && code <= 8247);
      length += light ? 1 : 2;
    }
  }
  return length;
}
/** Xiaohongshu's title counter: Chinese characters count 1, ASCII ½, rounded up. */
export function xiaohongshuTitleLength(title: string): number {
  let half = 0;
  for (const char of title) half += (char.codePointAt(0) ?? 0) > 127 || char === "^" ? 2 : 1;
  return Math.ceil(half / 2);
}

function withTags(text: string, tags: string[]): string {
  if (!tags.length) return text;
  const line = tags.map((tag) => `#${tag}`).join(" ");
  return text.trim() ? `${text.trimEnd()}\n\n${line}` : line;
}

export function renderVariant(platform: Platform, post: PostText): Variant {
  // The API posts stories without a caption.
  if (platform === "instagram_story") return { title: "", text: "", tags: [] };
  if (platform === "xiaohongshu")
    return {
      title: post.zh?.title.trim() ?? "",
      text: post.zh?.text ?? "",
      tags: (post.zh?.topics ?? []).slice(0, tagCounts.xiaohongshu),
    };
  const tags = post.tags ?? [];
  const brief = platform === "twitter" || platform === "bluesky";
  return {
    title: platform === "grain" || platform === "youtube" ? post.title.trim() : "",
    text: withTags((brief && post.short?.trim()) || post.caption, tags.slice(0, tagCounts[platform])),
    tags: platform === "bluesky" ? tags.slice(0, BLUESKY_HIDDEN_TAGS) : [],
  };
}

export interface Usage {
  label: string;
  used: number;
  limit: number;
}
/** Each limited field of a platform's version, counted the way that platform counts. */
export function usage(platform: Platform, variant: Variant): Usage[] {
  switch (platform) {
    case "twitter":
      return [{ label: "Text", used: xLength(variant.text), limit: 280 }];
    case "bluesky":
      return [{ label: "Text", used: graphemes(variant.text), limit: 300 }];
    case "instagram_story":
      return [];
    case "instagram":
    case "tiktok":
      return [{ label: "Caption", used: variant.text.length, limit: 2200 }];
    case "youtube":
      return [
        { label: "Title", used: [...variant.title].length, limit: 100 },
        { label: "Description (bytes)", used: bytes(variant.text), limit: 5000 },
      ];
    case "grain":
      return [
        { label: "Title (bytes)", used: bytes(variant.title), limit: 100 },
        { label: "Description (bytes)", used: bytes(variant.text), limit: 1000 },
      ];
    case "xiaohongshu": {
      // Topics go on a line after the text as "#name ", and RedNote counts them toward its 1000.
      const topics = variant.tags.reduce((sum, topic) => sum + [...topic].length + 2, variant.tags.length ? 1 : 0);
      return [
        { label: "Title", used: xiaohongshuTitleLength(variant.title), limit: 20 },
        { label: "Text", used: [...variant.text].length + topics, limit: 1000 },
      ];
    }
  }
}
/** Why a platform would reject its version, or null. */
export function problem(platform: Platform, variant: Variant): string | null {
  const over = usage(platform, variant).find((item) => item.used > item.limit);
  if (over) return `${over.label.toLowerCase()} is ${over.used}/${over.limit}`;
  if (platform === "youtube" && /[<>]/.test(variant.title + variant.text)) return "can't contain < or >";
  if (platform === "instagram" && (variant.text.match(/#[\p{L}\p{N}_]+/gu)?.length ?? 0) > 5)
    return "takes up to 5 hashtags";
  if (platform === "xiaohongshu" && !variant.title) return "needs a Chinese title";
  return null;
}
