import Anthropic from "@anthropic-ai/sdk";
import { parseTags, xiaohongshuTitleLength } from "./variants";

export const DEFAULT_MODEL = "claude-opus-5-5";
const instructions = `You adapt social media posts for Xiaohongshu (RedNote). The post arrives as JSON with its title, text and tags.

- Write natural Simplified Chinese the way Xiaohongshu creators write. Adapt, don't translate word for word.
- title: at most 20 Chinese characters (a Latin letter counts as half). Lead with the main keyword. At most one emoji.
- text: at most 900 characters, leaving room for the topics. Keep the meaning and tone. Short paragraphs. Put the main keyword in the first sentence.
- Never include links, phone numbers, email addresses, @handles, QR codes, or the names of other platforms
  (Instagram, TikTok, YouTube, X, Twitter, Bluesky). Avoid superlatives such as 最, 第一, 顶级, 唯一.
- topics: 3 to 5 short Chinese topic names people search on Xiaohongshu, without "#", most specific first.
- Keep names of people, places and brands recognisable; use the common Chinese name when one exists.`;
const format = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      title: { type: "string" },
      text: { type: "string" },
      topics: { type: "array", items: { type: "string" } },
    },
    required: ["title", "text", "topics"],
    additionalProperties: false,
  },
} as const;

export interface Chinese {
  title: string;
  text: string;
  topics: string[];
}

/** Cuts a title to Xiaohongshu's 20 units without splitting a character. */
function fitTitle(title: string): string {
  let fitted = "";
  for (const char of title) {
    if (xiaohongshuTitleLength(fitted + char) > 20) break;
    fitted += char;
  }
  return fitted;
}

/** Drafts the Chinese title, text and topics with Claude, paid for by the Max plan's monthly API credits. */
export async function translateForXiaohongshu(
  post: { title: string; text: string; tags: string[] },
  { apiKey, model = DEFAULT_MODEL, fetcher }: { apiKey: string; model?: string; fetcher?: typeof fetch },
): Promise<Chinese> {
  const client = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 1, ...(fetcher ? { fetch: fetcher } : {}) });
  let message: Anthropic.Beta.BetaMessage;
  try {
    message = await client.beta.messages.create({
      model,
      max_tokens: 16_000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format },
      system: instructions,
      messages: [{ role: "user", content: JSON.stringify(post) }],
    });
  } catch (error) {
    if (error instanceof Anthropic.APIConnectionError) throw new Error("Could not reach Anthropic. Try again.");
    if (error instanceof Anthropic.APIError) {
      // Only the owner sees this, and a spent monthly credit or a rejected key should say so.
      const reason = (error.error as { error?: { message?: string } } | undefined)?.error?.message;
      throw new Error(`Translation failed (${error.status})${reason ? `: ${reason}` : ""}`);
    }
    throw error;
  }
  if (message.stop_reason === "refusal") throw new Error("Claude declined to translate this post.");
  const reply = message.content.find((block) => block.type === "text")?.text;
  let draft: Chinese;
  try {
    draft = JSON.parse(reply ?? "");
  } catch {
    throw new Error("The translation came back in an unexpected format. Try again.");
  }
  return {
    title: fitTitle(draft.title.trim()),
    text: [...draft.text.trim()].slice(0, 900).join(""),
    topics: parseTags(draft.topics.join(" "))
      .filter((topic) => [...topic].length <= 30)
      .slice(0, 5),
  };
}
