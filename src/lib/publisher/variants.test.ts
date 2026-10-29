import { expect, test } from "bun:test";
import { parseTags, renderVariant, xiaohongshuTitleLength, xLength } from "./variants";

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
  expect(renderVariant("grain", post).text).toBe("Sunday walk\n\n#a1 #b2 #c3 #d4 #e5 #f6");
  expect(renderVariant("bluesky", post)).toEqual({
    title: "",
    text: "Sunday walk\n\n#a1 #b2",
    tags: ["c3", "d4", "e5", "f6"],
  });
});
test("X and Bluesky use the short version, and drop tags that don't fit", () => {
  const long = "x".repeat(275);
  expect(renderVariant("twitter", { title: "", caption: long, tags: ["travel"] }).text).toBe(long);
  expect(
    renderVariant("twitter", { title: "", caption: "y".repeat(500), short: "Short one", tags: ["travel"] }).text,
  ).toBe("Short one\n\n#travel");
  expect(renderVariant("instagram", { title: "", caption: "Long", short: "Short" }).text).toBe("Long");
});
