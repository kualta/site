import type { PointerEventHandler } from "react";
import type { Track } from "@/types";

interface Props {
  track: Track;
  spinning?: boolean;
  deck?: boolean;
  scrubbing?: boolean;
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
  scrubAngle = 0,
  className = "",
  viewTransitionName,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: Props) {
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
      <div className="vinyl-scrub" style={scrubAngle ? { transform: `rotate(${scrubAngle}rad)` } : undefined}>
        <div className={`vinyl-disc ${deck ? "is-deck" : ""} ${spinning ? "is-playing" : ""}`}>
          <div className="vinyl-grooves" />
          <div className="vinyl-label">
            {track.cover ? (
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
