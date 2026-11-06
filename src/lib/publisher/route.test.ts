import { expect, test } from "bun:test";
import { previewSources, youtubeThumbnail } from "./preview";
import { defaultView, kindsOf, readPath, readView, tabPath, writeView } from "./route";

test("the path says which tab is open, on the publisher's own host and under /publish", () => {
  expect(readPath("/")).toEqual({ base: "", tab: "compose" });
  expect(readPath("/analytics")).toEqual({ base: "", tab: "analytics" });
  expect(readPath("/publish")).toEqual({ base: "/publish", tab: "compose" });
  expect(readPath("/publish/analytics/")).toEqual({ base: "/publish", tab: "analytics" });
  expect(tabPath("", "compose")).toBe("/");
  expect(tabPath("", "analytics")).toBe("/analytics");
  expect(tabPath("/publish", "compose")).toBe("/publish");
});
test("a plain view has a plain address, and every choice survives the round trip", () => {
  expect(readView("")).toEqual(defaultView);
  expect(writeView(defaultView)).toBe("");
  const view = {
    types: ["video" as const, "text" as const],
    period: 0,
    daily: true,
    before: "1730000000000:00000000-0000-4000-8000-000000000001",
    post: "00000000-0000-4000-8000-000000000002",
    platform: "tiktok",
    metric: "likes" as const,
  };
  const search = writeView(view);
  expect(search).toBe(
    "?post=00000000-0000-4000-8000-000000000002&platform=tiktok&metric=likes&period=all&chart=daily&type=video,text&before=1730000000000:00000000-0000-4000-8000-000000000001",
  );
  expect(readView(search)).toEqual(view);
});
test("an address with something unknown in it falls back to the default for that part", () => {
  const view = readView("?type=reels&period=12&metric=hearts&chart=pie");
  expect(view).toEqual(defaultView);
  // Kinds keep their own order whatever order they're written in.
  expect(readView("?type=text,video").types).toEqual(["video", "text"]);
  expect(kindsOf(["video", "photo"])).toEqual(["video", "mixed", "photo"]);
});
test("a post's picture comes from its cover, then YouTube, then its first upload", () => {
  const youtube = "https://www.youtube.com/shorts/CJs864wmjB0";
  expect(youtubeThumbnail(youtube)).toBe("https://i.ytimg.com/vi/CJs864wmjB0/hqdefault.jpg");
  expect(youtubeThumbnail("https://youtu.be/CJs864wmjB0")).toBe("https://i.ytimg.com/vi/CJs864wmjB0/hqdefault.jpg");
  expect(youtubeThumbnail("https://www.tiktok.com/@_/video/7702543685921066262")).toBeNull();
  expect(previewSources({ kind: "video", media: ["v"], cover: "c" }, [null, youtube])).toEqual([
    { src: "/api/publisher/media/c" },
    { src: "https://i.ytimg.com/vi/CJs864wmjB0/hqdefault.jpg" },
    { src: "/api/publisher/media/v#t=0.1", video: true },
  ]);
  expect(previewSources({ kind: "photo", media: ["p", "q"] }, [])).toEqual([{ src: "/api/publisher/media/p" }]);
  expect(previewSources({ kind: "mixed", media: ["v", "p"], mediaKinds: ["video", "photo"] }, [])).toEqual([
    { src: "/api/publisher/media/v#t=0.1", video: true },
  ]);
  expect(previewSources({ kind: "text", media: [] }, [])).toEqual([]);
});
