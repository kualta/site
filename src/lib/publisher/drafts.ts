import { defaultMetadata, platforms, support } from "./presets";
import { MAX_LOCATION, PostError, postMedia, postUploads, validatePost, validId, type MediaBucket } from "./server";

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
  /** Saved from the composer: the second its cover frame was taken at, so the Chinese version gets the same moment. */
  coverAt?: number;
  /** Saved from the composer: the tags and topics as typed, which can hold a word that isn't a tag yet. */
  tagsText?: string;
  zhTopicsText?: string;
  /** Saved from the composer: when its video was uploaded, which is when the bucket starts counting its week. */
  created?: number;
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

const text = (value: unknown, max: number) => typeof value === "string" && value.length <= max;
const optionalText = (value: unknown, max: number) => value === undefined || text(value, max);
const optionalId = (value: unknown) => value === undefined || validId(value);
const words = (value: unknown, max: number) =>
  Array.isArray(value) && value.length <= max && value.every((word) => text(word, 100));

/**
 * A draft as the owner left it in the composer. It may be half written, so only its shape is checked: publishing
 * checks the rest.
 */
export function validateComposerDraft(value: unknown): Omit<Draft, "id" | "created"> {
  const d = value as Partial<Draft> | null;
  const zh = d?.zh;
  const media = [d?.video, zh?.video, d?.cover, zh?.cover].filter(Boolean);
  if (
    !d ||
    new Set(media).size !== media.length ||
    (zh?.cover && !d.cover) ||
    !validId(d.video) ||
    (d.preset !== undefined && !/^[a-zA-Z0-9-]{1,64}$/.test(String(d.preset))) ||
    !text(d.title, 100) ||
    !text(d.caption, 5000) ||
    !text(d.alt, 1000) ||
    (d.tags !== undefined && !words(d.tags, 30)) ||
    !optionalText(d.tagsText, 1000) ||
    !optionalText(d.short, 1000) ||
    !optionalText(d.location, MAX_LOCATION) ||
    !optionalId(d.cover) ||
    (d.coverAt !== undefined && !(typeof d.coverAt === "number" && d.coverAt >= 0 && d.coverAt < 86_400)) ||
    !optionalText(d.zhTopicsText, 500) ||
    (zh !== undefined &&
      (!text(zh.title, 100) ||
        !text(zh.text, 5000) ||
        !words(zh.topics, 30) ||
        !optionalId(zh.video) ||
        !optionalId(zh.cover) ||
        !optionalText(zh.location, MAX_LOCATION)))
  )
    throw new PostError("This draft can't be saved");
  return {
    video: d.video,
    ...(d.preset ? { preset: d.preset } : {}),
    title: d.title as string,
    caption: d.caption as string,
    alt: d.alt as string,
    ...(d.tags?.length ? { tags: d.tags } : {}),
    ...(d.tagsText ? { tagsText: d.tagsText } : {}),
    ...(d.short ? { short: d.short } : {}),
    ...(zh
      ? {
          zh: {
            title: zh.title,
            text: zh.text,
            topics: zh.topics,
            ...(zh.video ? { video: zh.video } : {}),
            ...(zh.cover ? { cover: zh.cover } : {}),
            ...(zh.location ? { location: zh.location } : {}),
          },
        }
      : {}),
    ...(d.zhTopicsText ? { zhTopicsText: d.zhTopicsText } : {}),
    ...(d.cover ? { cover: d.cover } : {}),
    ...(d.coverAt !== undefined && d.cover ? { coverAt: d.coverAt } : {}),
    ...(d.location ? { location: d.location } : {}),
  };
}

/**
 * Saves the composer's draft, as a new one or over draft `id`. Its uploads must be in the bucket. It keeps when its
 * video was uploaded, so the list still says when the bucket removes it. Returns the uploads the draft let go of.
 */
export async function saveComposerDraft(
  bucket: Pick<MediaBucket, "head" | "put" | "get">,
  value: unknown,
  id?: string,
  now = Date.now(),
): Promise<{ id: string; released: string[] }> {
  const draft = validateComposerDraft(value);
  const object = id ? await bucket.get(draftKey(id)) : null;
  if (id && !object) throw new PostError("This draft has expired or was already posted");
  const old = object && ((await new Response(object.body).json()) as Draft);
  const uploads = postUploads({ kind: "video", media: [draft.video], zh: draft.zh, cover: draft.cover });
  const known = old ? postMedia({ kind: "video", media: [old.video], zh: old.zh, cover: old.cover }) : [];
  for (const upload of uploads)
    if (!known.includes(upload.id) && !(await bucket.head(upload.id)))
      throw new PostError(upload.kind === "photo" ? "The draft's cover is missing" : "The draft's video is missing");
  const key = id ?? crypto.randomUUID();
  // A draft from the terminal went up just after its video, so its own upload time stands for the video's.
  const created = old && old.video === draft.video ? old.created ?? object?.uploaded?.getTime() : now;
  await bucket.put(draftKey(key), JSON.stringify({ id: key, ...draft, ...(created ? { created } : {}) }), {
    httpMetadata: { contentType: "application/json" },
  });
  return { id: key, released: known.filter((upload) => !uploads.some((kept) => kept.id === upload)) };
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
  now = Date.now(),
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
      // A draft saved again from the composer is a newer object than its video, which the bucket removes first.
      return draft && { draft, created: draft.created ?? uploaded.getTime() };
    }),
  );
  const drafts = found.filter((entry) => entry !== null);
  const taken = await posted(drafts.map(({ draft }) => draft.video));
  // A draft saved from the composer outlives its video in the bucket, so it leaves the list when the video goes.
  const expired = (draft: Draft) => draft.created !== undefined && draft.created + DRAFT_LIFETIME <= now;
  return drafts
    .filter(({ draft }) => !taken.has(draft.video) && !expired(draft))
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
