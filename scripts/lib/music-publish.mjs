import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Lexicons, jsonToLex } from "@atproto/lexicon";
import { schemas } from "@atproto/api";
import { coverBlob, listRecords } from "./atproto-publish.mjs";

const schema = JSON.parse(await readFile(new URL("../lexicons/fm.plyr.track.json", import.meta.url), "utf8"));
const lexicons = new Lexicons([...schemas, schema]);
const plain = (value) => JSON.parse(JSON.stringify(value));

export async function prepareMusic(tracks, origin, publicDirectory = "public") {
  const root = resolve(publicDirectory);
  const seen = new Set();
  const audioPaths = new Set();
  async function asset(path) {
    if (typeof path !== "string" || !path.startsWith("/music/")) throw new Error("Invalid music asset path");
    const absolute = resolve(root, `.${path}`);
    if (!absolute.startsWith(`${root}${sep}`)) throw new Error("Music asset escapes public directory");
    return readFile(absolute);
  }
  return Promise.all(
    tracks.map(async (track) => {
      if (!/^[a-z0-9-]+$/.test(track.slug) || seen.has(track.slug)) throw new Error("Invalid or duplicate music slug");
      seen.add(track.slug);
      if (audioPaths.has(track.src) || !track.src?.endsWith(".mp3")) throw new Error("Invalid or duplicate audio source");
      audioPaths.add(track.src);
      if (!["cover", "original"].includes(track.kind) || (track.kind === "cover" && !track.originalArtist))
        throw new Error(`Missing music authorship: ${track.slug}`);
      const audio = await asset(track.src);
      const artwork = await asset(track.cover);
      const audioBlob = await coverBlob({ base64: audio.toString("base64"), mimeType: "audio/mpeg" });
      const record = {
        $type: "fm.plyr.track",
        title: track.title,
        artist: track.artist,
        fileType: "mp3",
        audioUrl: new URL(track.src, origin).href,
        audioBlob,
        imageUrl: new URL(track.cover, origin).href,
        duration: Math.round(track.duration),
        createdAt: new Date(track.date).toISOString(),
        description: [
          new URL(`/music/${track.slug}/`, origin).href,
          track.kind === "cover"
            ? `Performed by ${track.artist}. Original artist: ${track.originalArtist}.`
            : `Original music by ${track.artist}.`,
        ].join("\n\n"),
        ...(track.album ? { album: track.album } : {}),
      };
      lexicons.assertValidRecord(record.$type, jsonToLex(record));
      return { slug: track.slug, record, audio, artwork, artworkUrl: record.imageUrl };
    }),
  );
}

export async function verifyMusicAssets(items, fetcher = fetch) {
  for (const item of items) {
    for (const [url, bytes] of [
      [item.record.audioUrl, item.audio],
      [item.artworkUrl, item.artwork],
    ]) {
      const response = await fetcher(url, { cache: "no-store", signal: AbortSignal.timeout(60_000) });
      if (!response.ok || !Buffer.from(await response.arrayBuffer()).equals(bytes))
        throw new Error(`Deployed music differs: ${url}`);
    }
  }
}

export async function publishMusic(items, agent, did, { verifyOnly = false, log = console.log } = {}) {
  if (!verifyOnly && agent.did !== did) throw new Error("Music publishing identity mismatch");
  const repo = agent.com.atproto.repo;
  const existing = await listRecords(repo, did, "fm.plyr.track");
  // Match the site's source audio URL, preserving AT-URIs and listener interactions.
  const plans = items.map((item) => {
    const source = item.record.description.split("\n")[0];
    const matches = existing.filter(
      (entry) => entry.value.audioUrl === item.record.audioUrl || entry.value.description?.split("\n")[0] === source,
    );
    if (matches.length > 1) throw new Error(`Duplicate remote music: ${item.slug}`);
    return { item, previous: matches[0] };
  });
  for (const { item, previous } of plans) {
    const record = { ...previous?.value, ...item.record };
    // API-uploaded artwork must survive subsequent site metadata publications.
    if (previous?.value.imageUrl && item.record.imageUrl === item.artworkUrl)
      record.imageUrl = previous.value.imageUrl;
    if (!item.record.album) delete record.album;
    lexicons.assertValidRecord(record.$type, jsonToLex(record));
    if (isDeepStrictEqual(plain(previous?.value ?? null), plain(record))) {
      log(`Unchanged ${item.slug}: ${previous.uri}`);
      continue;
    }
    if (verifyOnly) throw new Error(`Remote music differs: ${item.slug}`);
    if (!isDeepStrictEqual(plain(previous?.value.audioBlob ?? null), plain(record.audioBlob))) {
      const uploaded = await repo.uploadBlob(item.audio, { encoding: "audio/mpeg" });
      if (!isDeepStrictEqual(plain(uploaded.data.blob), plain(record.audioBlob)))
        throw new Error(`Audio upload mismatch: ${item.slug}`);
    }
    const params = { repo: did, collection: record.$type, record, validate: false };
    const result = previous
      ? await repo.putRecord({ ...params, rkey: previous.uri.split("/").at(-1), swapRecord: previous.cid })
      : await repo.createRecord(params);
    const readback = await repo.getRecord({
      repo: did,
      collection: record.$type,
      rkey: result.data.uri.split("/").at(-1),
    });
    if (!isDeepStrictEqual(plain(readback.data.value), plain(record)))
      throw new Error(`Music readback mismatch: ${item.slug}`);
    log(`Published and verified ${item.slug}: ${result.data.uri}`);
  }
}
