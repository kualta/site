import { test } from "node:test";
import assert from "node:assert/strict";
import { syncMusicArtwork } from "./music-artwork.mjs";

const did = "did:plc:artist";
function fixture() {
  const item = { slug: "song", artwork: Buffer.from("cover"), record: { description: "https://site/music/song/\n\nCredits" } };
  const track = { id: 1, description: item.record.description, atproto_record_uri: `at://${did}/fm.plyr.track/abc`, image_url: null };
  let uploads = 0;
  let identity = did;
  const fetcher = async (url, options = {}) => {
    if (url.endsWith("/auth/me")) return Response.json({ did: identity });
    if (url.includes("/tracks/?")) return Response.json({ tracks: [track], has_more: false });
    if (options.method === "PATCH") {
      assert.equal(options.headers.Authorization, "Bearer test-token");
      assert.equal(await options.body.get("image").text(), "cover");
      uploads++;
      track.image_url = "https://images.plyr.fm/cover.jpg";
    }
    if (url.endsWith("/tracks/1")) return Response.json(track);
    if (url === track.image_url) return new Response(item.artwork);
    throw new Error(`Unexpected URL: ${url}`);
  };
  return { item, track, fetcher, uploads: () => uploads, wrongIdentity: () => { identity = "did:plc:other"; } };
}
test("artwork uploads missing covers and skips byte-identical images on reruns", async () => {
  const f = fixture();
  const options = { token: "test-token", fetcher: f.fetcher, log() {} };
  await syncMusicArtwork([f.item], did, options);
  assert.equal(f.item.record.imageUrl, f.track.image_url);
  await syncMusicArtwork([f.item], did, options);
  assert.equal(f.uploads(), 1);
  await syncMusicArtwork([f.item], did, { ...options, token: undefined, verifyOnly: true });
  assert.equal(f.uploads(), 1);
});
test("artwork verification and wrong identity cannot upload", async () => {
  const f = fixture();
  await assert.rejects(syncMusicArtwork([f.item], did, { verifyOnly: true, fetcher: f.fetcher }), /artwork differs/);
  f.wrongIdentity();
  await assert.rejects(syncMusicArtwork([f.item], did, { token: "test-token", fetcher: f.fetcher }), /identity mismatch/);
  assert.equal(f.uploads(), 0);
});
test("changed artwork replaces the CDN image", async () => {
  const f = fixture();
  f.track.image_url = "https://images.plyr.fm/old.jpg";
  const fetcher = (url, options) => url.endsWith("/old.jpg") ? Promise.resolve(new Response("old cover")) : f.fetcher(url, options);
  await syncMusicArtwork([f.item], did, { token: "test-token", fetcher, log() {} });
  assert.equal(f.uploads(), 1);
});
