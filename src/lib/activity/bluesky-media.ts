import { asRecord } from "./validation";

export interface BlueskyMedia {
  kind: "image" | "video";
  src: string;
  thumbnail?: string;
  alt: string;
  width?: number;
  height?: number;
}

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return url.href;
  } catch {}
}

/**
 * A bare fullsize URL gets a heavily compressed WebP from the CDN. The JPEG
 * rendition keeps the same resolution with far less loss, which is what a
 * full-screen view needs.
 */
function fullsizeJpeg(url: string): string {
  const parsed = new URL(url);
  if (parsed.hostname !== "cdn.bsky.app" || !parsed.pathname.startsWith("/img/feed_fullsize/")) return url;
  parsed.pathname = `${parsed.pathname.replace(/@[a-z]+$/, "")}@jpeg`;
  return parsed.href;
}

/** Follow the same media order as the embed, including quoted posts. */
export function getBlueskyMedia(value: unknown): BlueskyMedia[] {
  const embed = asRecord(value);
  if (!embed) return [];
  if (embed.$type === "app.bsky.embed.images#view" && Array.isArray(embed.images)) {
    return embed.images.flatMap((value) => {
      const image = asRecord(value);
      const fullsize = httpsUrl(image?.fullsize);
      const src = fullsize && fullsizeJpeg(fullsize);
      const thumbnail = httpsUrl(image?.thumb);
      const ratio = asRecord(image?.aspectRatio);
      return src && thumbnail
        ? [
            {
              kind: "image" as const,
              width: typeof ratio?.width === "number" && ratio.width > 0 ? ratio.width : 640,
              height: typeof ratio?.height === "number" && ratio.height > 0 ? ratio.height : 480,
              src,
              thumbnail,
              alt: typeof image?.alt === "string" ? image.alt : "",
            },
          ]
        : [];
    });
  }
  if (embed.$type === "app.bsky.embed.video#view") {
    const src = httpsUrl(embed.playlist);
    const ratio = asRecord(embed.aspectRatio);
    return src
      ? [
          {
            kind: "video",
            width:
              typeof ratio?.width === "number" && Number.isFinite(ratio.width) && ratio.width > 0 ? ratio.width : 16,
            height:
              typeof ratio?.height === "number" && Number.isFinite(ratio.height) && ratio.height > 0 ? ratio.height : 9,
            src,
            thumbnail: httpsUrl(embed.thumbnail),
            alt: typeof embed.alt === "string" ? embed.alt : "",
          },
        ]
      : [];
  }
  if (embed.$type === "app.bsky.embed.recordWithMedia#view") {
    return [...getBlueskyMedia(embed.media), ...getBlueskyMedia(embed.record)];
  }
  if (embed.$type === "app.bsky.embed.record#view") {
    const record = asRecord(embed.record);
    return getBlueskyMedia(Array.isArray(record?.embeds) ? record.embeds[0] : undefined);
  }
  return [];
}
