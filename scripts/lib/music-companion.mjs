import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { recordKey } from "./atproto-content.mjs";
import { coverBlob, listRecords, plain, putVerified } from "./atproto-publish.mjs";
import { validateRecord } from "./atproto-validation.mjs";
import { matchTrack } from "./music-publish.mjs";

const COMPANION = "dev.kualta.track";
const TRACK = "fm.plyr.track";
const SCORE_TYPES = {
  ".mxl": "application/vnd.recordare.musicxml",
  ".musicxml": "application/vnd.recordare.musicxml+xml",
  ".xml": "application/vnd.recordare.musicxml+xml",
};
// The PDS names a blob by its sniffed content before the uploader's type: a compressed score is a ZIP container.
const SNIFFED_SCORE_TYPES = {
  "application/vnd.recordare.musicxml": "application/zip",
  "application/vnd.recordare.musicxml+xml": "application/xml",
};
const STORED_SCORE_TYPES = new Set(Object.entries(SNIFFED_SCORE_TYPES).flat());
const MAX_SCORE_BYTES = 2_000_000;

export const sniffedScoreType = (mimeType) => SNIFFED_SCORE_TYPES[mimeType];

export const companionUri = (did, slug) => `at://${did}/${COMPANION}/${recordKey(`${COMPANION}:${slug}`)}`;

const sameBytes = (a, b) => a?.ref?.$link === b.ref.$link && a.size === b.size;

export async function prepareCompanions(tracks, did, publicDirectory = "public") {
  const scores = resolve(publicDirectory, "music/scores");
  const items = [];
  for (const track of tracks) {
    if (!track.lyrics && !track.score) continue;
    const item = {
      slug: track.slug,
      uri: companionUri(did, track.slug),
      record: {
        $type: COMPANION,
        kind: track.kind,
        ...(track.kind === "cover" ? { originalArtist: track.originalArtist } : {}),
      },
    };
    if (track.lyrics)
      item.record.lyrics = { format: /^\[\d+:\d+(\.\d+)?\]/m.test(track.lyrics) ? "lrc" : "plain", text: track.lyrics };
    if (track.score) {
      const mimeType = SCORE_TYPES[extname(track.score)];
      const absolute = resolve(publicDirectory, `.${track.score}`);
      if (!mimeType || !absolute.startsWith(`${scores}${sep}`)) throw new Error(`Invalid score path: ${track.slug}`);
      item.score = await readFile(absolute);
      if (item.score.length > MAX_SCORE_BYTES) throw new Error(`Score exceeds ${MAX_SCORE_BYTES} bytes: ${track.slug}`);
      item.record.score = await coverBlob({ base64: item.score.toString("base64"), mimeType });
    }
    items.push(item);
  }
  return items;
}

export async function publishCompanions(companions, items, agent, did, { verifyOnly = false, log = console.log } = {}) {
  if (!verifyOnly && agent.did !== did) throw new Error("Music publishing identity mismatch");
  const repo = agent.com.atproto.repo;
  const tracks = await listRecords(repo, did, TRACK);
  const existing = await listRecords(repo, did, COMPANION);
  const plans = companions.map((companion) => ({
    companion,
    previous: existing.find((entry) => entry.uri === companion.uri),
  }));
  const expected = new Set(companions.map((companion) => companion.uri));
  const stale = [
    ...existing.filter((entry) => !expected.has(entry.uri)).map((entry) => entry.uri),
    ...plans
      .filter(({ companion, previous }) =>
        ["lyrics", "score"].some((field) => previous?.value[field] && !companion.record[field]),
      )
      .map(({ companion }) => companion.uri),
  ];
  if (stale.length)
    throw new Error(
      `Previously published ${COMPANION} records have lost their track, lyrics or score in the site data. Explicitly remove their AT records before retrying; a track that still has lyrics or a score gets a new record on that run: ${stale.join(
        ", ",
      )}`,
    );
  for (const { companion, previous } of plans) {
    const published = matchTrack(
      tracks,
      items.find((item) => item.slug === companion.slug),
    );
    if (!published) throw new Error(`No published ${TRACK} record to reference: ${companion.slug}`);
    const record = { ...companion.record, track: { uri: published.uri, cid: published.cid } };
    // Listed blobs arrive as BlobRef instances, which neither compare nor validate as plain blob JSON.
    const previousScore = previous?.value.score && plain(previous.value.score);
    const reusable = record.score && sameBytes(previousScore, record.score);
    if (reusable) record.score = previousScore;
    validateRecord(record);
    if (isDeepStrictEqual(plain(previous?.value ?? null), plain(record))) {
      log(`Unchanged ${companion.slug}: ${companion.uri}`);
      continue;
    }
    if (verifyOnly) throw new Error(`Remote track companion differs: ${companion.slug}`);
    if (record.score && !reusable) {
      const uploaded = plain((await repo.uploadBlob(companion.score, { encoding: record.score.mimeType })).data.blob);
      if (!sameBytes(uploaded, record.score) || !STORED_SCORE_TYPES.has(uploaded.mimeType))
        throw new Error(`Score upload mismatch: ${companion.slug}`);
      record.score = uploaded;
    }
    await putVerified(repo, did, companion.uri, record, previous, log);
  }
}
