/**
 * Reads every record in public/music, pulls the artwork and duration out of the
 * file itself, and refreshes src/data/music.json.
 *
 * The audio file is the source of truth for artwork. A hand-placed image in
 * public/music/fallback/<slug>.(jpg|png) is used only when a track carries no
 * embedded art. Generated covers land in public/music/covers and are gitignored.
 */
import { readdir, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFile, selectCover } from "music-metadata";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const audioDir = path.join(root, "public/music");
const coverDir = path.join(audioDir, "covers");
const fallbackDir = path.join(audioDir, "fallback");
const dataFile = path.join(root, "src/data/music.json");

const AUDIO = /\.(mp3|m4a|flac|ogg|opus|webm|wav)$/i;
const EXT_FOR_MIME = { "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp" };

const slugify = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const titleize = (slug) => slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

async function readExisting() {
  try {
    const entries = JSON.parse(await readFile(dataFile, "utf8"));
    return new Map(entries.map((entry) => [entry.slug, entry]));
  } catch {
    return new Map();
  }
}

async function findFallback(slug) {
  for (const ext of ["jpg", "jpeg", "png", "webp"]) {
    const candidate = path.join(fallbackDir, `${slug}.${ext}`);
    if (existsSync(candidate)) return `/music/fallback/${slug}.${ext}`;
  }
  return null;
}

async function main() {
  if (!existsSync(audioDir)) {
    console.log("[music] no public/music directory, nothing to sync");
    return;
  }

  // generated covers are disposable: rebuild them from scratch every run
  await rm(coverDir, { recursive: true, force: true });
  await mkdir(coverDir, { recursive: true });

  const existing = await readExisting();

  // the timestamped copy rides in a TXXX frame; USLT holds the plain words
  const readLyrics = (metadata) => {
    for (const tags of Object.values(metadata.native ?? {})) {
      const synced = tags.find((tag) => tag.id === "TXXX:LYRICS_SYNCED");
      if (synced?.value) return String(synced.value);
    }
    return metadata.common.lyrics?.[0]?.text?.trim() || null;
  };
  const files = (await readdir(audioDir)).filter((file) => AUDIO.test(file)).sort();
  const tracks = [];
  let embedded = 0;
  let fellBack = 0;

  for (const file of files) {
    const slug = slugify(path.basename(file, path.extname(file)));
    const previous = existing.get(slug);
    const metadata = await parseFile(path.join(audioDir, file), { duration: true });
    const { common, format } = metadata;

    let cover = null;
    const picture = selectCover(common.picture);

    if (picture) {
      const ext = EXT_FOR_MIME[picture.format?.toLowerCase()] ?? "jpg";
      await writeFile(path.join(coverDir, `${slug}.${ext}`), picture.data);
      cover = `/music/covers/${slug}.${ext}`;
      embedded += 1;
    } else {
      cover = await findFallback(slug);
      if (cover) fellBack += 1;
    }

    tracks.push({
      // positional, never carried over: a stale id can collide with a fresh one
      id: tracks.length + 1,
      slug,
      // tags win over the filename, hand edits in music.json win over both
      title: previous?.title ?? common.title ?? titleize(slug),
      artist: previous?.artist ?? common.artist ?? "K.U",
      album: previous?.album ?? common.album ?? null,
      // a TOPE tag means someone else got there first
      originalArtist: previous?.originalArtist ?? common.originalartist ?? null,
      kind: previous?.kind ?? (common.originalartist ? "cover" : "original"),
      lyrics: readLyrics(metadata),
      date: previous?.date ?? (common.year ? `${common.year}-01-01` : new Date().toISOString().slice(0, 10)),
      duration: Math.round(format.duration ?? previous?.duration ?? 0),
      src: `/music/${file}`,
      cover,
    });

    const source = picture ? "embedded" : cover ? "fallback" : "none";
    const words = readLyrics(metadata);
    console.log(
      `[music] ${slug.padEnd(22)} ${String(Math.round(format.duration ?? 0)).padStart(4)}s  art: ${source.padEnd(8)} lyrics: ${words ? (words.includes("[") ? "synced" : "plain") : "none"}`,
    );
  }

  tracks.sort((a, b) => b.date.localeCompare(a.date));
  await writeFile(dataFile, `${JSON.stringify(tracks, null, 2)}\n`);
  console.log(`[music] ${tracks.length} tracks, ${embedded} embedded covers, ${fellBack} fallback, wrote src/data/music.json`);
}

await main();
