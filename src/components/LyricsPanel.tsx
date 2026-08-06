import { useEffect, useRef, useState } from "react";
import { activeLineIndex, fetchLyrics, type Lyrics } from "@/lib/lyrics";
import type { Track } from "@/types";

interface Props {
  track: Track;
  time: number;
}

export function LyricsPanel({ track, time }: Props) {
  const [lyrics, setLyrics] = useState<Lyrics | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "empty">("loading");
  const activeRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    setLyrics(null);

    fetchLyrics(track).then((found) => {
      if (cancelled) return;
      setLyrics(found);
      setState(found ? "ready" : "empty");
    });

    return () => {
      cancelled = true;
    };
  }, [track]);

  const current = lyrics?.lines ? activeLineIndex(lyrics.lines, time) : -1;

  useEffect(() => {
    if (current < 0 || !activeRef.current) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    activeRef.current.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
  }, [current]);

  if (state === "loading") {
    return <p className="font-mono text-xs text-secondary-text">looking for lyrics…</p>;
  }

  if (state === "empty" || !lyrics) {
    return (
      <p className="font-mono text-xs text-secondary-text">
        no lyrics found{track.originalArtist ? "" : " — an original artist would help the search"}
      </p>
    );
  }

  if (!lyrics.lines) {
    return <p className="whitespace-pre-line text-sm leading-relaxed text-secondary-text">{lyrics.plain}</p>;
  }

  return (
    <div className="flex flex-col gap-2 text-sm leading-snug">
      {lyrics.lines.map((line, index) => (
        <p
          key={`${line.time}-${index}`}
          ref={index === current ? activeRef : undefined}
          className={`lyric-line ${index === current ? "is-current" : ""}`}
        >
          {line.text || "·"}
        </p>
      ))}
    </div>
  );
}
