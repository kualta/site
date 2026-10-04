import { uploadMedia, type ComposerAttachment } from "./media";
import { Agent, RichText } from "@atproto/api";

export function postText(text: string, hasImages = false): RichText {
  const richText = new RichText({ text: text.trim() });
  if ((!richText.text && !hasImages) || richText.graphemeLength > 300)
    throw new Error("Write a post of 1–300 characters.");
  if (new TextEncoder().encode(richText.text).length > 3000) throw new Error("Please shorten this post.");
  return richText;
}

export async function publishProfilePost(agent: Agent, text: string, images: ComposerAttachment[] = []) {
  const richText = postText(text, images.length > 0);
  await richText.detectFacets(new Agent({ service: "https://public.api.bsky.app" }));
  const embed = await uploadMedia(agent, images);
  const record = {
    $type: "app.bsky.feed.post" as const,
    text: richText.text,
    facets: richText.facets,
    createdAt: new Date().toISOString(),
    ...(embed ? { embed } : {}),
  };
  const result = await agent.post(record);
  return { ...result, record };
}
