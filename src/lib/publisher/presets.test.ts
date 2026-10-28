import { expect, test } from "bun:test";
import { defaultPreferences, kinds, mediaKind, parsePreferences, postLabel } from "./presets";
test("each content tab has a preset with the owner's default destinations", () => {
  const prefs = defaultPreferences();
  expect(prefs.presets.map((p) => p.kind)).toEqual([...kinds]);
  const destinations = Object.fromEntries(prefs.presets.map((p) => [p.kind, p.platforms]));
  expect(destinations).toEqual({
    text: ["bluesky", "twitter"],
    photo: ["instagram", "grain"],
    video: ["youtube"],
    short: ["youtube", "xiaohongshu", "tiktok", "twitter", "bluesky"],
  });
  for (const p of prefs.presets) {
    expect(p.metadata.twitter).toBe("remove-all");
    expect(p.metadata.xiaohongshu).toBe("remove-all");
  }
});
test("stored preferences round trip and exclude unsupported destinations", () => {
  const prefs = defaultPreferences();
  prefs.active = "video";
  prefs.presets[2].platforms.push("grain");
  prefs.presets[0].platforms.push("instagram");
  const parsed = parsePreferences(JSON.stringify(prefs));
  expect(parsed.active).toBe("video");
  expect(parsed.presets[2].platforms).not.toContain("grain");
  expect(parsed.presets[0].platforms).toEqual(["bluesky", "twitter"]);
  expect(parsePreferences("not json")).toEqual(defaultPreferences());
  expect(parsePreferences('{"version":1,"presets":[]}')).toEqual(defaultPreferences());
});
test("preferences saved before text and short video gain those tabs", () => {
  const saved = defaultPreferences();
  saved.presets = saved.presets.filter((p) => p.kind === "photo" || p.kind === "video");
  saved.presets[1].platforms = ["tiktok"];
  const parsed = parsePreferences(JSON.stringify(saved));
  expect(parsed.presets.map((p) => p.kind)).toEqual(["photo", "video", "text", "short"]);
  expect(parsed.presets[1].platforms).toEqual(["tiktok"]);
});
test("short video uploads are videos and text posts have no media", () => {
  expect(mediaKind("short")).toBe("video");
  expect(mediaKind("photo")).toBe("photo");
  expect(mediaKind("text")).toBeNull();
});
test("text posts are listed by their first line", () => {
  expect(postLabel({ title: "", caption: "First line\nsecond" })).toBe("First line");
  expect(postLabel({ title: "A title", caption: "Body" })).toBe("A title");
});
