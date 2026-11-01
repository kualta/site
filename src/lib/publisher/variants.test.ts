import { expect, test } from "bun:test";
import { parseTags, problem, renderVariant, usage, xiaohongshuTitleLength, xLength } from "./variants";

test("only Xiaohongshu's version carries the Chinese video", () => {
  const post = {
    title: "A film",
    caption: "About films",
    zh: { title: "短片", text: "正文", topics: ["短片"], video: "chinese" },
  };
  expect(renderVariant("xiaohongshu", post).video).toBe("chinese");
  expect(renderVariant("youtube", post)).not.toHaveProperty("video");
  expect(renderVariant("xiaohongshu", { ...post, zh: { ...post.zh, video: undefined } })).not.toHaveProperty("video");
});
test("tags are parsed from free text, without # and duplicates", () => {
  expect(parseTags("#Travel bogotá, 生活美学 #travel 2026 #a-b")).toEqual(["Travel", "bogotá", "生活美学"]);
});
test("X counts Chinese and emoji as two and links as 23", () => {
  expect(xLength("hello")).toBe(5);
  expect(xLength("你好")).toBe(4);
  expect(xLength("hi 👋🏽")).toBe(5);
  expect(xLength("see https://kualta.dev/a/very/long/path")).toBe(27);
});
test("Xiaohongshu titles count Chinese as one and ASCII as half", () => {
  expect(xiaohongshuTitleLength("多Agent长跑怎么做？")).toBe(10);
  expect(xiaohongshuTitleLength("a".repeat(40))).toBe(20);
});
test("each platform takes its own number of tags", () => {
  const post = { title: "Walk", caption: "Sunday walk", tags: ["a1", "b2", "c3", "d4", "e5", "f6"] };
  expect(renderVariant("youtube", post)).toEqual({ title: "Walk", text: "Sunday walk\n\n#a1 #b2 #c3", tags: [] });
  expect(renderVariant("tiktok", post).text).toBe("Sunday walk\n\n#a1 #b2 #c3 #d4 #e5");
  expect(renderVariant("grain", post).text).toBe("Sunday walk");
  expect(renderVariant("twitter", post).text).toBe("Sunday walk");
  expect(renderVariant("bluesky", post)).toEqual({
    title: "",
    text: "Sunday walk",
    tags: ["a1", "b2", "c3", "d4", "e5", "f6"],
  });
});
test("X and Bluesky use the short version", () => {
  expect(
    renderVariant("twitter", { title: "", caption: "y".repeat(500), short: "Short one", tags: ["travel"] }).text,
  ).toBe("Short one");
  expect(renderVariant("instagram", { title: "", caption: "Long", short: "Short" }).text).toBe("Long");
});
test("Xiaohongshu counts its topics toward the text limit", () => {
  const post = { title: "", caption: "", zh: { title: "标题", text: "字".repeat(990), topics: ["旅行", "城市漫步"] } };
  const variant = renderVariant("xiaohongshu", post);
  expect(usage("xiaohongshu", variant)[1].used).toBe(990 + 1 + 4 + 6);
  expect(problem("xiaohongshu", variant)).toBe("text is 1001/1000");
});
