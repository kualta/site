import type { NewsletterDB } from "@/lib/newsletter/types";
import {
  kinds,
  MAX_PHOTOS,
  platformNames,
  platforms,
  titled,
  unsupported,
  type MetadataPolicy,
  type Platform,
  type PostKind,
} from "./presets";
import { isTag, problem, renderVariant, type Variant } from "./variants";

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
  kind: PostKind;
  title: string;
  caption: string;
  alt: string;
  /** Per-photo descriptions; `alt` describes a video and older photo posts. */
  alts?: string[];
  media: string[];
  datesTaken?: (string | null)[];
  platforms: Platform[];
  metadata: Record<Platform, MetadataPolicy>;
  visibility: "PUBLIC" | "UNLISTED" | "PRIVATE";
  /** Without "#", most important first. */
  tags?: string[];
  /** For X and Bluesky when the caption is longer than they allow. */
  short?: string;
  /** Xiaohongshu's Simplified Chinese version. */
  zh?: { title: string; text: string; topics: string[] };
  /** What each destination receives, rendered once here so the laptop publishes exactly what was checked. */
  variants?: Partial<Record<Platform, Variant>>;
}
export const validId = (id: unknown): id is string => typeof id === "string" && /^[a-f0-9-]{36}$/.test(id);
export async function hashToken(token: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
export function validatePost(value: unknown): Post {
  const p = value as Post;
  if (!p || !validId(p.id) || !kinds.includes(p.kind)) throw new Error("Invalid post");
  if (
    !Array.isArray(p.media) ||
    p.media.length > MAX_PHOTOS ||
    p.media.some((id) => !validId(id)) ||
    new Set(p.media).size !== p.media.length
  )
    throw new Error(`Choose 1–${MAX_PHOTOS} photos or one video`);
  if (p.kind === "text" && p.media.length) throw new Error("Text posts have no media");
  if (p.kind !== "text" && !p.media.length) throw new Error(`Choose 1–${MAX_PHOTOS} photos or one video`);
  if (
    p.alts !== undefined &&
    (p.kind !== "photo" ||
      !Array.isArray(p.alts) ||
      p.alts.length !== p.media.length ||
      p.alts.some((alt) => typeof alt !== "string" || alt.length > 1000))
  )
    throw new Error("Describe each photo in up to 1,000 characters");
  if (
    p.datesTaken !== undefined &&
    (p.kind !== "photo" ||
      !Array.isArray(p.datesTaken) ||
      p.datesTaken.length !== p.media.length ||
      p.datesTaken.some(
        (date) =>
          date !== null &&
          (typeof date !== "string" ||
            !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(date) ||
            !Number.isFinite(Date.parse(date)) ||
            new Date(date).toISOString() !== date),
      ))
  )
    throw new Error("Choose a valid date taken for each photo");
  if (p.kind === "video" && p.media.length !== 1) throw new Error("Choose one video");
  if (
    !Array.isArray(p.platforms) ||
    !p.platforms.length ||
    p.platforms.length > platforms.length ||
    new Set(p.platforms).size !== p.platforms.length
  )
    throw new Error("Choose destinations");
  for (const platform of p.platforms) {
    if (!platforms.includes(platform)) throw new Error("Unsupported destination");
    const reason = unsupported(platform, p.kind, p.media.length);
    if (reason) throw new Error(`${platformNames[platform]} ${reason}`);
    if (!["remove-all", "remove-location"].includes(p.metadata?.[platform]))
      throw new Error("Choose a metadata policy");
  }
  if (
    typeof p.title !== "string" ||
    p.title.length > 100 ||
    (p.platforms.some((platform) => titled.includes(platform)) && !p.title.trim())
  )
    throw new Error("Add a title of up to 100 characters");
  if (typeof p.caption !== "string" || p.caption.length > 5000 || typeof p.alt !== "string" || p.alt.length > 1000)
    throw new Error("Caption or alt text is too long");
  if (p.kind === "text" && !p.caption.trim()) throw new Error("Write something to post");
  if (p.tags !== undefined && (!Array.isArray(p.tags) || p.tags.length > 30 || !p.tags.every(isTag)))
    throw new Error("Tags are letters, digits and _, up to 30 of them");
  if (p.short !== undefined && (typeof p.short !== "string" || p.short.length > 1000))
    throw new Error("The short version is too long");
  if (
    p.zh !== undefined &&
    (typeof p.zh?.title !== "string" ||
      p.zh.title.length > 100 ||
      typeof p.zh.text !== "string" ||
      p.zh.text.length > 5000 ||
      !Array.isArray(p.zh.topics) ||
      p.zh.topics.length > 10 ||
      !p.zh.topics.every((topic) => isTag(topic) && [...topic].length <= 30))
  )
    throw new Error("Check the Chinese title, text and topics");
  if (p.platforms.includes("xiaohongshu") && !p.zh) throw new Error("Add the Chinese version for Xiaohongshu");
  const variants: Partial<Record<Platform, Variant>> = {};
  for (const platform of p.platforms) {
    variants[platform] = renderVariant(platform, p);
    const issue = problem(platform, variants[platform]);
    if (issue) throw new Error(`${platformNames[platform]}: ${issue}`);
  }
  if (!["PUBLIC", "UNLISTED", "PRIVATE"].includes(p.visibility)) throw new Error("Choose YouTube visibility");
  return {
    id: p.id,
    kind: p.kind,
    title: p.title.trim(),
    caption: p.caption,
    alt: p.alt,
    ...(p.alts ? { alts: p.alts } : {}),
    media: p.media,
    ...(p.datesTaken ? { datesTaken: p.datesTaken } : {}),
    platforms: p.platforms,
    metadata: p.metadata,
    visibility: p.visibility,
    ...(p.tags?.length ? { tags: p.tags } : {}),
    ...(p.short?.trim() ? { short: p.short } : {}),
    ...(p.zh ? { zh: { title: p.zh.title.trim(), text: p.zh.text, topics: p.zh.topics } } : {}),
    variants,
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

export async function claimConnection(db: NewsletterDB) {
  await db
    .prepare(
      "UPDATE publisher_connections SET state='failed', payload=NULL, message='Connection expired. Try again.' WHERE state IN ('queued','working') AND created_at < ?",
    )
    .bind(Date.now() - 15 * 60_000)
    .run();
  return db
    .prepare(
      "UPDATE publisher_connections SET state='working', claim=? WHERE id=(SELECT id FROM publisher_connections WHERE state='queued' ORDER BY created_at LIMIT 1) AND state='queued' RETURNING *",
    )
    .bind(crypto.randomUUID())
    .first<{ id: string; platform: Platform; action: string; payload: string | null; claim: string }>();
}
