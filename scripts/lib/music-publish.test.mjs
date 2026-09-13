import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareMusic, publishMusic, verifyMusicAssets } from "./music-publish.mjs";

const did = "did:plc:jhvnnnd3adml7t6anu3ay7ip";
const track = {
  slug: "song",
  title: "Song",
  artist: "kualta",
  kind: "cover",
  originalArtist: "Original artist",
  date: "2026-09-01",
  duration: 5,
  src: "/music/song.mp3",
  cover: "/music/song.jpg",
};
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "music-publish-"));
  try {
    await mkdir(join(root, "music"));
    await writeFile(join(root, "music/song.mp3"), "audio");
    await writeFile(join(root, "music/song.jpg"), "art");
    await fn(await prepareMusic([track], "https://kualta.dev", root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
function fakeAgent(items) {
  const records = [];
  const writes = [];
  let uploads = 0;
  const repo = {
    async listRecords() {
      return { data: { records: structuredClone(records) } };
    },
    async uploadBlob() {
      uploads++;
      return { data: { blob: items[0].record.audioBlob } };
    },
    async createRecord({ record }) {
      const uri = `at://${did}/fm.plyr.track/3m2abcdefghijkl`;
      records.push({ uri, cid: "cid1", value: structuredClone(record) });
      writes.push("create");
      return { data: { uri } };
    },
    async putRecord({ record, swapRecord }) {
      assert.equal(swapRecord, records[0].cid);
      records[0].value = structuredClone(record);
      writes.push("update");
      return { data: { uri: records[0].uri } };
    },
    async getRecord() {
      return { data: { value: structuredClone(records[0].value) } };
    },
  };
  return { did, com: { atproto: { repo } }, records, writes, uploads: () => uploads };
}
test("music publication preserves credits, is idempotent, and retains social fields on updates", () =>
  fixture(async (items) => {
    assert.match(items[0].record.description, /Original artist: Original artist/);
    const agent = fakeAgent(items);
    const options = { log() {} };
    await publishMusic(items, agent, did, options);
    await publishMusic(items, agent, did, options);
    assert.deepEqual(agent.writes, ["create"]);
    assert.equal(agent.uploads(), 1);
    agent.records[0].value.labels = { $type: "com.atproto.label.defs#selfLabels", values: [{ val: "sexual" }] };
    items[0].record.title = "Updated title";
    await publishMusic(items, agent, did, options);
    assert.deepEqual(agent.writes, ["create", "update"]);
    assert.equal(agent.records[0].value.labels.values[0].val, "sexual");
    assert.equal(agent.uploads(), 1);
  }));
test("identity mismatch, duplicate remote records, and verify-only differences cannot write", () =>
  fixture(async (items) => {
    const agent = fakeAgent(items);
    await assert.rejects(publishMusic(items, agent, "did:plc:wrong"), /identity/);
    await assert.rejects(publishMusic(items, agent, did, { verifyOnly: true }), /differs/);
    assert.equal(agent.writes.length, 0);
    await publishMusic(items, agent, did, { log() {} });
    agent.records.push(structuredClone(agent.records[0]));
    await assert.rejects(publishMusic(items, agent, did), /Duplicate/);
    assert.equal(agent.writes.length, 1);
  }));
test("publishing rejects stale deployment audio and unsafe or duplicate input", () =>
  fixture(async (items, root) => {
    await assert.rejects(
      verifyMusicAssets(items, async () => new Response("old audio")),
      /Deployed music differs/,
    );
    await assert.rejects(prepareMusic([track, track], "https://kualta.dev", root), /duplicate/);
    await assert.rejects(
      prepareMusic([{ ...track, src: "/music/../../outside.mp3" }], "https://kualta.dev", root),
      /escapes/,
    );
  }));
