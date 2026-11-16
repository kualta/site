import { asRecord } from "../activity/validation";

/**
 * Pinkleap (formerly Pinksky) posts a story as an ordinary Bluesky post carrying one of these tags, and finds stories
 * by searching for them. They aren't shown in the post's text.
 */
export const STORY_TAGS = ["pinkleapStory", "pinkskyStory"];

/** Whether a post record is a story rather than a post: stories stay out of feeds and video lists. */
export function isStoryRecord(record: unknown): boolean {
  const tags = asRecord(record)?.tags;
  return Array.isArray(tags) && tags.some((tag) => typeof tag === "string" && STORY_TAGS.includes(tag));
}
