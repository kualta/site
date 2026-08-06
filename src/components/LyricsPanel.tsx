import { useEffect, useMemo, useRef } from "react";
import { Scrollable } from "@/components/Scrollable";
import { activeLineIndex, parseLrc } from "@/lib/lyrics";
import type { Track } from "@/types";

interface Props {
  track: Track;
  time: number;
}

export function LyricsPanel({ track, time }: Props) {
  const lines = useMemo(() => (track.lyrics ? parseLrc(track.lyrics) : []), [track.lyrics]);
  const activeRef = useRef<HTMLParagraphElement>(null);
  const current = lines.length ? activeLineIndex(lines, time) : -1;

  useEffect(() => {
    if (current < 0 || !activeRef.current) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    activeRef.current.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
  }, [current]);

  if (!track.lyrics) {
    return (
      <p className="font-mono text-xs text-secondary-text">
        no lyrics{track.originalArtist ? "" : " — naming the original artist would let the lookup find them"}
      </p>
    );
  }

  // no timestamps in the tag, so show the words as written
  if (!lines.length) {
    return (
      <Scrollable>
        <p className="whitespace-pre-line text-[0.95rem] leading-relaxed text-secondary-text">{track.lyrics}</p>
      </Scrollable>
    );
  }

  return (
    <Scrollable>
      <div className="flex flex-col gap-2.5 text-base leading-snug">
        {lines.map((line, index) => (
          <p
            key={`${line.time}-${index}`}
            ref={index === current ? activeRef : undefined}
            className={`lyric-line ${index === current ? "is-current" : ""}`}
          >
            {line.text || "·"}
          </p>
        ))}
      </div>
    </Scrollable>
  );
}
