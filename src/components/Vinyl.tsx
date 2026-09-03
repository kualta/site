import { useEffect, useState } from "react";
import type { PointerEventHandler } from "react";
import { AUTHOR } from "@/lib/credits";
import type { Track } from "@/types";

const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
const roman = (n: number) => ROMAN[n] ?? String(n);

/**
 * A long title has to shrink or it runs into the curve of the label. Size it by
 * the longest word, since that is what cannot be broken across lines.
 */
function titleSize(title: string) {
  const longest = Math.max(...title.split(/\s+/).map((word) => word.length), 1);
  return `${Math.min(11.5, Math.max(7, 138 / longest))}cqw`;
}

/** the album sits on one line of its own, so size it by the whole string */
function albumSize(album: string) {
  return `${Math.min(7.4, Math.max(4.8, 118 / album.length))}cqw`;
}

interface Props {
  track: Track;
  spinning?: boolean;
  deck?: boolean;
  scrubbing?: boolean;
  seeking?: boolean;
  /** extra rotation in radians, applied on top of the playback spin */
  scrubAngle?: number;
  className?: string;
  viewTransitionName?: string;
  onPointerDown?: PointerEventHandler<HTMLDivElement>;
  onPointerMove?: PointerEventHandler<HTMLDivElement>;
  onPointerUp?: PointerEventHandler<HTMLDivElement>;
}

export function Vinyl({
  track,
  spinning = false,
  deck = false,
  scrubbing = false,
  seeking = false,
  scrubAngle = 0,
  className = "",
  viewTransitionName,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: Props) {
  // the server-rendered deck would otherwise turn at full speed from the first
  // paint until hydration parks it, spinning a record nobody has played yet
  const [live, setLive] = useState(false);
  useEffect(() => setLive(true), []);

  return (
    <div
      className={`vinyl ${deck ? "vinyl-deck" : ""} ${scrubbing ? "is-scrubbing" : ""} ${className}`}
      style={viewTransitionName ? { viewTransitionName } : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {/* the hand turns this layer; the playback animation turns the one inside it */}
      <div className={`vinyl-scrub ${seeking ? "is-seeking" : ""}`} style={scrubAngle ? { transform: `rotate(${scrubAngle}rad)` } : undefined}>
        <div className={`vinyl-disc ${deck ? "is-deck" : ""} ${deck && live ? "is-live" : ""} ${spinning ? "is-playing" : ""}`}>
          <div className="vinyl-grooves" />
          <div className="vinyl-label">
            {track.kind === "original" && track.album ? (
              // a printed label for an album release, since it sets the album and
              // part; a standalone single wears its own sleeve instead
              <div key={track.slug} className="vinyl-label-print">
                <span className="label-top">
                  <span className="label-title" style={{ fontSize: titleSize(track.title) }}>
                    {track.title}
                  </span>
                </span>
                <span className="label-bottom">
                  {track.album && (
                    <span className="label-album" style={{ fontSize: albumSize(track.album) }}>
                      {track.album}
                    </span>
                  )}
                  {track.track ? <span className="label-part">part {roman(track.track)}</span> : null}
                  <span className="label-author">{AUTHOR}</span>
                </span>
              </div>
            ) : track.cover ? (
              // keyed so swapping records re-runs the label transition
              <img key={track.slug} src={track.cover} alt={`Cover art for ${track.title}`} loading="lazy" />
            ) : (
              <span key={track.slug} className="vinyl-label-fallback">
                {track.title}
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="vinyl-sheen" />
      <div className="vinyl-spindle" />
    </div>
  );
}
