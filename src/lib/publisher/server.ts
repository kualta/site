import type { NewsletterDB } from "@/lib/newsletter/types";
import { platforms, support, type Platform, type MetadataPolicy } from "./presets";

export interface MediaBucket {
  put(key: string, body: ArrayBuffer, options?: { httpMetadata: { contentType: string } }): Promise<unknown>;
  get(key: string): Promise<{
    body: ReadableStream;
    httpMetadata?: { contentType?: string };
  } | null>;
  delete(keys: string | string[]): Promise<void>;
}
export interface Post {
  id: string;
  kind: "photo" | "video";
  title: string;
  caption: string;
  alt: string;
  media: string[];
  platforms: Platform[];
  metadata: Record<Platform, MetadataPolicy>;
  visibility: "PUBLIC" | "UNLISTED" | "PRIVATE";
}
export const validId = (id: unknown): id is string => typeof id === "string" && /^[a-f0-9-]{36}$/.test(id);
export async function hashToken(token: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
export function validatePost(value: unknown): Post {
  const p = value as Post;
  if (!p || !validId(p.id) || !["photo", "video"].includes(p.kind)) throw new Error("Invalid post");
  if (
    !Array.isArray(p.media) ||
    !p.media.length ||
    p.media.length > 4 ||
    p.media.some((id) => !validId(id)) ||
    new Set(p.media).size !== p.media.length
  )
    throw new Error("Choose 1–4 photos or one video");
  if (p.kind === "video" && p.media.length !== 1) throw new Error("Choose one video");
  if (
    !Array.isArray(p.platforms) ||
    !p.platforms.length ||
    p.platforms.length > platforms.length ||
    new Set(p.platforms).size !== p.platforms.length
  )
    throw new Error("Choose destinations");
  for (const platform of p.platforms) {
    if (!platforms.includes(platform) || !support[platform].includes(p.kind))
      throw new Error("Unsupported destination");
    if (!["remove-all", "remove-location"].includes(p.metadata?.[platform]))
      throw new Error("Choose a metadata policy");
  }
  if (typeof p.title !== "string" || !p.title.trim() || p.title.length > 100)
    throw new Error("Add a title of up to 100 characters");
  if (typeof p.caption !== "string" || p.caption.length > 5000 || typeof p.alt !== "string" || p.alt.length > 1000)
    throw new Error("Caption or alt text is too long");
  if (p.platforms.includes("grain")) {
    const encoder = new TextEncoder();
    if (encoder.encode(p.title.trim()).length > 100 || encoder.encode(p.caption).length > 1000)
      throw new Error("Grain supports 100 title and 1,000 caption UTF-8 bytes");
  }
  if (p.platforms.includes("bluesky") && [...p.caption].length > 300)
    throw new Error("Bluesky captions support up to 300 characters");
  if (p.platforms.includes("twitter") && [...p.caption].length > 280)
    throw new Error("X captions support up to 280 characters");
  if (p.platforms.includes("instagram") && p.caption.length > 2200)
    throw new Error("Instagram captions support up to 2,200 characters");
  if (p.platforms.includes("xiaohongshu") && ([...p.title].length > 20 || [...p.caption].length > 1000))
    throw new Error("Xiaohongshu supports 20 title and 1,000 caption characters");
  if (!["PUBLIC", "UNLISTED", "PRIVATE"].includes(p.visibility)) throw new Error("Choose YouTube visibility");
  return {
    id: p.id,
    kind: p.kind,
    title: p.title.trim(),
    caption: p.caption,
    alt: p.alt,
    media: p.media,
    platforms: p.platforms,
    metadata: p.metadata,
    visibility: p.visibility,
  };
}
export async function authorizeHelper(request: Request, db: NewsletterDB): Promise<boolean> {
  const token = request.headers.get("Authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token) return false;
  return Boolean(
    await db
      .prepare("SELECT id FROM publisher_helper WHERE id = 1 AND token_hash = ?")
      .bind(await hashToken(token))
      .first(),
  );
}
/** Claim once. An interrupted worker is never automatically replayed. */
export async function claimTarget(db: NewsletterDB, supported: Platform[]) {
  await db
    .prepare(
      "UPDATE publisher_targets SET state = 'uncertain', message = 'Helper disconnected. Check the destination before retrying.' WHERE state = 'working' AND started_at < ?",
    )
    .bind(Date.now() - 60 * 60 * 1000)
    .run();
  if (!supported.length) return null;
  const claim = crypto.randomUUID();
  return db
    .prepare(
      `UPDATE publisher_targets SET state = 'working', claim = ?, started_at = ? WHERE id = (SELECT id FROM publisher_targets WHERE state = 'queued' AND platform IN (${supported
        .map(() => "?")
        .join(",")}) ORDER BY rowid LIMIT 1) AND state = 'queued' RETURNING *`,
    )
    .bind(claim, Date.now(), ...supported)
    .first<{ id: string; job_id: string; platform: Platform; claim: string }>();
}
