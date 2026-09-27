import { Agent, RichText } from "@atproto/api";

export function postText(text: string): RichText {
  const richText = new RichText({ text: text.trim() });
  if (!richText.text || richText.graphemeLength > 300) throw new Error("Write a post of 1–300 characters.");
  if (new TextEncoder().encode(richText.text).length > 3000) throw new Error("Please shorten this post.");
  return richText;
}

export async function publishProfilePost(agent: Agent, text: string) {
  const richText = postText(text);
  await richText.detectFacets(new Agent({ service: "https://public.api.bsky.app" }));
  return agent.post({ text: richText.text, facets: richText.facets });
}
