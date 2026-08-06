/**
 * Lyrics are read from the MP3 tags at build time (see scripts/fetch-lyrics.mjs),
 * so the page never calls out to a lyrics service at runtime.
 */
export interface LyricLine {
  time: number;
  text: string;
}

/** `[01:23.45] a line` — one or more stamps, then the words. Plain text yields nothing. */
export function parseLrc(lrc: string): LyricLine[] {
  const lines: LyricLine[] = [];

  for (const raw of lrc.split("\n")) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+)(?:\.(\d+))?\]/g)];
    if (stamps.length === 0) continue;
    const text = raw.replace(/\[[^\]]*\]/g, "").trim();
    // silent stamps mark gaps and the end of the song; they are not words
    if (!text) continue;

    for (const stamp of stamps) {
      const minutes = Number(stamp[1]);
      const seconds = Number(stamp[2]);
      const fraction = stamp[3] ? Number(`0.${stamp[3]}`) : 0;
      lines.push({ time: minutes * 60 + seconds + fraction, text });
    }
  }

  return lines.sort((a, b) => a.time - b.time);
}

export function activeLineIndex(lines: LyricLine[], time: number) {
  let index = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= time) index = i;
    else break;
  }
  return index;
}
