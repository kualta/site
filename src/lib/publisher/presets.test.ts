import { expect, test } from "bun:test";
import { defaultPreferences, parsePreferences } from "./presets";
test("photo and video destinations match the owner's defaults", () => {
  const prefs = defaultPreferences();
  expect(prefs.presets[0].platforms).toEqual(["instagram", "grain"]);
  expect(prefs.presets[1].platforms).toEqual(["youtube", "xiaohongshu", "tiktok", "twitter", "bluesky"]);
  for (const p of prefs.presets) {
    expect(p.metadata.twitter).toBe("remove-all");
    expect(p.metadata.xiaohongshu).toBe("remove-all");
  }
});
test("stored preferences round trip and exclude unsupported destinations", () => {
  const prefs = defaultPreferences();
  prefs.active = "video";
  prefs.presets[1].platforms.push("grain");
  const parsed = parsePreferences(JSON.stringify(prefs));
  expect(parsed.active).toBe("video");
  expect(parsed.presets[1].platforms).not.toContain("grain");
  expect(parsePreferences("not json")).toEqual(defaultPreferences());
  expect(parsePreferences('{"version":1,"presets":[]}')).toEqual(defaultPreferences());
});
