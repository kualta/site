import { expect, test } from "bun:test";
import { postKey, publicationLink } from "./links";

test("a pasted link names its platform and keeps the shape the helper reads it by", () => {
  const cases: [string, string, string][] = [
    [
      "https://www.tiktok.com/@kualtq/video/7710000000000000001?is_from_webapp=1&sender_device=pc",
      "tiktok",
      "https://www.tiktok.com/@kualtq/video/7710000000000000001",
    ],
    [
      "https://tiktok.com/@kualtq/photo/7710000000000000002/",
      "tiktok",
      "https://www.tiktok.com/@kualtq/photo/7710000000000000002",
    ],
    ["https://youtube.com/shorts/-rUzAfPDlRQ?si=abc", "youtube", "https://www.youtube.com/shorts/-rUzAfPDlRQ"],
    ["https://youtu.be/dQw4w9WgXcQ?t=3", "youtube", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
    [
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share",
      "youtube",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    ],
    [
      "https://www.instagram.com/kualta/reel/DfDQW2Ry8cO/?igsh=x",
      "instagram",
      "https://www.instagram.com/reel/DfDQW2Ry8cO/",
    ],
    ["https://instagram.com/reels/DfDQW2Ry8cO", "instagram", "https://www.instagram.com/reel/DfDQW2Ry8cO/"],
    ["https://www.instagram.com/p/DfDQW2Ry8cO/", "instagram", "https://www.instagram.com/p/DfDQW2Ry8cO/"],
    [
      "https://twitter.com/kualts/status/2115531469733208512/video/1?s=20",
      "twitter",
      "https://x.com/kualts/status/2115531469733208512",
    ],
    [
      "https://www.xiaohongshu.com/discovery/item/6ae261940000000013033800?xsec_token=t",
      "xiaohongshu",
      "https://www.xiaohongshu.com/explore/6ae261940000000013033800",
    ],
    [
      "https://www.rednote.com/explore/6ae261940000000013033800",
      "xiaohongshu",
      "https://www.rednote.com/explore/6ae261940000000013033800",
    ],
    ["https://warpcast.com/kualta/0x1a2b3c4d", "farcaster", "https://farcaster.xyz/kualta/0x1a2b3c4d"],
    ["https://hey.xyz/posts/2fzv049ksgkqd0032mr", "lens", "https://hey.xyz/posts/2fzv049ksgkqd0032mr"],
  ];
  for (const [input, platform, url] of cases) expect(publicationLink(input)).toEqual({ platform, url } as never);
});
test("a link that can't be read says what to paste instead", () => {
  expect(publicationLink("tiktok.com/@a/video/1")).toEqual({
    error: "Paste the post's full link, starting with https://",
  });
  expect(publicationLink("https://vm.tiktok.com/ZMabc/")).toMatchObject({
    platform: "tiktok",
    error: expect.stringContaining("tiktok.com/@name/video/"),
  });
  expect(publicationLink("https://www.tiktok.com/@kualtq")).toMatchObject({ platform: "tiktok" });
  expect(publicationLink("https://bsky.app/profile/a/post/b")).toEqual({
    error: "Paste a link to a post on TikTok, YouTube, Instagram, X / Twitter, Xiaohongshu, Farcaster or Lens",
  });
  expect(publicationLink("http://www.tiktok.com/@a/video/1")).toMatchObject({
    error: expect.stringContaining("Paste a link"),
  });
});
test("two links lead to the same post when they name it the same way", () => {
  expect(postKey("https://www.tiktok.com/@_/video/7702543685921066262")).toBe(
    postKey("https://www.tiktok.com/@kualtq/video/7702543685921066262"),
  );
  expect(postKey("https://www.youtube.com/watch?v=-rUzAfPDlRQ")).toBe(
    postKey("https://www.youtube.com/shorts/-rUzAfPDlRQ"),
  );
  expect(postKey("https://www.instagram.com/reel/DfDQW2Ry8cO/")).toBe("DfDQW2Ry8cO");
});
