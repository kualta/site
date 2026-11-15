import type { NewsletterDB } from "../newsletter/types";
import { PostError, validId } from "./server";

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
/** How many posted pieces the Pipeline lists; the rest are in History. */
export const POSTED_SHOWN = 30;

/** A piece of content, from its idea to the post it went out as. */
export interface Content {
  id: string;
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
}
const COLUMNS =
  "c.id, c.title, c.notes, c.stage, c.job_id, c.created_at, c.stage_at, t.created_at AS thumbnail FROM publisher_content c LEFT JOIN publisher_thumbnails t ON t.job_id = c.job_id";

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
    .all<Content>();
  return results;
}

export async function readContent(db: NewsletterDB, id: string): Promise<Content | null> {
  return db.prepare(`SELECT ${COLUMNS} WHERE c.id = ?`).bind(id).first<Content>();
}

export async function createContent(db: NewsletterDB, value: unknown, now = Date.now()): Promise<Content> {
  const fields = readFields(value);
  if (fields.title === undefined) throw new PostError("Give it a title");
  if (fields.job !== undefined) throw new PostError("Link a post from the composer");
  const piece: Content = {
    id: crypto.randomUUID(),
    title: fields.title,
    notes: fields.notes ?? "",
    stage: fields.stage ?? "idea",
    job_id: null,
    created_at: now,
    stage_at: now,
    thumbnail: null,
  };
  await db
    .prepare("INSERT INTO publisher_content (id, title, notes, stage, created_at, stage_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(piece.id, piece.title, piece.notes, piece.stage, now, now)
    .run();
  return piece;
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

/** Cancelling a post that never went out puts the piece it was back at Edit ready, before the post is deleted. */
export const releaseJob = (db: NewsletterDB, job: string, now = Date.now()) =>
  db
    .prepare("UPDATE publisher_content SET stage = 'edit', job_id = NULL, stage_at = ? WHERE job_id = ?")
    .bind(now, job);
