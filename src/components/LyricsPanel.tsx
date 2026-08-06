import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Scrollable } from "@/components/Scrollable";
import { activeLineIndex, parseLrc } from "@/lib/lyrics";
import type { Track } from "@/types";

interface Props {
  track: Track;
  time: number;
  /** dim the rest of the song and follow along, rather than showing a flat list */
  focus?: boolean;
  onSeek?: (seconds: number) => void;
}

export function LyricsPanel({ track, time, focus = true, onSeek }: Props) {
  const lines = useMemo(() => (track.lyrics ? parseLrc(track.lyrics) : []), [track.lyrics]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLElement>(null);
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
    if (current < 0 || !focus) {
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
  }, [current, focus, readEdges]);

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
        <p className="whitespace-pre-line pr-7 text-[0.95rem] leading-relaxed text-secondary-text">{track.lyrics}</p>
      </Scrollable>
    );
  }

  const opacityFor = (index: number) => {
    if (!focus) return 1;
    if (current < 0) return 0.55;
    return Math.max(0.14, 1 - Math.abs(index - current) * 0.22);
  };

  return (
    <Scrollable
      ref={scrollRef}
      onScroll={readEdges}
      className={`lyrics-fade ${edges.top ? "fade-top" : ""} ${edges.bottom ? "fade-bottom" : ""}`}
    >
      {/* the words stop well short of the scrollbar rather than running into it */}
      <div className="flex flex-col items-start gap-2.5 pr-7 text-base leading-snug">
        {lines.map((line, index) => (
          <button
            key={`${line.time}-${index}`}
            ref={index === current ? (activeRef as React.Ref<HTMLButtonElement>) : undefined}
            type="button"
            className={`lyric-line text-left ${index === current ? "is-current" : ""}`}
            // the sung line is brightest, and the song dims away either side of it
            style={{ opacity: opacityFor(index) }}
            onClick={() => onSeek?.(line.time)}
          >
            {line.text}
          </button>
        ))}
      </div>
    </Scrollable>
  );
}
