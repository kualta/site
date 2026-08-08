import imageSizes from "@/data/image-sizes.json";

export const SITE_URL = "https://kualta.dev";
export const SITE_NAME = "kualta";
export const TAGLINE = "a servant of many";
export const TWITTER = "@kualts";
export const DEFAULT_OG_IMAGE = "/opengraph-image.png";

/** the accounts that make the Person entity resolvable to the same human */
export const SAME_AS = [
  "https://github.com/kualta",
  "https://bsky.app/profile/kualta.dev",
  "https://farcaster.xyz/kualta.eth",
  "https://twitter.com/kualts",
];

/**
 * Every tab and every result reads "<page> — kualta", so a bare "posts" or
 * "music" is never adrift from whose posts and whose music it is.
 */
export function pageTitle(title?: string): string {
  if (!title || title === SITE_NAME) return `${SITE_NAME} — ${TAGLINE}`;
  return title.endsWith(SITE_NAME) ? title : `${title} — ${SITE_NAME}`;
}

/**
 * Search results cut off around 160 characters and Google rewrites anything too
 * thin to be a summary, so a description that is only a few words gets padded
 * out with the site's own context rather than shipped as-is.
 */
export function pageDescription(description?: string, title?: string): string {
  const text = description?.trim();
  if (text && text.length >= 70) return clamp(text);

  const subject = title && title !== SITE_NAME ? `${title} — ` : "";
  const lead = text ? `${subject}${text}` : subject.replace(/ — $/, "");
  const suffix = `${SITE_NAME}'s corner of the web: essays on philosophy, crypto and game design, side projects, and music.`;
  return clamp(lead ? `${lead}. ${suffix}` : suffix);
}

/** results stop showing the description somewhere past 160 characters */
function clamp(text: string, limit = 158): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  return `${cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:.\s]+$/, "")}…`;
}

const sizes = imageSizes as Record<string, { width: number; height: number }>;

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
};

export interface OgImage {
  url: string;
  width?: number;
  height?: number;
  type?: string;
}

/**
 * Share cards were claiming 1200x630 for images that are nothing of the sort,
 * which is how a 2048x1152 preview reached scrapers as a lie about its own
 * aspect ratio. The real numbers come from the manifest built off `public/`.
 */
/** what the scrapers can actually decode; avif and svg come back blank */
const SHAREABLE = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

export function ogImage(source: string | undefined, site: URL | undefined): OgImage {
  const candidate = source?.trim() || DEFAULT_OG_IMAGE;
  const usable = SHAREABLE.has(candidate.split(".").pop()?.toLowerCase() ?? "");
  const relative = usable ? candidate : DEFAULT_OG_IMAGE;
  const size = sizes[relative];
  const extension = relative.split(".").pop()?.toLowerCase() ?? "";

  return {
    url: new URL(relative, site ?? SITE_URL).toString(),
    width: size?.width,
    height: size?.height,
    type: MIME[extension],
  };
}
