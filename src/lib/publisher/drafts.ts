import { defaultMetadata, platforms, support } from "./presets";
import { PostError, postMedia, postUploads, validatePost, type MediaBucket } from "./server";

/** A video post prepared from the terminal, waiting in the composer for the owner to publish it. */
export interface Draft {
  id: string;
  /** The uploaded video's media id. */
  video: string;
  /** The preset tab to open on, if the owner still has it. */
  preset?: string;
  title: string;
  caption: string;
  alt: string;
  tags?: string[];
  short?: string;
  zh?: { title: string; text: string; topics: string[]; video?: string; cover?: string; location?: string };
  /** The cover image's media id, with the Chinese video's own frame in `zh.cover`. */
  cover?: string;
  location?: string;
}

const videoDestinations = platforms.filter((platform) => support[platform].includes("video"));
// Stored beside the media, so a draft expires with its video. Media ids are bare UUIDs, so the media routes can't reach it.
export const draftKey = (id: string) => `draft-${id}`;

/** Checked as a post to every video destination, so whichever ones the composer has selected can publish it as written. */
export function validateDraft(value: unknown): Omit<Draft, "id"> {
  const input = value as Partial<Draft> | null;
  if (input?.preset !== undefined && !/^[a-zA-Z0-9-]{1,64}$/.test(String(input.preset)))
    throw new PostError("Invalid preset");
  const post = validatePost({
    ...input,
    id: crypto.randomUUID(),
    kind: "video",
    media: [input?.video],
    alt: input?.alt ?? "",
    platforms: videoDestinations,
    metadata: defaultMetadata(),
    visibility: "PRIVATE",
  });
  return {
    video: post.media[0],
    ...(input?.preset ? { preset: input.preset } : {}),
    title: post.title,
    caption: post.caption,
    alt: post.alt,
    ...(post.tags ? { tags: post.tags } : {}),
    ...(post.short ? { short: post.short } : {}),
    ...(post.zh ? { zh: post.zh } : {}),
    ...(post.cover ? { cover: post.cover } : {}),
    ...(post.location ? { location: post.location } : {}),
  };
}

/** Lets the terminal find out what to fix in the text before it uploads the video. */
export function checkDraftText(value: unknown): void {
  validateDraft({ ...(value as object), video: crypto.randomUUID() });
}

export async function saveDraft(bucket: Pick<MediaBucket, "head" | "put">, value: unknown): Promise<string> {
  const draft = validateDraft(value);
  for (const { id, kind } of postUploads({ kind: "video", media: [draft.video], zh: draft.zh, cover: draft.cover }))
    if (!(await bucket.head(id)))
      throw new PostError(kind === "photo" ? "The draft's cover is missing" : "The draft's video is missing");
  const id = crypto.randomUUID();
  await bucket.put(draftKey(id), JSON.stringify({ id, ...draft }), {
    httpMetadata: { contentType: "application/json" },
  });
  return id;
}

export async function readDraft(bucket: Pick<MediaBucket, "get">, id: string): Promise<Draft | null> {
  const object = await bucket.get(draftKey(id));
  return object && ((await new Response(object.body).json()) as Draft);
}

/**
 * Removes a draft and whatever it uploaded that no job holds; `release` drops those uploads' records and says which
 * they were. Publishing deletes its draft this way too, by which time the job holds its uploads, so they stay.
 */
export async function deleteDraft(
  bucket: Pick<MediaBucket, "get" | "delete">,
  id: string,
  release: (uploads: string[]) => Promise<string[]>,
): Promise<void> {
  const draft = await readDraft(bucket, id);
  await bucket.delete(draftKey(id));
  if (!draft) return;
  const free = await release(postMedia({ kind: "video", media: [draft.video], zh: draft.zh, cover: draft.cover }));
  if (free.length) await bucket.delete(free);
}

/** The bucket expires every object a week after it's uploaded, a draft along with its video. */
export const DRAFT_LIFETIME = 7 * 86_400_000;
/** What the composer lists of a draft waiting to be posted. */
export interface DraftSummary {
  id: string;
  title: string;
  caption: string;
  video: string;
  cover?: string;
  /** Whether it carries a version of the video made for Chinese audiences. */
  chinese: boolean;
  created: number;
  expires: number;
}
/**
 * Drafts not yet posted, newest first. Queueing deletes a draft; if that delete was lost, its video already belongs
 * to a job, so `posted` (the videos a job holds) leaves it out.
 */
export async function listDrafts(
  bucket: Pick<MediaBucket, "get" | "list">,
  posted: (videos: string[]) => Promise<Set<string>>,
): Promise<DraftSummary[]> {
  const objects: { key: string; uploaded: Date }[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: draftKey(""), cursor });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  // One can expire between the listing and the read; it's just gone.
  const found = await Promise.all(
    objects.map(async ({ key, uploaded }) => {
      const draft = await readDraft(bucket, key.slice(draftKey("").length));
      return draft && { draft, created: uploaded.getTime() };
    }),
  );
  const drafts = found.filter((entry) => entry !== null);
  const taken = await posted(drafts.map(({ draft }) => draft.video));
  return drafts
    .filter(({ draft }) => !taken.has(draft.video))
    .sort((a, b) => b.created - a.created)
    .map(({ draft, created }) => ({
      id: draft.id,
      title: draft.title,
      caption: draft.caption,
      video: draft.video,
      ...(draft.cover ? { cover: draft.cover } : {}),
      chinese: Boolean(draft.zh?.video),
      created,
      expires: created + DRAFT_LIFETIME,
    }));
}
