import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Scrollable } from "@/components/Scrollable";
import { activeLineIndex, parseLrc } from "@/lib/lyrics";
import type { Track } from "@/types";

interface Props {
  track: Track;
  time: number;
}

export function LyricsPanel({ track, time }: Props) {
  const lines = useMemo(() => (track.lyrics ? parseLrc(track.lyrics) : []), [track.lyrics]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLParagraphElement>(null);
  const [edges, setEdges] = useState({ top: false, bottom: false });
  const current = lines.length ? activeLineIndex(lines, time) : -1;

  // only veil an edge that has words hidden behind it
  const readEdges = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const top = container.scrollTop > 4;
    const bottom = container.scrollTop + container.clientHeight < container.scrollHeight - 4;
    setEdges((previous) => (previous.top === top && previous.bottom === bottom ? previous : { top, bottom }));
  }, []);

  useEffect(() => {
    if (current < 0) {
      readEdges();
      return;
    }

    // centre it by hand; measured against the panel itself, since offsetTop
    // answers to whichever ancestor happens to be positioned
    const container = scrollRef.current;
    const line = activeRef.current;
    if (!container || !line) return;

    const offset = line.getBoundingClientRect().top - container.getBoundingClientRect().top;
    const top = container.scrollTop + offset - container.clientHeight / 2 + line.offsetHeight / 2;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    container.scrollTo({ top, behavior: reduced ? "auto" : "smooth" });
    readEdges();
  }, [current, readEdges]);

  useEffect(() => {
    readEdges();
  }, [readEdges]);

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
    <Scrollable
      ref={scrollRef}
      onScroll={readEdges}
      className={`lyrics-fade ${edges.top ? "fade-top" : ""} ${edges.bottom ? "fade-bottom" : ""}`}
    >
      {/* the words stop well short of the scrollbar rather than running into it */}
      <div className="flex flex-col gap-2.5 pr-7 text-base leading-snug">
        {lines.map((line, index) => (
          <p
            key={`${line.time}-${index}`}
            ref={index === current ? activeRef : undefined}
            className={`lyric-line ${index === current ? "is-current" : ""}`}
            // the sung line is brightest, and the song dims away either side of it
            style={{ opacity: current < 0 ? 0.55 : Math.max(0.14, 1 - Math.abs(index - current) * 0.22) }}
          >
            {line.text}
          </p>
        ))}
      </div>
    </Scrollable>
  );
}
