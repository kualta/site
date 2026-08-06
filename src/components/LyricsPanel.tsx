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
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLParagraphElement>(null);
  const firstRef = useRef<HTMLParagraphElement>(null);
  const current = lines.length ? activeLineIndex(lines, time) : -1;

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // before the first line is sung, sit at the top of the words rather than
    // in the empty run-up that lets later lines centre themselves
    if (current < 0) {
      const container = scrollRef.current;
      const first = firstRef.current;
      if (container && first) {
        const offset = first.getBoundingClientRect().top - container.getBoundingClientRect().top;
        container.scrollTop = container.scrollTop + offset - 8;
      }
      return;
    }

    // centre it by hand; measured against the panel itself, since offsetTop
    // answers to whichever ancestor happens to be positioned
    const container = scrollRef.current;
    const line = activeRef.current;
    if (!container || !line) return;
    const offset = line.getBoundingClientRect().top - container.getBoundingClientRect().top;
    const top = container.scrollTop + offset - container.clientHeight / 2 + line.offsetHeight / 2;
    container.scrollTo({ top, behavior: reduced ? "auto" : "smooth" });
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
    <Scrollable className="lyrics-fade" ref={scrollRef}>
      <div className="flex flex-col gap-2.5 text-base leading-snug">
        {/* run-up and run-out, so the first and last lines can still centre */}
        <div className="lyrics-runway" aria-hidden="true" />
        {lines.map((line, index) => (
          <p
            key={`${line.time}-${index}`}
            ref={index === current ? activeRef : index === 0 ? firstRef : undefined}
            className={`lyric-line ${index === current ? "is-current" : ""}`}
            // the sung line is brightest, and the song dims away either side of it
            style={{ opacity: current < 0 ? 0.55 : Math.max(0.14, 1 - Math.abs(index - current) * 0.22) }}
          >
            {line.text || "·"}
          </p>
        ))}
        <div className="lyrics-runway" aria-hidden="true" />
      </div>
    </Scrollable>
  );
}
