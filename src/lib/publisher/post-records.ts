import type { NewsletterDB } from "../newsletter/types";
import { publicationLink } from "./links";
import type { Platform, PostKind } from "./presets";
import { PostError, coverPlatforms, validId, type Post } from "./server";
import { isTag, renderVariant } from "./variants";

/**
 * What a post's public record (`dev.kualta.post`, in the owner's AT Protocol repository) is made from. Only what a
 * copy that is up now already shows leaves here; a post with no such copy leaves as its id alone.
 */
export interface PostRecordSource {
  id: string;
  created_at?: number;
  /** The words as the fullest copy that is up shows them. */
  post?: { kind: PostKind; title: string; text: string; tags: string[] };
  /**
   * Every public copy that went up, in the order they were queued, with the ones since deleted marked.
   * `published_at` is absent when the owner linked the copy or marked it published by hand: its time is then when
   * that was done, not when it went up.
   */
  targets: { platform: Platform; url: string; published_at: number | null; deleted: boolean }[];
  /** The stored thumbnail's type, size and SHA-256, which fix its blob's address without sending its bytes. */
  thumbnail?: { type: string; size: number; sha256: string } | null;
}
const PAGE = 20;
const MAX_TAGS = 30;
type JobRow = { id: string; payload: string; created_at: number };
type TargetRow = {
  job_id: string;
  platform: Platform;
  url: string;
  finished_at: number | null;
  linked: number;
  message: string | null;
  deletion: string | null;
};

/** Whose version speaks for the post when several copies are up: the fullest first. */
const fullest: Platform[] = [
  "grain",
  "lens",
  "youtube",
  "instagram",
  "tiktok",
  "bluesky",
  "farcaster",
  "twitter",
  "xiaohongshu",
];

/**
 * The words the copies on `platforms` show, taken from the version each one was sent: a post edited after a copy went
 * out, its short version and its Chinese version all differ from what the composer holds.
 */
function shown(post: Post, platforms: Platform[]) {
  const sent = fullest
    .filter((platform) => platforms.includes(platform))
    .map((platform) => ({ platform, ...(post.variants?.[platform] ?? renderVariant(platform, post)) }));
  // Xiaohongshu's version is a translation, so it speaks for the post only when nothing else is up.
  const others = sent.filter((version) => version.platform !== "xiaohongshu");
  const versions = others.length ? others : sent;
  // The thumbnail may be of the post's cover, which only some destinations show, and not one given its own.
  const coverShown = sent.some((version) => coverPlatforms.includes(version.platform) && !version.cover);
  const tags = new Map<string, string>();
  for (const version of versions) {
    const written = (version.text.match(/#[\p{L}\p{N}_]+/gu) ?? []).map((tag) => tag.slice(1));
    for (const tag of [...version.tags, ...written])
      if (isTag(tag) && !tags.has(tag.toLowerCase())) tags.set(tag.toLowerCase(), tag);
  }
  return {
    // YouTube shows a title on a video only; its photo posts have none.
    title:
      versions.find((version) => version.title && (version.platform !== "youtube" || post.kind === "video"))?.title ??
      "",
    text: versions[0]?.text ?? "",
    tags: [...tags.values()].slice(0, MAX_TAGS),
    // The thumbnail is of the post's own media, which a copy carrying another video doesn't show.
    ownMedia: versions.some((version) => !version.video) && (!post.cover || coverShown),
  };
}

/** A copy's link without what a share link adds to it, such as the tracking of who shared it. */
function publicUrl(platform: Platform, value: string): string | null {
  const link = publicationLink(value);
  if ("url" in link && link.platform === platform) return link.url;
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  url.search = "";
  url.hash = "";
  return url.href;
}

async function sha256(data: Uint8Array<ArrayBuffer>): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}

async function sources(db: NewsletterDB, jobs: JobRow[]): Promise<PostRecordSource[]> {
  if (!jobs.length) return [];
  const marks = jobs.map(() => "?").join(",");
  const { results: rows } = await db
    .prepare(
      `SELECT t.job_id, t.platform, t.url, t.finished_at, t.linked, t.message, d.state AS deletion
       FROM publisher_targets t LEFT JOIN publisher_deletions d ON d.target_id = t.id
       WHERE t.state = 'succeeded' AND t.url IS NOT NULL AND t.job_id IN (${marks}) ORDER BY t.rowid`,
    )
    .bind(...jobs.map((job) => job.id))
    .all<TargetRow>();
  return Promise.all(
    jobs.map(async (job): Promise<PostRecordSource> => {
      const post = JSON.parse(job.payload) as Post;
      const copies = rows.flatMap((row) => {
        // `visibility` is YouTube's privacy setting: a private or unlisted video is not a public copy.
        if (row.job_id !== job.id || (row.platform === "youtube" && post.visibility !== "PUBLIC")) return [];
        const url = publicUrl(row.platform, row.url);
        return url ? [{ ...row, url }] : [];
      });
      const live = copies.filter((row) => row.deletion !== "deleted");
      if (!live.length) return { id: job.id, targets: [] };
      // A copy the owner linked was written elsewhere, so only the ones sent from here say what the words are.
      const { ownMedia, ...words } = shown(
        post,
        live.filter((row) => !row.linked).map((row) => row.platform),
      );
      const thumbnail = ownMedia
        ? await db
            .prepare("SELECT type, data FROM publisher_thumbnails WHERE job_id = ?")
            .bind(job.id)
            .first<{ type: string; data: ArrayBuffer | ArrayLike<number> }>()
        : null;
      const data = thumbnail && new Uint8Array(thumbnail.data);
      return {
        id: job.id,
        created_at: job.created_at,
        post: { kind: post.kind, ...words },
        targets: copies.map((row) => ({
          platform: row.platform,
          url: row.url,
          // The helper's receipt always carries a message; marking a copy published by hand clears it.
          published_at: !row.linked && row.message !== null ? row.finished_at : null,
          deleted: row.deletion === "deleted",
        })),
        thumbnail:
          thumbnail && data ? { type: thumbnail.type, size: data.byteLength, sha256: await sha256(data) } : null,
      };
    }),
  );
}

/** Every post, newest first, a page at a time: the helper reconciles each one's record against it. */
export async function postRecordPage(db: NewsletterDB, cursor: string | null) {
  const [timestamp, id] = cursor?.split(":") || [];
  if (cursor && (!/^\d+$/.test(timestamp) || !validId(id))) throw new PostError("Invalid post cursor");
  const query = db.prepare(
    `SELECT id, payload, created_at FROM publisher_jobs ${
      cursor ? "WHERE created_at < ? OR (created_at = ? AND id < ?)" : ""
    } ORDER BY created_at DESC, id DESC LIMIT ${PAGE + 1}`,
  );
  const { results } = await (cursor ? query.bind(Number(timestamp), Number(timestamp), id) : query).all<JobRow>();
  const page = results.slice(0, PAGE);
  const last = page[page.length - 1];
  return {
    jobs: await sources(db, page),
    next: results.length > PAGE ? `${last.created_at}:${last.id}` : null,
  };
}

export async function postRecordSource(db: NewsletterDB, job: string): Promise<PostRecordSource | null> {
  const row = await db
    .prepare("SELECT id, payload, created_at FROM publisher_jobs WHERE id = ?")
    .bind(job)
    .first<JobRow>();
  return row ? (await sources(db, [row]))[0] : null;
}
