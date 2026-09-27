import type { Agent, AppBskyEmbedGallery, AppBskyEmbedImages, AppBskyEmbedVideo } from "@atproto/api";

export interface ComposerAttachment {
  file: File;
  alt: string;
  width: number;
  height: number;
}
export const MAX_IMAGES = 10;
const MAX_BYTES = 1_000_000;

/** Keep only pixel/decoding chunks; discard EXIF, text, timestamps, profiles and trailing data. */
export function stripPngMetadata(bytes: Uint8Array): Uint8Array {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, i) => bytes[i] === value)) throw new Error("Invalid sanitized image.");
  const parts = [bytes.slice(0, 8)];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const end = offset + length + 12;
    if (end > bytes.length) throw new Error("Truncated image.");
    const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
    if (["IHDR", "PLTE", "IDAT", "IEND", "tRNS"].includes(type)) parts.push(bytes.slice(offset, end));
    if (type === "IEND") {
      const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
      let at = 0;
      for (const part of parts) {
        result.set(part, at);
        at += part.length;
      }
      return result;
    }
    offset = end;
  }
  throw new Error("Incomplete image.");
}

export async function sanitizeImage(source: File): Promise<ComposerAttachment> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(source.type))
    throw new Error("Choose a JPEG, PNG, or WebP image.");
  if (source.size > 20_000_000) throw new Error("Choose an image under 20 MB.");
  const bitmap = await createImageBitmap(source);
  try {
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    let width = Math.max(1, Math.round(bitmap.width * scale));
    let height = Math.max(1, Math.round(bitmap.height * scale));
    for (let attempt = 0; attempt < 14; attempt++) {
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Image processing is unavailable.");
      context.drawImage(bitmap, 0, 0, width, height);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) => (value ? resolve(value) : reject(new Error("Could not sanitize image."))),
          "image/png",
        ),
      );
      const bytes = stripPngMetadata(new Uint8Array(await blob.arrayBuffer()));
      if (bytes.length <= MAX_BYTES)
        return {
          file: new File([bytes.buffer as ArrayBuffer], `image-${crypto.randomUUID()}.png`, {
            type: "image/png",
            lastModified: 0,
          }),
          alt: "",
          width,
          height,
        };
      width = Math.max(1, Math.floor(width * 0.8));
      height = Math.max(1, Math.floor(height * 0.8));
    }
    throw new Error("This image could not be reduced to the upload limit.");
  } finally {
    bitmap.close();
  }
}

export async function uploadMedia(
  agent: Agent,
  images: ComposerAttachment[],
): Promise<
  | (AppBskyEmbedImages.Main & { $type: "app.bsky.embed.images" })
  | (AppBskyEmbedGallery.Main & { $type: "app.bsky.embed.gallery" })
  | (AppBskyEmbedVideo.Main & { $type: "app.bsky.embed.video" })
  | undefined
> {
  if (!images.length) return undefined;
  const video = images.find((image) => image.file.type.startsWith("video/"));
  if (video) {
    if (images.length !== 1) throw new Error("Attach one video or up to ten images.");
    if (!sanitizedVideos.has(video.file)) throw new Error("Prepare the video again before uploading.");
    const { data } = await agent.uploadBlob(video.file, { encoding: "video/mp4" });
    return { $type: "app.bsky.embed.video", video: data.blob, alt: video.alt };
  }
  if (images.length > MAX_IMAGES) throw new Error("Attach up to ten images.");
  const uploaded: Omit<AppBskyEmbedGallery.Image, "$type">[] = [];
  for (const image of images) {
    // Sanitize again at the upload boundary: never trust a selected file or its original name.
    const clean = await sanitizeImage(image.file);
    const { data } = await agent.uploadBlob(clean.file, { encoding: "image/png" });
    uploaded.push({ image: data.blob, alt: image.alt, aspectRatio: { width: clean.width, height: clean.height } });
  }
  if (uploaded.length > 4)
    return {
      $type: "app.bsky.embed.gallery",
      items: uploaded.map((image) => ({ ...image, $type: "app.bsky.embed.gallery#image" as const })),
    };
  return { $type: "app.bsky.embed.images", images: uploaded };
}

const sanitizedVideos = new WeakSet<File>();
export async function sanitizeAttachment(source: File): Promise<ComposerAttachment> {
  if (!source.type.startsWith("video/")) return sanitizeImage(source);
  const { sanitizeVideo } = await import("./video");
  const media = await sanitizeVideo(source);
  sanitizedVideos.add(media.file);
  return media;
}
