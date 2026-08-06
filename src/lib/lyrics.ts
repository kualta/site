/**
 * Lyrics come from LRCLIB at runtime, never from this repo: the words belong to
 * whoever wrote them, so nothing is stored or redistributed here.
 */
import type { Track } from "@/types";

export interface LyricLine {
  time: number;
  text: string;
}

export interface Lyrics {
  lines: LyricLine[] | null;
  plain: string | null;
}

const cache = new Map<string, Lyrics | null>();
const ENDPOINT = "https://lrclib.net/api/get";

/** `[01:23.45] a line` — one or more stamps, then the words */
function parseLrc(lrc: string): LyricLine[] {
  const lines: LyricLine[] = [];

  for (const raw of lrc.split("\n")) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+)(?:\.(\d+))?\]/g)];
    if (stamps.length === 0) continue;
    const text = raw.replace(/\[[^\]]*\]/g, "").trim();

    for (const stamp of stamps) {
      const minutes = Number(stamp[1]);
      const seconds = Number(stamp[2]);
      const fraction = stamp[3] ? Number(`0.${stamp[3]}`) : 0;
      lines.push({ time: minutes * 60 + seconds + fraction, text });
    }
  }

  return lines.sort((a, b) => a.time - b.time);
}

function shape(payload: { syncedLyrics?: string | null; plainLyrics?: string | null }): Lyrics | null {
  const lines = payload.syncedLyrics ? parseLrc(payload.syncedLyrics) : null;
  const plain = payload.plainLyrics?.trim() || null;
  if (!lines?.length && !plain) return null;
  return { lines: lines?.length ? lines : null, plain };
}

async function ask(params: URLSearchParams): Promise<Lyrics | null> {
  const response = await fetch(`${ENDPOINT}?${params}`);
  if (!response.ok) return null;
  return shape(await response.json());
}

export async function fetchLyrics(track: Track): Promise<Lyrics | null> {
  const cached = cache.get(track.slug);
  if (cached !== undefined) return cached;

  // a cover's words belong to the original song, so search under that name
  const artist = track.originalArtist ?? track.artist;
  let found: Lyrics | null = null;

  try {
    found = await ask(
      new URLSearchParams({ artist_name: artist, track_name: track.title, duration: String(track.duration) }),
    );
    // our duration is rounded, and LRCLIB wants it within a couple of seconds
    if (!found) found = await ask(new URLSearchParams({ artist_name: artist, track_name: track.title }));
  } catch {
    found = null;
  }

  cache.set(track.slug, found);
  return found;
}

export function activeLineIndex(lines: LyricLine[], time: number) {
  let index = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= time) index = i;
    else break;
  }
  return index;
}
