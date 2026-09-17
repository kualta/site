import { expect, test } from "bun:test";
import { getBlueskyMedia } from "./bluesky-media";

const image = {
  $type: "app.bsky.embed.images#view",
  images: [{ fullsize: "https://cdn.bsky.app/full.jpg", thumb: "https://cdn.bsky.app/thumb.jpg", alt: "A bird" }],
};
const video = {
  $type: "app.bsky.embed.video#view",
  playlist: "https://video.bsky.app/playlist.m3u8",
  alt: "Bird in flight",
};

test("uses full-size images and preserves alt text", () => {
  expect(getBlueskyMedia(image)).toEqual([
    {
      kind: "image",
      width: 640,
      height: 480,
      src: "https://cdn.bsky.app/full.jpg",
      thumbnail: "https://cdn.bsky.app/thumb.jpg",
      alt: "A bird",
    },
  ]);
});

test("asks the Bluesky CDN for the JPEG rendition of full-size images", () => {
  const cdn = "https://cdn.bsky.app/img";
  const did = "did:plc:jhvnnnd3adml7t6anu3ay7ip";
  const imageAt = (fullsize: string) =>
    getBlueskyMedia({ ...image, images: [{ ...image.images[0], fullsize, thumb: `${cdn}/feed_thumbnail/plain/${did}/cid` }] })[0];

  expect(imageAt(`${cdn}/feed_fullsize/plain/${did}/cid`)).toMatchObject({
    src: `${cdn}/feed_fullsize/plain/${did}/cid@jpeg`,
    thumbnail: `${cdn}/feed_thumbnail/plain/${did}/cid`,
  });
  expect(imageAt(`${cdn}/feed_fullsize/plain/${did}/cid@webp`).src).toBe(`${cdn}/feed_fullsize/plain/${did}/cid@jpeg`);
  expect(imageAt(`${cdn}/feed_fullsize/plain/${did}/cid@jpeg`).src).toBe(`${cdn}/feed_fullsize/plain/${did}/cid@jpeg`);
});

test("retains video streams without requiring a thumbnail", () => {
  expect(getBlueskyMedia(video)[0]).toMatchObject({ kind: "video", src: video.playlist });
});

test("follows media then quoted-post order", () => {
  expect(
    getBlueskyMedia({
      $type: "app.bsky.embed.recordWithMedia#view",
      media: video,
      record: { $type: "app.bsky.embed.record#view", record: { embeds: [image] } },
    }).map((item) => item.kind),
  ).toEqual(["video", "image"]);
});

test("ignores external previews and unsafe media URLs", () => {
  expect(getBlueskyMedia({ $type: "app.bsky.embed.external#view", external: image })).toEqual([]);
  expect(getBlueskyMedia({ ...video, playlist: "javascript:alert(1)" })).toEqual([]);
  expect(getBlueskyMedia(undefined)).toEqual([]);
});

test("reserves video aspect ratio before stream metadata loads", () => {
  expect(getBlueskyMedia({ ...video, aspectRatio: { width: 1080, height: 1920 } })[0]).toMatchObject({
    width: 1080,
    height: 1920,
  });
  expect(getBlueskyMedia(video)[0]).toMatchObject({ width: 16, height: 9 });
});
