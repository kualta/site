import type { Post as BlueskyPostView } from "@astro-community/astro-embed-bluesky";
import {
  AppBskyEmbedExternal,
  AppBskyEmbedImages,
  AppBskyEmbedRecord,
  AppBskyEmbedRecordWithMedia,
  AppBskyEmbedVideo,
  AppBskyFeedDefs,
  AppBskyFeedPost,
  AppBskyGraphDefs,
} from "@atcute/bluesky";
import { is } from "@atcute/lexicons";
import { asRecord } from "./validation";

const MAX_SERIALIZED_POST_LENGTH = 512 * 1024;
const OMITTED_VIEW_FIELDS = new Set([
  "associated",
  "bookmarkCount",
  "debug",
  "likeCount",
  "pronouns",
  "quoteCount",
  "replyCount",
  "repostCount",
  "status",
  "threadgate",
  "verification",
  "viewer",
]);

export function sanitizeBlueskyPostView(value: unknown): BlueskyPostView | undefined {
  if (!is(AppBskyFeedDefs.postViewSchema, value)) return undefined;
  if (!is(AppBskyFeedPost.mainSchema, value.record)) return undefined;

  let serialized: string;
  try {
    serialized = JSON.stringify(value, (key, nestedValue) => (OMITTED_VIEW_FIELDS.has(key) ? undefined : nestedValue));
  } catch {
    return undefined;
  }

  if (!serialized || serialized.length > MAX_SERIALIZED_POST_LENGTH) return undefined;

  const sanitized: unknown = JSON.parse(serialized);
  if (!is(AppBskyFeedDefs.postViewSchema, sanitized)) return undefined;
  if (!is(AppBskyFeedPost.mainSchema, sanitized.record)) return undefined;

  return sanitized as BlueskyPostView;
}

function hasModerationLabel(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.some((item) => hasModerationLabel(item, seen));
  }

  const record = asRecord(value);
  if (!record) return false;

  const labels = record.labels;
  if (Array.isArray(labels)) {
    const hasActiveLabel = labels.some((label) => {
      const candidate = asRecord(label);
      return typeof candidate?.val === "string" && candidate.neg !== true;
    });
    if (hasActiveLabel) return true;
  } else {
    const selfLabels = asRecord(labels)?.values;
    if (Array.isArray(selfLabels) && selfLabels.length > 0) return true;
  }

  return Object.values(record).some((nestedValue) => hasModerationLabel(nestedValue, seen));
}

function isSupportedMediaEmbed(value: unknown): boolean {
  return (
    is(AppBskyEmbedExternal.viewSchema, value) ||
    is(AppBskyEmbedImages.viewSchema, value) ||
    is(AppBskyEmbedVideo.viewSchema, value)
  );
}

function isSupportedQuotedRecord(value: unknown): boolean {
  if (is(AppBskyGraphDefs.listViewSchema, value) || is(AppBskyGraphDefs.starterPackViewBasicSchema, value)) {
    return true;
  }

  if (!is(AppBskyEmbedRecord.viewRecordSchema, value)) return false;
  if (!is(AppBskyFeedPost.mainSchema, value.value)) return false;

  const nestedEmbed = value.embeds?.[0];
  if (!nestedEmbed) return true;
  if (isSupportedMediaEmbed(nestedEmbed)) return true;

  return is(AppBskyEmbedRecordWithMedia.viewSchema, nestedEmbed) && isSupportedMediaEmbed(nestedEmbed.media);
}

function isSupportedEmbed(value: unknown): boolean {
  if (value === undefined) return true;
  if (isSupportedMediaEmbed(value)) return true;

  if (is(AppBskyEmbedRecord.viewSchema, value)) {
    return isSupportedQuotedRecord(value.record);
  }

  return (
    is(AppBskyEmbedRecordWithMedia.viewSchema, value) &&
    isSupportedMediaEmbed(value.media) &&
    isSupportedQuotedRecord(value.record.record)
  );
}

export function canRenderBlueskyPost(post: BlueskyPostView): boolean {
  return !hasModerationLabel(post) && isSupportedEmbed(post.embed);
}
