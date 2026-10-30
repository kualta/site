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
  head(key: string): Promise<unknown | null>;
  delete(keys: string | string[]): Promise<void>;
}
export interface Post {
  id: string;
  kind: PostKind;
  /** For mixed posts, whether each media item is a photo or a video. */
  mediaKinds?: ("photo" | "video")[];
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
  /** Reframe a horizontal video to vertical for YouTube, which then makes it a Short. */
  youtubeShort?: boolean;
}
export const validId = (id: unknown): id is string => typeof id === "string" && /^[a-f0-9-]{36}$/.test(id);
export async function hashToken(token: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
/** A post the owner needs to fix; its message is safe to show. */
export class PostError extends Error {}
export function validatePost(value: unknown): Post {
  const p = value as Post;
  if (!p || !validId(p.id) || !kinds.includes(p.kind)) throw new PostError("Invalid post");
  if (
    !Array.isArray(p.media) ||
    p.media.length > MAX_PHOTOS ||
    p.media.some((id) => !validId(id)) ||
    new Set(p.media).size !== p.media.length
  )
    throw new PostError(`Choose 1–${MAX_PHOTOS} photos or one video`);
  if (p.kind === "text" && p.media.length) throw new PostError("Text posts have no media");
  if (p.kind !== "text" && !p.media.length) throw new PostError(`Choose 1–${MAX_PHOTOS} photos or one video`);
  if (
    p.alts !== undefined &&
    (p.kind !== "photo" ||
      !Array.isArray(p.alts) ||
      p.alts.length !== p.media.length ||
      p.alts.some((alt) => typeof alt !== "string" || alt.length > 1000))
  )
    throw new PostError("Describe each photo in up to 1,000 characters");
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
    throw new PostError("Choose a valid date taken for each photo");
  if (p.kind === "video" && p.media.length !== 1) throw new PostError("Choose one video");
  if (
    p.kind === "mixed"
      ? !Array.isArray(p.mediaKinds) ||
        p.mediaKinds.length !== p.media.length ||
        p.media.length < 2 ||
        p.mediaKinds.some((kind) => kind !== "photo" && kind !== "video") ||
        !p.mediaKinds.includes("video")
      : p.mediaKinds !== undefined
  )
    throw new PostError("Mix photos with at least one video");
  if (
    !Array.isArray(p.platforms) ||
    !p.platforms.length ||
    p.platforms.length > platforms.length ||
    new Set(p.platforms).size !== p.platforms.length
  )
    throw new PostError("Choose destinations");
  for (const platform of p.platforms) {
    if (!platforms.includes(platform)) throw new PostError("Unsupported destination");
    const reason = unsupported(platform, p.kind, p.media.length);
    if (reason) throw new PostError(`${platformNames[platform]} ${reason}`);
    if (!["remove-all", "remove-location"].includes(p.metadata?.[platform]))
      throw new PostError("Choose a metadata policy");
  }
  if (
    typeof p.title !== "string" ||
    p.title.length > 100 ||
    (p.platforms.some((platform) => titled.includes(platform)) && !p.title.trim())
  )
    throw new PostError("Add a title of up to 100 characters");
  if (typeof p.caption !== "string" || p.caption.length > 5000 || typeof p.alt !== "string" || p.alt.length > 1000)
    throw new PostError("Caption or alt text is too long");
  if (p.kind === "text" && !p.caption.trim()) throw new PostError("Write something to post");
  if (p.tags !== undefined && (!Array.isArray(p.tags) || p.tags.length > 30 || !p.tags.every(isTag)))
    throw new PostError("Tags are letters, digits and _, up to 30 of them");
  if (p.short !== undefined && (typeof p.short !== "string" || p.short.length > 1000))
    throw new PostError("The short version is too long");
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
    throw new PostError("Check the Chinese title, text and topics");
  if (p.platforms.includes("xiaohongshu") && !p.zh) throw new PostError("Add the Chinese version for Xiaohongshu");
  if (
    p.youtubeShort !== undefined &&
    (typeof p.youtubeShort !== "boolean" || p.kind !== "video" || !p.platforms.includes("youtube"))
  )
    throw new PostError("Only a video going to YouTube can be posted as a Short");
  const variants: Partial<Record<Platform, Variant>> = {};
  for (const platform of p.platforms) {
    variants[platform] = renderVariant(platform, p);
    const issue = problem(platform, variants[platform]);
    if (issue) throw new PostError(`${platformNames[platform]}: ${issue}`);
  }
  if (!["PUBLIC", "UNLISTED", "PRIVATE"].includes(p.visibility)) throw new PostError("Choose YouTube visibility");
  return {
    id: p.id,
    kind: p.kind,
    ...(p.kind === "mixed" ? { mediaKinds: p.mediaKinds } : {}),
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
    ...(p.youtubeShort ? { youtubeShort: true } : {}),
  };
}
/** Sends a post that already went out to more destinations, checked again as if it were new. */
export async function addDestinations(
  db: NewsletterDB,
  bucket: Pick<MediaBucket, "head">,
  input: { job?: unknown; platforms?: unknown; title?: unknown; zh?: unknown },
): Promise<Platform[]> {
  if (!validId(input.job)) throw new PostError("Invalid post");
  const job = await db
    .prepare("SELECT payload FROM publisher_jobs WHERE id = ?")
    .bind(input.job)
    .first<{ payload: string }>();
  if (!job) throw new PostError("Invalid post");
  const post = JSON.parse(job.payload) as Post;
  const added = platforms.filter(
    (p) => Array.isArray(input.platforms) && input.platforms.includes(p) && !post.platforms.includes(p),
  );
  if (!added.length) throw new PostError("Choose where to crosspost");
  // The title and Chinese version can be filled in now when the post went out without them.
  const next = validatePost({
    ...post,
    platforms: [...post.platforms, ...added],
    title: !post.title.trim() && typeof input.title === "string" ? input.title : post.title,
    zh: post.zh ?? input.zh,
  });
  for (const id of next.media)
    if (!(await bucket.head(id)))
      throw new PostError("This post's media has expired. Post it again from the composer.");
  await db.batch([
    db.prepare("UPDATE publisher_jobs SET payload = ? WHERE id = ?").bind(JSON.stringify(next), next.id),
    ...added.map((platform) =>
      db
        .prepare("INSERT INTO publisher_targets (id, job_id, platform) VALUES (?, ?, ?)")
        .bind(crypto.randomUUID(), next.id, platform),
    ),
  ]);
  return added;
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

/** Releases a target at once. Its claim stays, so a success the laptop confirms late still lands; a retry clears it. */
export async function stopTarget(db: NewsletterDB, job: string, platform: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE publisher_targets SET
        state = CASE state WHEN 'queued' THEN 'failed' ELSE 'uncertain' END,
        message = CASE state WHEN 'queued' THEN 'Stopped before publishing.' ELSE 'Stopped while publishing. Check the destination before publishing again.' END,
        finished_at = ?
      WHERE job_id = ? AND platform = ? AND state IN ('queued','working')`,
    )
    .bind(Date.now(), job, platform)
    .run();
  return result.meta.changes > 0;
}
/** Records a post the owner found on the platform, when publishing couldn't confirm it. */
export async function markPublished(db: NewsletterDB, job: string, platform: string, url: string): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE publisher_targets SET state = 'succeeded', url = ?, message = NULL, finished_at = ? WHERE job_id = ? AND platform = ? AND state = 'uncertain'",
    )
    .bind(url, Date.now(), job, platform)
    .run();
  return result.meta.changes > 0;
}
/** Whether the laptop should keep going with this attempt. */
export async function targetActive(db: NewsletterDB, id: string, claim: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT id FROM publisher_targets WHERE id = ? AND claim = ? AND state = 'working'")
    .bind(id, claim)
    .first();
  return Boolean(row);
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
