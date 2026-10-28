import { expect, test } from "bun:test";
import { defaultPreferences, parsePreferences, postKind, postLabel, unsupported } from "./presets";
test("default presets are destination sets with the owner's choices", () => {
  const prefs = defaultPreferences();
  expect(prefs.active).toBe("text");
  expect(Object.fromEntries(prefs.presets.map((p) => [p.name, p.platforms]))).toEqual({
    Text: ["bluesky", "twitter"],
    Photo: ["instagram", "grain"],
    Video: ["youtube"],
    "Short video": ["youtube", "xiaohongshu", "tiktok", "twitter", "bluesky"],
  });
  for (const p of prefs.presets) {
    expect(p.metadata.twitter).toBe("remove-all");
    expect(p.metadata.xiaohongshu).toBe("remove-all");
  }
});
test("stored preferences round trip, drop unknown destinations and keep kind-era presets", () => {
  const prefs = defaultPreferences();
  prefs.active = "video";
  const stored = JSON.parse(JSON.stringify(prefs));
  stored.presets[0].kind = "text";
  stored.presets[0].platforms.push("grain", "bogus");
  const parsed = parsePreferences(JSON.stringify(stored));
  expect(parsed.active).toBe("video");
  expect(parsed.presets[0].platforms).toEqual(["grain", "bluesky", "twitter"]);
  expect(parsed.presets[0]).not.toHaveProperty("kind");
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
