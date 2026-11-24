import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordKey } from "./atproto-content.mjs";
import { coverBlob } from "./atproto-publish.mjs";
import { ownLexicons, validateRecord } from "./atproto-validation.mjs";
import { companionUri, prepareCompanions, publishCompanions } from "./music-companion.mjs";
import { prepareMusic } from "./music-publish.mjs";

const did = "did:plc:jhvnnnd3adml7t6anu3ay7ip";
const quiet = { log() {} };
const cidOf = async (text) => (await coverBlob({ base64: Buffer.from(text).toString("base64") })).ref.$link;
const trackCids = await Promise.all(["track 0", "track 1", "track 2", "track new"].map(cidOf));
const base = { artist: "kualta", kind: "original", originalArtist: null, date: "2026-09-01", duration: 5 };
const sung = {
  ...base,
  slug: "sung",
  title: "Sung",
  kind: "cover",
  originalArtist: "Original artist",
  src: "/music/sung.mp3",
  cover: "/music/sung.jpg",
  lyrics: "[00:01.00]first line\n[00:02.50]second line",
  score: null,
};
const scored = {
  ...base,
  slug: "scored",
  title: "Scored",
  src: "/music/scored.mp3",
  cover: "/music/scored.jpg",
  lyrics: null,
  score: "/music/scores/scored.mxl",
};
const bare = {
  ...base,
  slug: "bare",
  title: "Bare",
  src: "/music/bare.mp3",
  cover: "/music/bare.jpg",
  lyrics: null,
  score: null,
};

async function fixture(fn, tracks = [sung, scored, bare]) {
  const root = await mkdtemp(join(tmpdir(), "music-companion-"));
  try {
    await mkdir(join(root, "music/scores"), { recursive: true });
    for (const track of [sung, scored, bare]) {
      await writeFile(join(root, `music/${track.slug}.mp3`), `audio ${track.slug}`);
      await writeFile(join(root, `music/${track.slug}.jpg`), "art");
    }
    await writeFile(join(root, "music/scores/scored.mxl"), "PK score");
    const items = await prepareMusic(tracks, "https://kualta.dev", root);
    await fn({ items, companions: await prepareCompanions(tracks, did, root), root, tracks });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function fakeAgent(items, { storedMimeType } = {}) {
  const collections = {
    "fm.plyr.track": items.map((item, index) => ({
      uri: `at://${did}/fm.plyr.track/3m2abcdefghi${index}a`,
      cid: trackCids[index],
      value: structuredClone(item.record),
    })),
    "dev.kualta.track": [],
  };
  const calls = { puts: [], uploads: [] };
  const repo = {
    async listRecords({ collection }) {
      return { data: { records: structuredClone(collections[collection]) } };
    },
    async uploadBlob(bytes, { encoding }) {
      calls.uploads.push(encoding);
      const blob = await coverBlob({ base64: Buffer.from(bytes).toString("base64"), mimeType: encoding });
      return { data: { blob: { ...blob, mimeType: storedMimeType ?? encoding } } };
    },
    async putRecord({ collection, rkey, record, swapRecord }) {
      const uri = `at://${did}/${collection}/${rkey}`;
      const index = collections[collection].findIndex((entry) => entry.uri === uri);
      expect(swapRecord).toBe(index < 0 ? null : collections[collection][index].cid);
      const entry = { uri, cid: await cidOf(`put ${calls.puts.length}`), value: structuredClone(record) };
      if (index < 0) collections[collection].push(entry);
      else collections[collection][index] = entry;
      calls.puts.push(uri);
      return { data: { uri } };
    },
    async getRecord({ collection, rkey }) {
      const entry = collections[collection].find((item) => item.uri === `at://${did}/${collection}/${rkey}`);
      return { data: { value: structuredClone(entry.value) } };
    },
  };
  return { did, com: { atproto: { repo } }, collections, calls };
}

describe("track companions", () => {
  test("the lexicon parses through the shared validation path and its schema is published", () => {
    expect(ownLexicons().map((lexicon) => lexicon.id)).toContain("dev.kualta.track");
    const track = { uri: `at://${did}/fm.plyr.track/3m2abcdefghijk`, cid: trackCids[0] };
    expect(() => validateRecord({ $type: "dev.kualta.track", track })).not.toThrow();
    expect(() => validateRecord({ $type: "dev.kualta.track" })).toThrow();
    expect(() => validateRecord({ $type: "dev.kualta.track", track, lyrics: { format: "lrc" } })).toThrow();
    expect(() =>
      validateRecord({ $type: "dev.kualta.track", track, lyrics: { format: "lrc", text: "x".repeat(100_001) } }),
    ).toThrow();
  });

  test("builds one record per track with lyrics or a score, keyed by slug", () =>
    fixture(({ companions }) => {
      expect(companions.map((companion) => companion.slug)).toEqual(["sung", "scored"]);
      const [lyrics, score] = companions;
      expect(lyrics.uri).toBe(`at://${did}/dev.kualta.track/${recordKey("dev.kualta.track:sung")}`);
      expect(lyrics.uri).toBe(companionUri(did, "sung"));
      expect(lyrics.uri).not.toBe(score.uri);
      expect(lyrics.record).toEqual({
        $type: "dev.kualta.track",
        kind: "cover",
        originalArtist: "Original artist",
        lyrics: { format: "lrc", text: sung.lyrics },
      });
      expect(score.record.kind).toBe("original");
      expect(score.record.originalArtist).toBeUndefined();
      expect(score.record.score).toMatchObject({
        $type: "blob",
        mimeType: "application/vnd.recordare.musicxml",
        size: 8,
      });
    }));

  test("untimed lyrics are plain, and a score outside the scores directory is refused", () =>
    fixture(async ({ root }) => {
      const [plainLyrics] = await prepareCompanions([{ ...sung, lyrics: "first line\nsecond line" }], did, root);
      expect(plainLyrics.record.lyrics.format).toBe("plain");
      for (const score of ["/music/scores/../../outside.mxl", "/music/scored.mp3", "/music/scores/scored.pdf"])
        await expect(prepareCompanions([{ ...scored, score }], did, root)).rejects.toThrow("Invalid score path");
    }));

  test("publishing pins each fm.plyr.track by uri and cid, then writes nothing when unchanged", () =>
    fixture(async ({ items, companions }) => {
      const agent = fakeAgent(items);
      await publishCompanions(companions, items, agent, did, quiet);
      const written = agent.collections["dev.kualta.track"];
      expect(written.map((entry) => entry.value.track)).toEqual([
        { uri: agent.collections["fm.plyr.track"][0].uri, cid: trackCids[0] },
        { uri: agent.collections["fm.plyr.track"][1].uri, cid: trackCids[1] },
      ]);
      expect(agent.calls.uploads).toEqual(["application/vnd.recordare.musicxml"]);
      await publishCompanions(companions, items, agent, did, quiet);
      await publishCompanions(companions, items, agent, did, { ...quiet, verifyOnly: true });
      expect(agent.calls.puts).toHaveLength(2);
      expect(agent.calls.uploads).toHaveLength(1);
    }));

  test("a new track CID or new lyrics rewrites the record without uploading the score again", () =>
    fixture(async ({ items, companions }) => {
      const agent = fakeAgent(items);
      await publishCompanions(companions, items, agent, did, quiet);
      agent.collections["fm.plyr.track"][1].cid = trackCids[3];
      await publishCompanions(companions, items, agent, did, quiet);
      expect(agent.collections["dev.kualta.track"][1].value.track.cid).toBe(trackCids[3]);
      companions[0].record.lyrics.text = "[00:01.00]rewritten";
      await publishCompanions(companions, items, agent, did, quiet);
      expect(agent.collections["dev.kualta.track"][0].value.lyrics.text).toBe("[00:01.00]rewritten");
      expect(agent.calls.puts).toHaveLength(4);
      expect(agent.calls.uploads).toHaveLength(1);
    }));

  test("changed score bytes are uploaded once more", () =>
    fixture(async ({ items, companions, root, tracks }) => {
      const agent = fakeAgent(items);
      await publishCompanions(companions, items, agent, did, quiet);
      await writeFile(join(root, "music/scores/scored.mxl"), "PK another score");
      const changed = await prepareCompanions(tracks, did, root);
      await publishCompanions(changed, items, agent, did, quiet);
      expect(agent.calls.uploads).toHaveLength(2);
      expect(agent.collections["dev.kualta.track"][1].value.score.size).toBe(16);
    }));

  test("a PDS that stores the score as a ZIP keeps its type and still reuses the blob", () =>
    fixture(async ({ items, companions }) => {
      const agent = fakeAgent(items, { storedMimeType: "application/zip" });
      await publishCompanions(companions, items, agent, did, quiet);
      expect(agent.collections["dev.kualta.track"][1].value.score.mimeType).toBe("application/zip");
      await publishCompanions(companions, items, agent, did, { ...quiet, verifyOnly: true });
      expect(agent.calls.uploads).toHaveLength(1);
      const mangling = fakeAgent(items, { storedMimeType: "text/plain" });
      await expect(publishCompanions(companions, items, mangling, did, quiet)).rejects.toThrow("Score upload mismatch");
      expect(mangling.collections["dev.kualta.track"].map((entry) => entry.uri)).toEqual([companions[0].uri]);
    }));

  test("a removed track, score or lyrics stops with the stale URI and deletes nothing", () =>
    fixture(async ({ items, companions, root }) => {
      const agent = fakeAgent(items);
      await publishCompanions(companions, items, agent, did, quiet);
      const puts = agent.calls.puts.length;
      const removed = [
        [companions[0]],
        await prepareCompanions([sung, { ...scored, score: null }], did, root),
        await prepareCompanions([{ ...sung, lyrics: null, score: scored.score }, scored], did, root),
      ];
      const staleUris = [companions[1].uri, companions[1].uri, companions[0].uri];
      for (const [index, next] of removed.entries())
        await expect(publishCompanions(next, items, agent, did, quiet)).rejects.toThrow(
          `Explicitly remove their AT records before retrying: ${staleUris[index]}`,
        );
      expect(agent.calls.puts).toHaveLength(puts);
      expect(agent.collections["dev.kualta.track"]).toHaveLength(2);
    }));

  test("verify, a wrong identity, a missing track record and a reused key cannot write", () =>
    fixture(async ({ items, companions }) => {
      const agent = fakeAgent(items);
      await expect(publishCompanions(companions, items, agent, did, { verifyOnly: true })).rejects.toThrow("differs");
      await expect(publishCompanions(companions, items, agent, "did:plc:wrong")).rejects.toThrow("identity");
      const tracks = agent.collections["fm.plyr.track"];
      agent.collections["fm.plyr.track"] = [];
      await expect(publishCompanions(companions, items, agent, did, quiet)).rejects.toThrow(
        "No published fm.plyr.track record to reference: sung",
      );
      expect(agent.calls.puts).toHaveLength(0);
      agent.collections["fm.plyr.track"] = tracks;
      await publishCompanions(companions, items, agent, did, quiet);
      tracks[0].uri = `at://${did}/fm.plyr.track/3m2zzzzzzzzzzz`;
      await expect(publishCompanions(companions, items, agent, did, quiet)).rejects.toThrow(
        "Record key belongs to different content",
      );
      expect(agent.calls.puts).toHaveLength(2);
    }));
});
