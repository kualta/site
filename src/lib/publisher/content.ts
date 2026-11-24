import type { NewsletterDB, Statement } from "../newsletter/types";
import type { Metrics } from "./metrics";
import { postLabel, type Platform, type PostKind } from "./presets";
import { PostError, validId, type Post } from "./server";

/** Where a piece of content is on its way out, in order. */
export const stages = ["idea", "script", "footage", "edit", "posted"] as const;
export type Stage = (typeof stages)[number];
export const stageNames: Record<Stage, string> = {
  idea: "Idea",
  script: "Script ready",
  footage: "Footage ready",
  edit: "Edit ready",
  posted: "Posted",
};
export const isStage = (value: unknown): value is Stage => stages.includes(value as Stage);
export const MAX_CONTENT_TITLE = 200;
export const MAX_CONTENT_NOTES = 20_000;
/** How many posted pieces the Pipeline lists; the rest are in History. Their posts are read in one statement, which
 * binds at most 100 values. */
export const POSTED_SHOWN = 30;
/**
 * The films made before pieces had numbers run to 016 (`node scripts/publisher/cli.mjs archives` lists them). Pieces
 * count on from there, so a new piece's number is free for its film's folder.
 */
export const NUMBERED_AFTER = 16;
/** A piece's number as its film's folder starts with it: 017. */
export const pieceNumber = (number: number) => String(number).padStart(3, "0");
/** A piece as the post app names it, "017 · Big cookie", or by its title alone until it has a number. */
export const pieceLabel = ({ number, title }: Pick<Content, "number" | "title">) =>
  number === null ? title : `${pieceNumber(number)} · ${title}`;

/** A destination a piece's post went out to, with its latest counts. */
export interface PieceTarget {
  id: string;
  platform: Platform;
  url: string | null;
  /** Taken down since. */
  deleted: boolean;
  metrics: Metrics | null;
}
/** What a posted piece shows of its post: what it holds, for its picture, and where it went out. */
export interface PiecePost {
  kind: PostKind;
  media: string[];
  mediaKinds?: ("photo" | "video")[];
  cover?: string;
  targets: PieceTarget[];
}

/** A piece of content, from its idea to the post it went out as. */
export interface Content {
  id: string;
  /** Its film's folder starts with it. Null only for a piece from before numbers that hasn't been given one yet. */
  number: number | null;
  title: string;
  /** The script, shot list or anything else written down for it. */
  notes: string;
  stage: Stage;
  /** The post it went out as, once queued from the composer. */
  job_id: string | null;
  created_at: number;
  /** When it reached its stage. */
  stage_at: number;
  /** When its post's kept thumbnail was saved, or null. */
  thumbnail: number | null;
  /** Its post, once it went out as one. */
  post: PiecePost | null;
}
type ContentRow = Omit<Content, "post">;
const COLUMNS =
  "c.id, c.number, c.title, c.notes, c.stage, c.job_id, c.created_at, c.stage_at, t.created_at AS thumbnail FROM publisher_content c LEFT JOIN publisher_thumbnails t ON t.job_id = c.job_id";

interface Fields {
  title?: string;
  notes?: string;
  stage?: Stage;
  job?: string;
}
/** What a request sets, each field checked; a field it leaves out stays as it is. */
function readFields(value: unknown): Fields {
  const input = value as Record<string, unknown> | null;
  if (!input || typeof input !== "object") throw new PostError("Invalid content");
  const fields: Fields = {};
  if (input.title !== undefined) {
    if (typeof input.title !== "string" || !input.title.trim()) throw new PostError("Give it a title");
    if (input.title.length > MAX_CONTENT_TITLE)
      throw new PostError(`Keep the title to ${MAX_CONTENT_TITLE} characters`);
    fields.title = input.title.trim();
  }
  if (input.notes !== undefined) {
    if (typeof input.notes !== "string" || input.notes.length > MAX_CONTENT_NOTES)
      throw new PostError("Keep the notes to 20,000 characters");
    fields.notes = input.notes;
  }
  if (input.stage !== undefined) {
    if (!isStage(input.stage)) throw new PostError("Invalid stage");
    fields.stage = input.stage;
  }
  if (input.job !== undefined) {
    if (!validId(input.job)) throw new PostError("Invalid post");
    fields.job = input.job;
  }
  return fields;
}

/** Each piece with what it shows of its post, reading every post and its destinations at once. */
async function withPosts(db: NewsletterDB, rows: ContentRow[]): Promise<Content[]> {
  const jobs = [...new Set(rows.flatMap((row) => (row.job_id ? [row.job_id] : [])))];
  const posts = new Map<string, PiecePost>();
  if (jobs.length) {
    const marks = jobs.map(() => "?").join(",");
    const [payloads, targets] = await Promise.all([
      db
        .prepare(`SELECT id, payload FROM publisher_jobs WHERE id IN (${marks})`)
        .bind(...jobs)
        .all<{ id: string; payload: string }>(),
      db
        .prepare(
          `SELECT t.job_id, t.id, t.platform, t.url, s.metrics,
             EXISTS(SELECT 1 FROM publisher_deletions d WHERE d.target_id = t.id AND d.state = 'deleted') AS deleted
           FROM publisher_targets t
           LEFT JOIN publisher_metric_snapshots s ON s.target_id = t.id
             AND s.observed_at = (SELECT MAX(observed_at) FROM publisher_metric_snapshots WHERE target_id = t.id)
           WHERE t.state = 'succeeded' AND t.job_id IN (${marks})`,
        )
        .bind(...jobs)
        .all<{
          job_id: string;
          id: string;
          platform: Platform;
          url: string | null;
          metrics: string | null;
          deleted: number;
        }>(),
    ]);
    for (const { id, payload } of payloads.results) {
      const post = JSON.parse(payload) as Partial<Post>;
      posts.set(id, {
        kind: post.kind ?? "text",
        media: post.media ?? [],
        ...(post.mediaKinds ? { mediaKinds: post.mediaKinds } : {}),
        ...(post.cover ? { cover: post.cover } : {}),
        targets: [],
      });
    }
    for (const target of targets.results)
      posts.get(target.job_id)?.targets.push({
        id: target.id,
        platform: target.platform,
        url: target.url,
        deleted: Boolean(target.deleted),
        metrics: target.metrics ? JSON.parse(target.metrics) : null,
      });
  }
  return rows.map((row) => ({ ...row, post: (row.job_id && posts.get(row.job_id)) || null }));
}

/** Every piece still on its way, and the most recently posted; each stage's latest arrival first. */
export async function listContent(db: NewsletterDB, posted = POSTED_SHOWN): Promise<Content[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM (SELECT ${COLUMNS} WHERE c.stage != 'posted')
       UNION ALL
       SELECT * FROM (SELECT ${COLUMNS} WHERE c.stage = 'posted' ORDER BY c.stage_at DESC LIMIT ?)
       ORDER BY stage_at DESC`,
    )
    .bind(posted)
    .all<ContentRow>();
  return withPosts(db, results);
}

export async function readContent(db: NewsletterDB, id: string): Promise<Content | null> {
  const row = await db.prepare(`SELECT ${COLUMNS} WHERE c.id = ?`).bind(id).first<ContentRow>();
  return row && (await withPosts(db, [row]))[0];
}

/** The piece numbered `number`, or null when none is. */
export async function readNumbered(db: NewsletterDB, number: number): Promise<Content | null> {
  const row = await db.prepare(`SELECT ${COLUMNS} WHERE c.number = ?`).bind(number).first<ContentRow>();
  return row && (await withPosts(db, [row]))[0];
}

/**
 * SQL for the number a new piece takes, in the statement that writes it: one more than every piece's and than the
 * value bound as `after`. D1 runs one statement at a time, and its unique index refuses a number twice.
 */
const nextNumber = (after: string) => `(SELECT MAX(COALESCE(MAX(number), 0), ${after}) + 1 FROM publisher_content)`;
const numberTaken = (error: unknown) =>
  /UNIQUE constraint failed: publisher_content\.number/.test(String((error as Error | null)?.message));
/** Runs a write that numbers a piece, again if another piece took its number meanwhile. */
export async function numbering<T>(write: () => Promise<T>, tries = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await write();
    } catch (error) {
      if (attempt >= tries || !numberTaken(error)) throw error;
    }
  }
}

/** A new piece, numbered after every piece and after `after`: the laptop's highest film, when it asks. */
export async function createContent(
  db: NewsletterDB,
  value: unknown,
  now = Date.now(),
  after = NUMBERED_AFTER,
): Promise<Content> {
  const fields = readFields(value);
  if (fields.title === undefined) throw new PostError("Give it a title");
  if (fields.job !== undefined) throw new PostError("Link a post from the composer");
  const id = crypto.randomUUID();
  const title = fields.title;
  const notes = fields.notes ?? "";
  const stage = fields.stage ?? "idea";
  const row = await numbering(() =>
    db
      .prepare(
        `INSERT INTO publisher_content (id, title, notes, stage, number, created_at, stage_at)
         VALUES (?1, ?2, ?3, ?4, ${nextNumber("?6")}, ?5, ?5) RETURNING number`,
      )
      .bind(id, title, notes, stage, now, Math.max(after, NUMBERED_AFTER))
      .first<{ number: number }>(),
  );
  if (!row) throw new Error("The piece wasn't saved");
  return {
    id,
    number: row.number,
    title,
    notes,
    stage,
    job_id: null,
    created_at: now,
    stage_at: now,
    thumbnail: null,
    post: null,
  };
}

/**
 * Changes what's given. Linking a post moves it to Posted; moving it anywhere else lets go of its post. Null when
 * there's no such piece.
 */
export async function updateContent(
  db: NewsletterDB,
  id: string,
  value: unknown,
  now = Date.now(),
): Promise<Content | null> {
  const fields = readFields(value);
  if (fields.job !== undefined) {
    if (fields.stage !== undefined && fields.stage !== "posted") throw new PostError("A linked post means it's posted");
    if (!(await db.prepare("SELECT id FROM publisher_jobs WHERE id = ?").bind(fields.job).first()))
      throw new PostError("No such post");
  }
  const stage = fields.job !== undefined ? "posted" : fields.stage;
  // Every expression reads the row as it was before the update.
  const result = await db
    .prepare(
      `UPDATE publisher_content SET
         title = COALESCE(?1, title),
         notes = COALESCE(?2, notes),
         stage_at = CASE WHEN ?3 IS NOT NULL AND ?3 != stage THEN ?4 ELSE stage_at END,
         stage = COALESCE(?3, stage),
         job_id = CASE WHEN COALESCE(?3, stage) = 'posted' THEN COALESCE(?5, job_id) END
       WHERE id = ?6`,
    )
    .bind(fields.title ?? null, fields.notes ?? null, stage ?? null, now, fields.job ?? null, id)
    .run();
  return result.meta.changes ? readContent(db, id) : null;
}

export async function deleteContent(db: NewsletterDB, id: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM publisher_content WHERE id = ?").bind(id).run();
  return result.meta.changes > 0;
}

/**
 * Where a post goes in the Pipeline as it's queued, in the same batch as the post, after it. The piece the composer
 * linked moves to Posted; a post without one, or whose piece has gone or holds another post, gets a piece of its own
 * in Posted, named as History names it, sharing the post's id and numbered as any new piece is. Run the batch through
 * `numbering`.
 */
export function placeJob(
  db: NewsletterDB,
  post: Pick<Post, "id" | "title" | "caption">,
  content: string | null,
  now = Date.now(),
): Statement[] {
  const statements: Statement[] = [];
  if (content)
    statements.push(
      db
        .prepare(
          "UPDATE publisher_content SET stage = 'posted', job_id = ?, stage_at = ? WHERE id = ? AND job_id IS NULL",
        )
        .bind(post.id, now, content),
    );
  // Runs after the link, so a post whose piece took it gets no second one.
  statements.push(
    db
      .prepare(
        `INSERT INTO publisher_content (id, title, notes, stage, job_id, number, created_at, stage_at)
         SELECT ?1, ?2, '', 'posted', ?1, ${nextNumber("?4")}, ?3, ?3
         WHERE NOT EXISTS (SELECT 1 FROM publisher_content WHERE job_id = ?1)`,
      )
      .bind(post.id, postLabel(post), now, NUMBERED_AFTER),
  );
  return statements;
}

/**
 * Cancelling a post that never went out, before the post is deleted: a piece it made for itself goes with it, and a
 * piece the composer linked goes back to Edit ready.
 */
export const releaseJob = (db: NewsletterDB, job: string, now = Date.now()): Statement[] => [
  db.prepare("DELETE FROM publisher_content WHERE id = ? AND job_id = ?").bind(job, job),
  db
    .prepare("UPDATE publisher_content SET stage = 'edit', job_id = NULL, stage_at = ? WHERE job_id = ?")
    .bind(now, job),
];
