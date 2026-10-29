import { expect, test } from "bun:test";
import { defaultPreferences, parsePreferences, postKind, postLabel, unsupported, videoFormat } from "./presets";
test("default presets are destination sets with the owner's choices", () => {
  const prefs = defaultPreferences();
  expect(prefs.active).toBe("text");
  expect(Object.fromEntries(prefs.presets.map((p) => [p.name, p.platforms]))).toEqual({
    "Text post": ["bluesky", "twitter"],
    Photo: ["instagram", "grain"],
    "Long video": ["youtube"],
    "Short-form video": ["instagram", "youtube", "xiaohongshu", "tiktok", "twitter", "bluesky"],
  });
  for (const p of prefs.presets) {
    expect(p.metadata.twitter).toBe("remove-all");
    expect(p.metadata.xiaohongshu).toBe("remove-all");
  }
});
test("legacy built-in labels update without replacing saved choices or custom presets", () => {
  const stored = defaultPreferences();
  for (const p of stored.presets) {
    p.name = { photo: "Photo", text: "Text", video: "Video", short: "Short video" }[p.id]!;
    p.platforms = ["instagram", "twitter"];
    p.caption = "Saved caption";
    p.visibility = "UNLISTED";
    p.metadata.grain = "remove-all";
  }
  stored.presets.push({ ...stored.presets[0], id: "custom", name: "Video" });
  stored.presets.find((p) => p.id === "photo")!.name = "My photos";
  const parsed = parsePreferences(JSON.stringify(stored));
  expect(parsed.active).toBe("text");
  expect(parsed.presets.map((p) => p.name)).toEqual([
    "My photos", "Long video", "Text post", "Short-form video", "Video",
  ]);
  for (let i = 0; i < stored.presets.length; i++) {
    expect({ ...parsed.presets[i], name: stored.presets[i].name }).toEqual(stored.presets[i]);
  }
  expect(parsePreferences(JSON.stringify(parsed))).toEqual(parsed);
});
test("stored preferences round trip, drop unknown destinations and keep kind-era presets", () => {
  const prefs = defaultPreferences();
  prefs.active = "video";
  const stored = JSON.parse(JSON.stringify(prefs));
  const text = stored.presets.find((p: { id: string }) => p.id === "text");
  text.kind = "text";
  text.platforms.push("grain", "bogus");
  const parsed = parsePreferences(JSON.stringify(stored));
  expect(parsed.active).toBe("video");
  expect(parsed.presets.find((p) => p.id === "text")?.platforms).toEqual(["grain", "bluesky", "twitter"]);
  expect(parsed.presets.find((p) => p.id === "text")).not.toHaveProperty("kind");
  expect(parsePreferences("not json")).toEqual(defaultPreferences());
  expect(parsePreferences('{"version":1,"presets":[]}')).toEqual(defaultPreferences());
});
test("attachments decide the kind", () => {
  expect(postKind([])).toBe("text");
  expect(postKind([{ type: "image/jpeg" }, { type: "image/png" }])).toBe("photo");
  expect(postKind([{ type: "video/mp4" }])).toBe("video");
});
test("each destination says why it can't take a post", () => {
  expect(unsupported("bluesky", "text", 0)).toBeNull();
  expect(unsupported("grain", "text", 0)).toBe("needs photos");
  expect(unsupported("instagram", "text", 0)).toBe("needs media");
  expect(unsupported("youtube", "photo", 2)).toBe("needs a video");
  expect(unsupported("grain", "video", 1)).toBe("needs photos");
  expect(unsupported("twitter", "photo", 4)).toBeNull();
  expect(unsupported("twitter", "photo", 5)).toBe("takes up to 4 photos");
  expect(unsupported("bluesky", "video", 1, 180)).toBeNull();
  expect(unsupported("bluesky", "video", 1, 181)).toBe("takes videos up to 3 minutes");
  expect(unsupported("bluesky", "video", 1)).toBeNull();
});
test("text posts are listed by their first line", () => {
  expect(postLabel({ title: "", caption: "First line\nsecond" })).toBe("First line");
  expect(postLabel({ title: "A title", caption: "Body" })).toBe("A title");
});
test("videos are named reels on Instagram and Shorts on YouTube when vertical and up to 3 minutes", () => {
  expect(videoFormat("instagram")).toBe("Reel");
  expect(videoFormat("youtube", { seconds: 180, width: 1080, height: 1920 })).toBe("Short");
  expect(videoFormat("youtube", { seconds: 30, width: 1080, height: 1080 })).toBe("Short");
  expect(videoFormat("youtube", { seconds: 181, width: 1080, height: 1920 })).toBeNull();
  expect(videoFormat("youtube", { seconds: 30, width: 1920, height: 1080 })).toBeNull();
  expect(videoFormat("youtube")).toBeNull();
  expect(videoFormat("tiktok", { seconds: 30, width: 1080, height: 1920 })).toBeNull();
});
test("photos and videos together go only where they can be mixed", () => {
  const file = (type: string) => ({ type });
  expect(postKind([file("image/png"), file("video/mp4")])).toBe("mixed");
  expect(postKind([file("video/mp4"), file("video/mp4")])).toBe("mixed");
  expect(postKind([file("video/mp4")])).toBe("video");
  expect(unsupported("instagram", "mixed", 10)).toBeNull();
  expect(unsupported("twitter", "mixed", 4)).toBeNull();
  expect(unsupported("twitter", "mixed", 5)).toBe("takes up to 4 photos and videos");
  expect(unsupported("bluesky", "mixed", 2)).toBe("takes photos or one video");
  expect(unsupported("grain", "mixed", 2)).toBe("takes only photos");
  expect(unsupported("youtube", "mixed", 2)).toBe("takes one video");
});
