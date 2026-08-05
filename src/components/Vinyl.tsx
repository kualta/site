import type { Track } from "@/types";

interface Props {
  track: Track;
  spinning?: boolean;
  deck?: boolean;
  className?: string;
  viewTransitionName?: string;
}

export function Vinyl({ track, spinning = false, deck = false, className = "", viewTransitionName }: Props) {
  return (
    <div
      className={`vinyl ${deck ? "vinyl-deck" : ""} ${className}`}
      style={viewTransitionName ? { viewTransitionName } : undefined}
    >
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
      <div className="vinyl-sheen" />
      <div className="vinyl-spindle" />
    </div>
  );
}
