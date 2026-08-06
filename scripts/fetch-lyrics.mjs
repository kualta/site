/**
 * Looks up lyrics for every record and writes them into the file itself.
 *
 * Run this by hand when adding music (`bun run music:lyrics`), not during the
 * build: the words then live in the MP3 like the artwork, and the build stays
 * offline. Pass --force to refetch tracks that already carry lyrics.
 *
 * Plain words go in USLT so other players show them; the timestamped LRC goes
 * in a TXXX frame, which is what drives the highlighting on the site.
 */
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFile } from "music-metadata";
import NodeID3 from "node-id3";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const audioDir = path.join(root, "public/music");
const force = process.argv.includes("--force");
const onlyFlag = process.argv.indexOf("--only");
const only = onlyFlag === -1 ? null : process.argv[onlyFlag + 1];

export const SYNCED_FRAME = "LYRICS_SYNCED";

/** timestamped words beat plain ones; after that, the closest running time wins */
function best(candidates, duration) {
  const usable = candidates.filter((entry) => entry?.plainLyrics || entry?.syncedLyrics);
  if (usable.length === 0) return null;

  return usable.sort((a, b) => {
    const synced = Number(Boolean(b.syncedLyrics)) - Number(Boolean(a.syncedLyrics));
    if (synced !== 0) return synced;
    return Math.abs((a.duration ?? 0) - duration) - Math.abs((b.duration ?? 0) - duration);
  })[0];
}

async function lookup(artist, title, duration) {
  const candidates = [];

  for (const query of [
    { artist_name: artist, track_name: title, duration: String(duration) },
    { artist_name: artist, track_name: title },
  ]) {
    const response = await fetch(`https://lrclib.net/api/get?${new URLSearchParams(query)}`);
    if (response.ok) candidates.push(await response.json());
  }

  // an exact match often carries no timestamps while a sibling entry does
  if (!candidates.some((entry) => entry?.syncedLyrics)) {
    const search = await fetch(
      `https://lrclib.net/api/search?${new URLSearchParams({ artist_name: artist, track_name: title })}`,
    );
    if (search.ok) candidates.push(...(await search.json()).slice(0, 10));
  }

  return best(candidates, duration);
}

async function main() {
  if (!existsSync(audioDir)) return;

  const files = (await readdir(audioDir)).filter((file) => file.endsWith(".mp3")).sort();
  let added = 0;
  let missing = 0;

  for (const file of files) {
    if (only && path.basename(file, ".mp3") !== only) continue;
    const full = path.join(audioDir, file);
    const { common } = await parseFile(full);
    const existing = NodeID3.read(full);
    const hasLyrics = Boolean(existing.unsynchronisedLyrics?.text);

    if (hasLyrics && !force) {
      console.log(`[lyrics] ${file.padEnd(22)} already tagged`);
      continue;
    }

    // a cover's words belong to the original song
    const artist = common.originalartist ?? common.artist;
    const title = common.title ?? path.basename(file, ".mp3");
    const found = artist ? await lookup(artist, title, Math.round(common.duration ?? 0)) : null;

    if (!found) {
      missing += 1;
      console.log(`[lyrics] ${file.padEnd(22)} no match for "${title}" by ${artist ?? "unknown"}`);
      continue;
    }

    const userDefined = (existing.userDefinedText ?? []).filter((entry) => entry.description !== SYNCED_FRAME);
    if (found.syncedLyrics) userDefined.push({ description: SYNCED_FRAME, value: found.syncedLyrics });

    NodeID3.update(
      {
        unsynchronisedLyrics: { language: "eng", text: found.plainLyrics ?? "" },
        userDefinedText: userDefined,
      },
      full,
    );

    added += 1;
    console.log(`[lyrics] ${file.padEnd(22)} tagged${found.syncedLyrics ? " (synced)" : " (plain)"}`);
  }

  console.log(`[lyrics] ${added} tagged, ${missing} without a match`);
}

await main();
