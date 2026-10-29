import { expect, test } from "bun:test";
import { DEFAULT_MODEL, translateForXiaohongshu } from "./translate";

function openRouter(content: string) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Response.json({ choices: [{ message: { content } }] });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

test("asks OpenRouter for a Chinese title, text and topics", async () => {
  const { calls, fetcher } = openRouter(
    JSON.stringify({ title: "波哥大散步", text: "周末在波哥大。", topics: ["波哥大", "#旅行"] }),
  );
  const result = await translateForXiaohongshu(
    { title: "Walk", text: "Sunday in Bogotá", tags: ["travel"] },
    { apiKey: "key", fetcher },
  );
  expect(result).toEqual({ title: "波哥大散步", text: "周末在波哥大。", topics: ["波哥大", "旅行"] });
  expect(calls[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
  expect(new Headers(calls[0].init.headers).get("Authorization")).toBe("Bearer key");
  const body = JSON.parse(String(calls[0].init.body));
  expect(body.model).toBe(DEFAULT_MODEL);
  expect(JSON.parse(body.messages[1].content)).toEqual({ title: "Walk", text: "Sunday in Bogotá", tags: ["travel"] });
});
test("keeps the draft inside Xiaohongshu's limits", async () => {
  const { fetcher } = openRouter(
    "```json\n" +
      JSON.stringify({
        title: "界".repeat(25),
        text: "字".repeat(1200),
        topics: ["a1", "b2", "c3", "d4", "e5", "f6"],
      }) +
      "\n```",
  );
  const result = await translateForXiaohongshu({ title: "", text: "x", tags: [] }, { apiKey: "key", fetcher });
  expect(result.title).toBe("界".repeat(20));
  expect([...result.text]).toHaveLength(900);
  expect(result.topics).toHaveLength(5);
});
test("a reply that isn't JSON is an error, not an empty draft", async () => {
  const { fetcher } = openRouter("Sorry, I can't help with that.");
  await expect(translateForXiaohongshu({ title: "", text: "x", tags: [] }, { apiKey: "key", fetcher })).rejects.toThrow(
    "unexpected format",
  );
});
