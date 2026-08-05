import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { FiPause, FiPlay, FiSkipBack, FiSkipForward, FiX } from "react-icons/fi";
import { Vinyl } from "@/components/Vinyl";
import type { Track } from "@/types";

const ACTIVE_VT = "active-vinyl";

interface Props {
  tracks: Track[];
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

export default function MusicShelf({ tracks }: Props) {
  const [activeId, setActiveId] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const audioRef = useRef<HTMLAudioElement>(null);
  const crateRefs = useRef<Record<number, HTMLButtonElement | null>>({});

  const active = tracks.find((track) => track.id === activeId) ?? null;
  const shelf = active ? tracks.filter((track) => track.id !== active.id) : tracks;

  const load = useCallback((track: Track) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.src = track.src;
    audio.currentTime = 0;
    // called straight from the click so iOS keeps the user gesture
    audio.play().catch(() => setPlaying(false));
  }, []);

  const open = useCallback(
    (track: Track) => {
      load(track);
      const commit = () =>
        flushSync(() => {
          setActiveId(track.id);
          setTime(0);
          setDuration(track.duration);
        });

      const source = crateRefs.current[track.id];
      const startViewTransition = document.startViewTransition?.bind(document);

      if (activeId === null && source && startViewTransition) {
        source.style.viewTransitionName = ACTIVE_VT;
        const transition = startViewTransition(commit);
        transition.finished.finally(() => {
          source.style.viewTransitionName = "";
        });
        return;
      }

      commit();
    },
    [activeId, load],
  );

  const step = useCallback(
    (delta: number) => {
      if (!active) return;
      const index = tracks.findIndex((track) => track.id === active.id);
      const next = tracks[(index + delta + tracks.length) % tracks.length];
      open(next);
    },
    [active, open, tracks],
  );

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      audio.play().catch(() => setPlaying(false));
    } else {
      audio.pause();
    }
  }, []);

  const close = useCallback(() => {
    audioRef.current?.pause();
    setActiveId(null);
    setPlaying(false);
  }, []);

  useEffect(() => {
    if (!active || !("mediaSession" in navigator)) return;

    navigator.mediaSession.metadata = new MediaMetadata({
      title: active.title,
      artist: active.artist,
      artwork: active.cover ? [{ src: active.cover, sizes: "360x360", type: "image/jpeg" }] : [],
    });

    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ["play", () => audioRef.current?.play()],
      ["pause", () => audioRef.current?.pause()],
      ["previoustrack", () => step(-1)],
      ["nexttrack", () => step(1)],
    ];

    for (const [action, handler] of handlers) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        // action unsupported in this browser, nothing to do
      }
    }
  }, [active, step]);

  const seek = (event: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current;
    if (!audio) return;
    const next = Number(event.target.value);
    audio.currentTime = next;
    setTime(next);
  };

  return (
    <div className="flex w-full flex-col items-center gap-10">
      <audio
        ref={audioRef}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
        onEnded={() => step(1)}
      />

      {active && (
        <section className="flex w-full flex-col items-center gap-5">
          <div className="w-full max-w-[19rem]">
            <Vinyl track={active} spinning={playing} viewTransitionName={ACTIVE_VT} />
          </div>

          <div className="flex w-full max-w-sm flex-col items-center gap-1 text-center">
            <h2 className="text-2xl font-medium leading-tight">{active.title}</h2>
            <p className="text-sm text-secondary-text">
              {active.artist} · {active.date.slice(0, 4)}
            </p>
          </div>

          <div className="flex w-full max-w-sm items-center gap-3 font-mono text-xs text-secondary-text">
            <span className="tabular-nums">{formatTime(time)}</span>
            <input
              className="vinyl-seek grow"
              type="range"
              min={0}
              max={duration || active.duration}
              step={0.1}
              value={Math.min(time, duration || active.duration)}
              onChange={seek}
              aria-label={`Seek within ${active.title}`}
            />
            <span className="tabular-nums">{formatTime(duration || active.duration)}</span>
          </div>

          <div className="flex items-center gap-5 text-xl">
            <button
              type="button"
              className="text-secondary-text hover:opacity-70"
              onClick={() => step(-1)}
              aria-label="Previous track"
            >
              <FiSkipBack />
            </button>
            <button
              type="button"
              className="active-bg flex h-12 w-12 items-center justify-center rounded-full"
              onClick={toggle}
              aria-pressed={playing}
              aria-label={playing ? "Pause" : "Play"}
            >
              {playing ? <FiPause /> : <FiPlay className="ml-0.5" />}
            </button>
            <button
              type="button"
              className="text-secondary-text hover:opacity-70"
              onClick={() => step(1)}
              aria-label="Next track"
            >
              <FiSkipForward />
            </button>
            <button
              type="button"
              className="text-secondary-text hover:opacity-70"
              onClick={close}
              aria-label="Back to all records"
            >
              <FiX />
            </button>
          </div>
        </section>
      )}

      <section className="flex w-full flex-col gap-4">
        {active && <h3 className="font-mono text-xs uppercase tracking-widest text-secondary-text">more records</h3>}
        <ul className="grid w-full grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-3">
          {shelf.map((track) => (
            <li key={track.id}>
              <button
                type="button"
                ref={(element) => {
                  crateRefs.current[track.id] = element;
                }}
                className="group flex w-full flex-col gap-2 text-left"
                onClick={() => open(track)}
              >
                <Vinyl track={track} className="transition-transform duration-200 group-hover:scale-[1.04]" />
                <span className="truncate text-sm font-medium">{track.title}</span>
                <span className="-mt-2 font-mono text-xs text-secondary-text">{formatTime(track.duration)}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
