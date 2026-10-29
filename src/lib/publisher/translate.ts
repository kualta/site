import { parseTags, xiaohongshuTitleLength } from "./variants";

export const DEFAULT_MODEL = "anthropic/claude-sonnet-5.5";
const instructions = `You adapt social media posts for Xiaohongshu (RedNote). Reply with JSON only:
{"title": string, "text": string, "topics": string[]}

- Write natural Simplified Chinese the way Xiaohongshu creators write. Adapt, don't translate word for word.
- title: at most 20 Chinese characters (a Latin letter counts as half). Lead with the main keyword. At most one emoji.
- text: at most 1000 characters. Keep the meaning and tone. Short paragraphs. Put the main keyword in the first sentence.
- Never include links, phone numbers, email addresses, @handles, QR codes, or the names of other platforms
  (Instagram, TikTok, YouTube, X, Twitter, Bluesky). Avoid superlatives such as 最, 第一, 顶级, 唯一.
- topics: 3 to 5 short Chinese topic names people search on Xiaohongshu, without "#", most specific first.
- Keep names of people, places and brands recognisable; use the common Chinese name when one exists.`;

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

/** Drafts the Chinese title, text and topics with an LLM through OpenRouter. */
export async function translateForXiaohongshu(
  post: { title: string; text: string; tags: string[] },
  { apiKey, model = DEFAULT_MODEL, fetcher = fetch }: { apiKey: string; model?: string; fetcher?: typeof fetch },
): Promise<Chinese> {
  const response = await fetcher("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://post.kualta.dev",
      "X-Title": "kualta post",
    },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: instructions },
        { role: "user", content: JSON.stringify(post) },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Translation failed (${response.status})`);
  const content = ((await response.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message
    ?.content;
  let draft: Partial<Record<keyof Chinese, unknown>>;
  try {
    draft = JSON.parse(String(content).replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    throw new Error("The translation came back in an unexpected format. Try again.");
  }
  const text = typeof draft.text === "string" ? draft.text.trim() : "";
  const topics = Array.isArray(draft.topics) ? parseTags(draft.topics.join(" ")) : [];
  return {
    title: fitTitle(typeof draft.title === "string" ? draft.title.trim() : ""),
    text: [...text].slice(0, 1000).join(""),
    topics: topics.filter((topic) => [...topic].length <= 30).slice(0, 5),
  };
}
