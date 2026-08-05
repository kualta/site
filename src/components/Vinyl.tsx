import type { Track } from "@/types";

interface Props {
  track: Track;
  spinning?: boolean;
  className?: string;
  viewTransitionName?: string;
}

export function Vinyl({ track, spinning = false, className = "", viewTransitionName }: Props) {
  return (
    <div className={`vinyl ${className}`} style={viewTransitionName ? { viewTransitionName } : undefined}>
      <div className={`vinyl-disc ${spinning ? "is-playing" : ""}`}>
        <div className="vinyl-grooves" />
        <div className="vinyl-label">
          {track.cover ? (
            <img src={track.cover} alt={`Cover art for ${track.title}`} loading="lazy" />
          ) : (
            <span className="vinyl-label-fallback">{track.title}</span>
          )}
        </div>
      </div>
      <div className="vinyl-sheen" />
      <div className="vinyl-spindle" />
    </div>
  );
}
