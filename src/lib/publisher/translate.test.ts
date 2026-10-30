import { expect, test } from "bun:test";
import { DEFAULT_MODEL, translateForXiaohongshu } from "./translate";

/** Answers Messages API requests with this reply and records them. */
function anthropic(reply: { text?: string; stop_reason?: string; status?: number; message?: string }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    if (reply.status)
      return Response.json(
        { type: "error", error: { type: "invalid_request_error", message: reply.message } },
        { status: reply.status },
      );
    return Response.json({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: DEFAULT_MODEL,
      content: reply.text === undefined ? [] : [{ type: "text", text: reply.text }],
      stop_reason: reply.stop_reason ?? "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}
const post = { title: "Walk", text: "Sunday in Bogotá", tags: ["travel"] };

test("asks Claude for a Chinese title, text and topics", async () => {
  const { calls, fetcher } = anthropic({
    text: JSON.stringify({ title: "波哥大散步", text: "周末在波哥大。", topics: ["波哥大", "#旅行"] }),
  });
  const result = await translateForXiaohongshu(post, { apiKey: "key", fetcher });
  expect(result).toEqual({ title: "波哥大散步", text: "周末在波哥大。", topics: ["波哥大", "旅行"] });
  expect(calls).toHaveLength(1);
  expect(new URL(calls[0].url).pathname).toBe("/v1/messages");
  const headers = new Headers(calls[0].init.headers);
  expect(headers.get("x-api-key")).toBe("key");
  expect(headers.get("anthropic-beta")).toBe("server-side-fallback-2026-07-01");
  const body = JSON.parse(String(calls[0].init.body));
  expect(body.model).toBe(DEFAULT_MODEL);
  expect(body.fallbacks).toBe("default");
  expect(body.output_config.format.type).toBe("json_schema");
  expect(JSON.parse(body.messages[0].content)).toEqual(post);
});
test("keeps the draft inside Xiaohongshu's limits", async () => {
  const { fetcher } = anthropic({
    text: JSON.stringify({
      title: "界".repeat(25),
      text: "字".repeat(1200),
      topics: ["a1", "b2", "c3", "d4", "e5", "f6"],
    }),
  });
  const result = await translateForXiaohongshu(post, { apiKey: "key", fetcher });
  expect(result.title).toBe("界".repeat(20));
  expect([...result.text]).toHaveLength(900);
  expect(result.topics).toHaveLength(5);
});
test("a reply that isn't JSON is an error, not an empty draft", async () => {
  const { fetcher } = anthropic({ text: "Sorry, I can't help with that." });
  await expect(translateForXiaohongshu(post, { apiKey: "key", fetcher })).rejects.toThrow("unexpected format");
});
test("a refusal says so instead of reading its empty content", async () => {
  const { fetcher } = anthropic({ stop_reason: "refusal" });
  await expect(translateForXiaohongshu(post, { apiKey: "key", fetcher })).rejects.toThrow("declined");
});
test("API errors keep Anthropic's reason, such as spent credits", async () => {
  const { fetcher } = anthropic({ status: 400, message: "Your credit balance is too low" });
  await expect(translateForXiaohongshu(post, { apiKey: "key", fetcher })).rejects.toThrow(
    "Translation failed (400): Your credit balance is too low",
  );
});
