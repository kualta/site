import type { NewsletterDB } from "@/lib/newsletter/types";
import {
  defaultMetadata,
  kinds,
  carouselTargets,
  MAX_PHOTOS,
  needsTitle,
  platformNames,
  platforms,
  postLabel,
  publicOnly,
  unsupported,
  type MetadataPolicy,
  type Platform,
  type PostKind,
} from "./presets";
import { postKey, publicationLink } from "./links";
import { EXPIRY_MARGIN, UPLOAD_LIFETIME } from "./schedule";
import { isTag, problem, renderVariant, type Variant } from "./variants";

/** A scheduled time can be this far in the past by the time the post reaches the server: it publishes at once. */
const SCHEDULE_SLACK = 10 * 60_000;
/** A schedule names some of the post's destinations, each at a whole millisecond within the next week. */
function validSchedule(schedule: unknown, destinations: string[]): boolean {
  if (typeof schedule !== "object" || schedule === null) return false;
  const now = Date.now();
  const times = Object.entries(schedule);
  return (
    times.length > 0 &&
    times.every(
      ([platform, at]) =>
        destinations.includes(platform) &&
        typeof at === "number" &&
        Number.isInteger(at) &&
        at >= now - SCHEDULE_SLACK &&
        at <= now + UPLOAD_LIFETIME,
    )
  );
}

export interface MediaBucket {
  put(key: string, body: ArrayBuffer | string, options?: { httpMetadata: { contentType: string } }): Promise<unknown>;
  get(key: string): Promise<{
    body: ReadableStream;
    httpMetadata?: { contentType?: string };
    size?: number;
    uploaded?: Date;
  } | null>;
  head(key: string): Promise<unknown | null>;
  delete(keys: string | string[]): Promise<void>;
  /** The objects whose keys start with `prefix`, a page at a time. */
  list(options: { prefix: string; cursor?: string }): Promise<{
    objects: { key: string; uploaded: Date }[];
    truncated: boolean;
    cursor?: string;
  }>;
}
export interface Post {
  id: string;
  kind: PostKind;
  /** For mixed posts, whether each media item is a photo or a video. */
  mediaKinds?: ("photo" | "video")[];
  /**
   * The owner chose to send a video together with other media as one carousel. A mixed post needs it, so a video
   * meant as a Reel or Short never goes out inside a carousel because something else was attached.
   */
  carousel?: true;
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
  /** For X, Bluesky and Farcaster when the caption is longer than they allow. */
  short?: string;
  /**
   * Xiaohongshu's Simplified Chinese version, with a video made for Chinese audiences if there is one, and that
   * video's own cover.
   */
  zh?: { title: string; text: string; topics: string[]; video?: string; cover?: string; location?: string };
  /** What each destination receives, rendered once here so the laptop publishes exactly what was checked. */
  variants?: Partial<Record<Platform, Variant>>;
  /** Reframe a horizontal video to vertical for YouTube, which then makes it a Short. */
  youtubeShort?: boolean;
  /** An image for a video's cover, where the platform lets a post choose one (see `coverPlatforms`). */
  cover?: string;
  /** A place to tag, by name: each platform picks its closest match (see `locationPlatforms`). */
  location?: string;
  /** When each destination publishes, in ms; a destination without a time publishes at once. */
  schedule?: Partial<Record<Platform, number>>;
}
/** Where a video post can choose its cover; the rest pick their own frame. */
export const coverPlatforms: Platform[] = ["youtube", "tiktok", "instagram", "xiaohongshu", "lens"];
/** Where a post can be tagged with a place. */
// TikTok's web uploader has no location setting.
export const locationPlatforms: Platform[] = ["instagram", "xiaohongshu"];
export const MAX_LOCATION = 100;
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
  if (p.kind === "mixed" && p.carousel !== true)
    throw new PostError("A video goes out on its own. Choose Post as one carousel to send it with the other media.");
  if (p.kind !== "mixed" && p.carousel !== undefined)
    throw new PostError("Only a video sent with other media is posted as one carousel");
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
    (p.platforms.some((platform) => needsTitle(platform, p.kind)) && !p.title.trim())
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
  if (p.zh?.video !== undefined && (p.kind !== "video" || !validId(p.zh.video) || p.zh.video === p.media[0]))
    throw new PostError("The Chinese version is a second video for a video post");
  if (p.platforms.includes("xiaohongshu") && !p.zh) throw new PostError("Add the Chinese version for Xiaohongshu");
  if (
    p.youtubeShort !== undefined &&
    (typeof p.youtubeShort !== "boolean" || p.kind !== "video" || !p.platforms.includes("youtube"))
  )
    throw new PostError("Only a video going to YouTube can be posted as a Short");
  const videos = [p.media[0], p.zh?.video];
  if (p.cover !== undefined && (p.kind !== "video" || !validId(p.cover) || videos.includes(p.cover)))
    throw new PostError("A cover is one image for a video post");
  if (
    p.zh?.cover !== undefined &&
    (!p.cover || !p.zh.video || !validId(p.zh.cover) || [...videos, p.cover].includes(p.zh.cover))
  )
    throw new PostError("The Chinese cover is a frame of the Chinese video, beside the post's cover");
  if (
    [p.location, p.zh?.location].some(
      (place) => place !== undefined && (typeof place !== "string" || place.length > MAX_LOCATION),
    )
  )
    throw new PostError(`Name the location in up to ${MAX_LOCATION} characters`);
  const schedule = p.schedule;
  if (schedule !== undefined && !validSchedule(schedule, p.platforms))
    throw new PostError("Schedule each destination for a time within the next week");
  const variants: Partial<Record<Platform, Variant>> = {};
  for (const platform of p.platforms) {
    variants[platform] = renderVariant(platform, p);
    const issue = problem(platform, variants[platform]);
    if (issue) throw new PostError(`${platformNames[platform]}: ${issue}`);
  }
  if (!["PUBLIC", "UNLISTED", "PRIVATE"].includes(p.visibility)) throw new PostError("Choose YouTube visibility");
  if (p.visibility !== "PUBLIC" && p.platforms.some((platform) => publicOnly(platform, p.kind)))
    throw new PostError("YouTube shows photo posts to everyone: set YouTube visibility to Public");
  return {
    id: p.id,
    kind: p.kind,
    ...(p.kind === "mixed" ? { mediaKinds: p.mediaKinds, carousel: true as const } : {}),
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
    ...(p.zh
      ? {
          zh: {
            title: p.zh.title.trim(),
            text: p.zh.text,
            topics: p.zh.topics,
            ...(p.zh.video ? { video: p.zh.video } : {}),
            ...(p.zh.cover ? { cover: p.zh.cover } : {}),
            ...(p.zh.location?.trim() ? { location: p.zh.location.trim() } : {}),
          },
        }
      : {}),
    variants,
    ...(p.youtubeShort ? { youtubeShort: true } : {}),
    ...(p.cover ? { cover: p.cover } : {}),
    ...(p.location?.trim() ? { location: p.location.trim() } : {}),
    // In the destinations' order, so a retried request is the same post.
    ...(schedule
      ? {
          schedule: Object.fromEntries(
            p.platforms.flatMap((platform) =>
              schedule[platform] === undefined ? [] : [[platform, schedule[platform]]],
            ),
          ),
        }
      : {}),
  };
}
/** Every upload a post uses, with the kind it was uploaded as: its own media, its Chinese version, then the covers. */
export function postUploads(
  post: Pick<Post, "kind" | "mediaKinds" | "media" | "zh" | "cover">,
): { id: string; kind: "photo" | "video" }[] {
  // A Chinese version only comes with a video post, so post.kind describes it too.
  const kindOf = (i: number) => post.mediaKinds?.[i] ?? (post.kind === "photo" ? "photo" : "video");
  return [
    ...post.media.map((id, i) => ({ id, kind: kindOf(i) })),
    ...(post.zh?.video ? [{ id: post.zh.video, kind: "video" as const }] : []),
    ...(post.cover ? [{ id: post.cover, kind: "photo" as const }] : []),
    ...(post.zh?.cover ? [{ id: post.zh.cover, kind: "photo" as const }] : []),
  ];
}
/** Every upload a post uses. */
export function postMedia(post: Pick<Post, "kind" | "mediaKinds" | "media" | "zh" | "cover">): string[] {
  return postUploads(post).map((upload) => upload.id);
}
/**
 * Each platform's latest sign-in as `s`, joined to publications `t`. Read once per query: looking it up again for every
 * publication read every connection each time, and the History list is read often.
 */
export const SIGN_INS = `LEFT JOIN (SELECT platform, MAX(created_at) AS at FROM publisher_connections
  WHERE state='succeeded' GROUP BY platform) s ON s.platform=t.platform`;
/**
 * SQL for whether publication `t` went out through the helper before the platform's sign-in last changed, so it may
 * be on another account than the one connected now. A reconnect to the same account counts too: the helper can't tell
 * accounts apart. Grain and Bluesky always post as the owner's one DID. Needs `SIGN_INS`.
 */
export const EARLIER_SIGN_IN = `(t.linked=0 AND t.state='succeeded' AND t.platform NOT IN ('grain','bluesky')
  AND COALESCE(s.at,0)>COALESCE(t.finished_at,t.started_at,0))`;
/**
 * Sends a post that already went out to more destinations, checked again as if it were new. A destination it reached
 * only under an earlier sign-in can take it again, on the account connected now.
 */
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
  const { results: current } = await db
    .prepare(
      `SELECT DISTINCT t.platform FROM publisher_targets t ${SIGN_INS} WHERE t.job_id = ? AND NOT ${EARLIER_SIGN_IN}`,
    )
    .bind(input.job)
    .all<{ platform: Platform }>();
  const added = platforms.filter(
    (p) => Array.isArray(input.platforms) && input.platforms.includes(p) && !current.some((row) => row.platform === p),
  );
  if (!added.length) throw new PostError("Choose where to crosspost");
  // The title and Chinese version can be filled in now when the post went out without them.
  const next = validatePost({
    ...post,
    platforms: [...post.platforms, ...added.filter((p) => !post.platforms.includes(p))],
    // A post from before a destination existed has no policy saved for it.
    metadata: { ...defaultMetadata(), ...post.metadata },
    title: !post.title.trim() && typeof input.title === "string" ? input.title : post.title,
    zh: post.zh ?? input.zh,
    // Mixed posts from before the choice was asked already went out as carousels.
    ...(post.kind === "mixed" ? { carousel: true } : {}),
  });
  for (const id of postMedia(next))
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
/**
 * Adds a post the owner published themselves, such as a repost on a new account, to a post in History, so its stats
 * count toward it. The helper starts reading them as it does for anything it published.
 */
export async function linkPublication(
  db: NewsletterDB,
  input: { job?: unknown; url?: unknown },
): Promise<{ id: string; platform: Platform }> {
  if (!validId(input.job)) throw new PostError("Invalid post");
  const link = typeof input.url === "string" && input.url.length <= 2000 ? publicationLink(input.url) : null;
  if (!link || "error" in link)
    throw new PostError(link?.error ?? "Paste the post's full link, starting with https://");
  if (!(await db.prepare("SELECT id FROM publisher_jobs WHERE id = ?").bind(input.job).first()))
    throw new PostError("Invalid post");
  const { results } = await db
    .prepare(
      "SELECT t.url, j.payload FROM publisher_targets t JOIN publisher_jobs j ON j.id = t.job_id WHERE t.platform = ? AND t.url IS NOT NULL",
    )
    .bind(link.platform)
    .all<{ url: string; payload: string }>();
  const key = postKey(link.url);
  const taken = results.find((row) => postKey(row.url) === key);
  if (taken)
    throw new PostError(
      `This ${platformNames[link.platform]} post is already in “${postLabel(JSON.parse(taken.payload) as Post)}”`,
    );
  const id = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO publisher_targets (id, job_id, platform, state, url, finished_at, linked) VALUES (?, ?, ?, 'succeeded', ?, ?, 1)",
    )
    .bind(id, input.job, link.platform, link.url, Date.now())
    .run();
  return { id, platform: link.platform };
}
/** Takes a linked post and its stats out of History. The post itself stays up on its platform. */
export async function unlinkPublication(db: NewsletterDB, job: string, target: string): Promise<boolean> {
  const linked = await db
    .prepare(
      "SELECT id FROM publisher_targets WHERE id = ? AND job_id = ? AND linked = 1 AND id NOT IN (SELECT target_id FROM publisher_deletions WHERE state IN ('queued','working'))",
    )
    .bind(target, job)
    .first();
  if (!linked) return false;
  await db.batch([
    db.prepare("DELETE FROM publisher_metric_snapshots WHERE target_id = ?").bind(target),
    db.prepare("DELETE FROM publisher_metric_checks WHERE target_id = ?").bind(target),
    db.prepare("DELETE FROM publisher_deletions WHERE target_id = ?").bind(target),
    db.prepare("DELETE FROM publisher_targets WHERE id = ? AND linked = 1").bind(target),
  ]);
  return true;
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
/** `carousels`: the helper publishes `carouselTargets`; an older one is never given them. */
export async function claimTarget(db: NewsletterDB, supported: Platform[], { carousels = false } = {}) {
  await db
    .prepare(
      "UPDATE publisher_targets SET state = 'uncertain', message = 'Helper disconnected. Check the destination before retrying.' WHERE state = 'working' AND started_at < ?",
    )
    .bind(Date.now() - 60 * 60 * 1000)
    .run();
  if (!supported.length) return null;
  const claim = crypto.randomUUID();
  const newer = carousels
    ? ""
    : ` AND NOT EXISTS (SELECT 1 FROM publisher_jobs j WHERE j.id = publisher_targets.job_id AND publisher_targets.platform || ':' || json_extract(j.payload, '$.kind') IN (${carouselTargets
        .map(() => "?")
        .join(",")}))`;
  return db
    .prepare(
      // A scheduled destination waits for its time.
      `UPDATE publisher_targets SET state = 'working', claim = ?, started_at = ? WHERE id = (SELECT id FROM publisher_targets WHERE state = 'queued' AND (scheduled_at IS NULL OR scheduled_at <= ?) AND platform IN (${supported
        .map(() => "?")
        .join(",")})${newer} ORDER BY rowid LIMIT 1) AND state = 'queued' RETURNING *`,
    )
    .bind(
      claim,
      Date.now(),
      Date.now(),
      ...supported,
      ...(carousels ? [] : carouselTargets.map(([platform, kind]) => `${platform}:${kind}`)),
    )
    .first<{ id: string; job_id: string; platform: Platform; claim: string }>();
}

/** What a destination stopped before it published says. It never reached the platform, so it can be scheduled again. */
export const STOPPED_BEFORE = "Stopped before publishing.";
/** Releases a target at once. Its claim stays, so a success the laptop confirms late still lands; a retry clears it. */
export async function stopTarget(db: NewsletterDB, job: string, target: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE publisher_targets SET
        state = CASE state WHEN 'queued' THEN 'failed' ELSE 'uncertain' END,
        message = CASE state WHEN 'queued' THEN ? ELSE 'Stopped while publishing. Check the destination before publishing again.' END,
        finished_at = ?
      WHERE id = ? AND job_id = ? AND state IN ('queued','working')`,
    )
    .bind(STOPPED_BEFORE, Date.now(), target, job)
    .run();
  return result.meta.changes > 0;
}
/**
 * Moves a destination still waiting to publish to a new time, or schedules one stopped before it published again.
 * The time must fall within the next week and before the post's first upload expires. False when the destination is
 * publishing or done by now.
 */
export async function rescheduleTarget(db: NewsletterDB, job: string, target: string, at: unknown): Promise<boolean> {
  const now = Date.now();
  if (typeof at !== "number" || !Number.isInteger(at) || at < now - SCHEDULE_SLACK || at > now + UPLOAD_LIFETIME)
    throw new PostError("Choose a time within the next week");
  const first = await db
    .prepare("SELECT MIN(created_at) AS at FROM publisher_media WHERE job_id = ?")
    .bind(job)
    .first<{ at: number | null }>();
  const expires = first?.at ? first.at + UPLOAD_LIFETIME - EXPIRY_MARGIN : Number.POSITIVE_INFINITY;
  if (at > expires)
    throw new PostError(`This post's uploads expire ${new Date(expires).toUTCString()}. Choose an earlier time.`);
  const result = await db
    .prepare(
      `UPDATE publisher_targets SET state = 'queued', scheduled_at = ?, claim = NULL, started_at = NULL,
        finished_at = NULL, message = NULL, url = NULL
      WHERE id = ? AND job_id = ? AND (state = 'queued' OR (state = 'failed' AND message = ?))`,
    )
    .bind(at, target, job, STOPPED_BEFORE)
    .run();
  return result.meta.changes > 0;
}
/** What can change in a post once it's queued: its words. */
export interface PostEdit {
  title: string;
  caption: string;
  tags: string[];
  short: string;
  zh?: { title: string; text: string; topics: string[] };
}
/**
 * Rewrites a post's words for the destinations it hasn't reached: those waiting, stopped or failed, which a retry
 * publishes as edited. One that's out, or publishing now, keeps the version it got. False when none is left to change.
 */
export async function editPost(db: NewsletterDB, job: string, edit: PostEdit): Promise<boolean> {
  const row = await db
    .prepare("SELECT payload FROM publisher_jobs WHERE id = ?")
    .bind(job)
    .first<{ payload: string }>();
  if (!row) throw new PostError("Invalid post");
  const post = JSON.parse(row.payload) as Post;
  const { results } = await db
    .prepare("SELECT DISTINCT platform FROM publisher_targets WHERE job_id = ? AND state IN ('queued','failed')")
    .bind(job)
    .all<{ platform: Platform }>();
  const open = post.platforms.filter((platform) => results.some((result) => result.platform === platform));
  if (!open.length) return false;
  const edited = validatePost({
    ...post,
    title: edit.title,
    caption: edit.caption,
    tags: edit.tags,
    short: edit.short,
    zh:
      post.zh && edit.zh && open.includes("xiaohongshu")
        ? { ...post.zh, title: edit.zh.title, text: edit.zh.text, topics: edit.zh.topics }
        : post.zh,
    platforms: open,
    metadata: { ...defaultMetadata(), ...post.metadata },
    // Its times were checked when it was queued; moving one is a reschedule.
    schedule: undefined,
  });
  const next = {
    ...edited,
    platforms: post.platforms,
    variants: Object.fromEntries(
      post.platforms.map((platform) => [
        platform,
        edited.variants?.[platform] ?? post.variants?.[platform] ?? renderVariant(platform, post),
      ]),
    ),
    ...(post.schedule ? { schedule: post.schedule } : {}),
  };
  // Only over the version read, so two edits at once can't undo each other.
  const result = await db
    .prepare("UPDATE publisher_jobs SET payload = ? WHERE id = ? AND payload = ?")
    .bind(JSON.stringify(next), job, row.payload)
    .run();
  if (!result.meta.changes) throw new PostError("The post changed in the meantime. Try again.");
  return true;
}
/** Records a post the owner found on the platform, when publishing couldn't confirm it. */
export async function markPublished(db: NewsletterDB, job: string, target: string, url: string): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE publisher_targets SET state = 'succeeded', url = ?, message = NULL, finished_at = ? WHERE id = ? AND job_id = ? AND state = 'uncertain'",
    )
    .bind(url, Date.now(), target, job)
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
/**
 * publisher_one_connection's condition, word for word. The helper asks every few seconds, and SQLite reads that
 * one-row partial index only for a query that repeats it; otherwise it reads every connection there has been.
 */
export const OPEN_CONNECTION = "state IN ('queued','working')";
export async function claimConnection(db: NewsletterDB) {
  await db
    .prepare(
      "UPDATE publisher_connections SET state='failed', payload=NULL, message='Connection expired. Try again.' WHERE state IN ('queued','working') AND created_at < ?",
    )
    .bind(Date.now() - 15 * 60_000)
    .run();
  return db
    .prepare(
      `UPDATE publisher_connections SET state='working', claim=? WHERE id=(SELECT id FROM publisher_connections
      WHERE ${OPEN_CONNECTION} AND state='queued' ORDER BY created_at LIMIT 1) AND state='queued' RETURNING *`,
    )
    .bind(crypto.randomUUID())
    .first<{ id: string; platform: Platform; action: string; payload: string | null; claim: string }>();
}
