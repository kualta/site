import { defaultMetadata, platforms, support } from "./presets";
import { PostError, validatePost, type MediaBucket } from "./server";

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
  zh?: { title: string; text: string; topics: string[] };
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
  };
}

/** Lets the terminal find out what to fix in the text before it uploads the video. */
export function checkDraftText(value: unknown): void {
  validateDraft({ ...(value as object), video: crypto.randomUUID() });
}

export async function saveDraft(bucket: Pick<MediaBucket, "head" | "put">, value: unknown): Promise<string> {
  const draft = validateDraft(value);
  if (!(await bucket.head(draft.video))) throw new PostError("The draft's video is missing");
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
