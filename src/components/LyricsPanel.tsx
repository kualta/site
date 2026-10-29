import { useEffect, useMemo, useRef } from "react";
import { Scrollable } from "@/components/Scrollable";
import { activeLineIndex, parseLrc } from "@/lib/lyrics";
import { langFor } from "@/lib/script";
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
  const current = lines.length ? activeLineIndex(lines, time) : -1;

  // a new record starts its words from the top, wherever the last one ended up
  // biome-ignore lint/correctness/useExhaustiveDependencies: the slug is the trigger, not an input
  useEffect(() => {
    const container = scrollRef.current;
    if (container) container.scrollTop = 0;
  }, [track.slug]);

  useEffect(() => {
    if (current < 0 || !focus) return;

    // centre it by hand; measured against the panel itself, since offsetTop
    // answers to whichever ancestor happens to be positioned
    const container = scrollRef.current;
    const line = activeRef.current;
    if (!container || !line) return;

    // nothing to follow if every line already fits on screen
    if (container.scrollHeight <= container.clientHeight) return;

    const offset = line.getBoundingClientRect().top - container.getBoundingClientRect().top;
    const top = container.scrollTop + offset - container.clientHeight / 2 + line.offsetHeight / 2;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    container.scrollTo({ top, behavior: reduced ? "auto" : "smooth" });
  }, [current, focus]);

  if (!track.lyrics) {
    return (
      <p className="font-mono text-xs text-secondary-text">
        {track.kind === "original"
          ? "instrumental"
          : track.originalArtist
            ? "no lyrics"
            : "no lyrics — naming the original artist would let the lookup find them"}
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
    <Scrollable ref={scrollRef} fade>
      {/* the words stop well short of the scrollbar rather than running into it */}
      <div className="flex flex-col items-start gap-2.5 pr-7 text-base leading-snug">
        {lines.map((line, index) => (
          <button
            key={`${line.time}-${index}`}
            ref={index === current ? (activeRef as React.Ref<HTMLButtonElement>) : undefined}
            type="button"
            lang={langFor(line.text)}
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
