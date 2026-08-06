import { useCallback, useEffect, useRef, useState } from "react";
import { FiPause, FiPlay, FiSkipBack, FiSkipForward } from "react-icons/fi";
import { LyricsPanel } from "@/components/LyricsPanel";
import { Scrollable } from "@/components/Scrollable";
import { Vinyl } from "@/components/Vinyl";
import { langFor } from "@/lib/script";
import { ScratchDeck } from "@/lib/scratch";
import type { Track } from "@/types";

const SPIN_UP_MS = 700;
const SPIN_DOWN_MS = 900;
// one full turn of the record moves the audio by one turn's worth of groove,
// matching --vinyl-rpm so the hand, the label and the sound all agree
const SECONDS_PER_TURN = 1.8;
// a few degrees of slack so tapping the record does not interrupt playback
const ENGAGE_RADIANS = 0.06;
const MAX_SCRATCH_RATE = 8;
// a jump spins the record, but only so far before it is just a smear
const SEEK_TURN_CAP = 3;
const SEEK_SPIN_MS = 620;

type Filter = "all" | "cover" | "original";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "all" },
  { key: "cover", label: "covers" },
  { key: "original", label: "originals" },
];

interface Props {
  tracks: Track[];
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

export default function MusicShelf({ tracks }: Props) {
  // a record is always on the platter, cued but silent until asked
  const [activeSlug, setActiveSlug] = useState<string | null>(tracks[0]?.slug ?? null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);
  const [scrubAngle, setScrubAngle] = useState(0);
  const [seeking, setSeeking] = useState(false);
  const seekTimer = useRef(0);
  const [filter, setFilter] = useState<Filter>("all");
  const [lyricsFocus, setLyricsFocus] = useState(true);
  const scrub = useRef<{
    pointerId: number;
    lastAngle: number;
    startTime: number;
    resumeAfter: boolean;
    turned: number;
    engaged: boolean;
    lastMove: number;
    stillTimer: number;
  } | null>(null);
  const scratchPosition = useRef(0);
  const scratchDeck = useRef<ScratchDeck | null>(null);
  if (!scratchDeck.current && typeof window !== "undefined") scratchDeck.current = new ScratchDeck();
  const deck = scratchDeck.current as ScratchDeck;

  const audioRef = useRef<HTMLAudioElement>(null);
  const deckRef = useRef<HTMLDivElement>(null);
  const spinReadyFor = useRef<string | null>(null);

  const active = tracks.find((track) => track.slug === activeSlug) ?? null;
  const shown = filter === "all" ? tracks : tracks.filter((track) => track.kind === filter);
  // stepping stays inside whatever the listener filtered to
  const walk = shown.length > 0 ? shown : tracks;

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
      setActiveSlug(track.slug);
      setTime(0);
      setDuration(track.duration);
      setScrubAngle(0);
    },
    [load],
  );

  const step = useCallback(
    (delta: number) => {
      if (!active) return;
      const index = walk.findIndex((track) => track.slug === active.slug);
      const from = index === -1 ? 0 : index;
      const next = walk[(from + delta + walk.length) % walk.length];
      open(next);
    },
    [active, open, walk],
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

  // the cued record is loaded but never auto-played
  useEffect(() => {
    const audio = audioRef.current;
    if (audio && !audio.src && active) audio.src = active.src;
  }, [active]);

  // decode the open record in the background so the first grab can make sound
  useEffect(() => {
    if (!active || !deck) return;
    scratchPosition.current = 0;
    deck.onPosition = (seconds) => {
      scratchPosition.current = seconds;
      // while scratching the worklet owns the needle, so the clock follows it
      if (scrub.current?.engaged) setTime(seconds);
    };
    deck.load(active.src);
    return () => {
      deck.setRate(0);
    };
  }, [active, deck]);

  // a decoded track is tens of megabytes, so never leave one behind
  useEffect(() => () => deck?.unload(), [deck]);

  // a turntable takes a moment to reach speed, and coasts down when it stops
  useEffect(() => {
    let frame = 0;
    const target = playing && !scrubbing ? 1 : 0;

    const ramp = (spin: Animation) => {
      // a record that just landed on the platter is always at rest first
      if (spinReadyFor.current !== active?.slug) {
        spin.playbackRate = 0;
        spinReadyFor.current = active?.slug ?? null;
      }

      // a hand on the record stops it dead, it does not coast
      if (scrubbing || prefersReducedMotion()) {
        spin.playbackRate = target;
        return;
      }

      const from = spin.playbackRate;
      if (from === target) return;

      const duration = target > from ? SPIN_UP_MS : SPIN_DOWN_MS;
      const started = performance.now();

      const tick = (now: number) => {
        const progress = Math.min(1, (now - started) / duration);
        const eased = 1 - (1 - progress) ** 3;
        spin.playbackRate = from + (target - from) * eased;
        if (progress < 1) frame = requestAnimationFrame(tick);
      };

      frame = requestAnimationFrame(tick);
    };

    // the CSS animation is not registered on the very first frame after mount
    const findSpin = () => {
      const disc = deckRef.current?.querySelector<HTMLElement>(".vinyl-disc");
      const spin = disc?.getAnimations().find((animation) => animation.playState !== "idle");
      if (spin) {
        ramp(spin);
        return;
      }
      if (deckRef.current) frame = requestAnimationFrame(findSpin);
    };

    findSpin();
    return () => cancelAnimationFrame(frame);
  }, [playing, activeSlug, scrubbing, active]);

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

  const angleAt = (element: HTMLElement, clientX: number, clientY: number) => {
    const box = element.getBoundingClientRect();
    return Math.atan2(clientY - (box.top + box.height / 2), clientX - (box.left + box.width / 2));
  };

  const grabRecord = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!active) return;
    const audio = audioRef.current;
    event.currentTarget.setPointerCapture(event.pointerId);
    scrub.current = {
      pointerId: event.pointerId,
      lastAngle: angleAt(event.currentTarget, event.clientX, event.clientY),
      startTime: audio?.currentTime ?? 0,
      resumeAfter: Boolean(audio && !audio.paused),
      turned: 0,
      engaged: false,
      lastMove: event.timeStamp || performance.now(),
      stillTimer: 0,
    };
    // playback keeps running until the record is actually turned, so a tap is inert
  };

  const turnRecord = (event: React.PointerEvent<HTMLDivElement>) => {
    const grip = scrub.current;
    if (!grip || grip.pointerId !== event.pointerId || !active) return;

    const angle = angleAt(event.currentTarget, event.clientX, event.clientY);
    let delta = angle - grip.lastAngle;
    // crossing the -PI/PI seam should not read as a full turn backwards
    if (delta > Math.PI) delta -= 2 * Math.PI;
    if (delta < -Math.PI) delta += 2 * Math.PI;

    const now = event.timeStamp || performance.now();
    grip.lastAngle = angle;
    grip.turned += delta;

    const audio = audioRef.current;

    if (!grip.engaged) {
      if (Math.abs(grip.turned) < ENGAGE_RADIANS) return;
      grip.engaged = true;
      grip.turned = 0;
      grip.lastMove = now;
      grip.startTime = audio?.currentTime ?? grip.startTime;
      audio?.pause();
      setScrubbing(true);
      // hand the needle over to the worklet, which can run backwards
      if (deck.isLoaded) {
        deck.resume();
        deck.seek(grip.startTime);
      }
      return;
    }

    setScrubAngle((previous) => previous + delta);

    const total = duration || active.duration;
    const next = Math.min(total, Math.max(0, grip.startTime + (grip.turned / (2 * Math.PI)) * SECONDS_PER_TURN));

    if (deck.isLoaded) {
      // hand speed in turns per second, geared to the record's own rate
      const elapsed = Math.max(4, now - grip.lastMove) / 1000;
      grip.lastMove = now;
      const rate = ((delta / (2 * Math.PI)) * SECONDS_PER_TURN) / elapsed;
      // no hand can spin a platter faster than this, and past it it is just noise
      deck.setRate(Math.max(-MAX_SCRATCH_RATE, Math.min(MAX_SCRATCH_RATE, rate)));
      clearTimeout(grip.stillTimer);
      // a hand resting on the record holds it silent
      grip.stillTimer = window.setTimeout(() => deck.setRate(0), 90);
      return;
    }

    if (!audio) return;
    audio.currentTime = next;
    setTime(next);
  };

  const releaseRecord = (event: React.PointerEvent<HTMLDivElement>) => {
    const grip = scrub.current;
    if (!grip) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    scrub.current = null;
    if (!grip.engaged) return;

    clearTimeout(grip.stillTimer);
    setScrubbing(false);

    const audio = audioRef.current;
    if (deck.isLoaded) {
      deck.setRate(0);
      // the worklet owns the true position while scratching, so hand it back
      if (audio) audio.currentTime = scratchPosition.current;
      setTime(scratchPosition.current);
    }

    if (grip.resumeAfter) audio?.play().catch(() => setPlaying(false));
  };

  const seekTo = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;

    const delta = seconds - audio.currentTime;
    audio.currentTime = seconds;
    setTime(seconds);

    if (prefersReducedMotion()) return;

    // the record turns by the distance skipped, capped so a long jump is not a blur
    const turns = Math.max(-SEEK_TURN_CAP, Math.min(SEEK_TURN_CAP, delta / SECONDS_PER_TURN));
    setScrubAngle((previous) => previous + turns * 2 * Math.PI);
    setSeeking(true);
    clearTimeout(seekTimer.current);
    seekTimer.current = window.setTimeout(() => setSeeking(false), SEEK_SPIN_MS);
  }, []);

  const seek = (event: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current;
    if (!audio) return;
    const next = Number(event.target.value);
    audio.currentTime = next;
    setTime(next);
  };

  if (!active) return null;

  return (
    <div className="flex w-full grow flex-col">
      <audio
        ref={audioRef}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
        onEnded={() => step(1)}
      />

      <div
        className="grid w-full grow md:h-[calc(100dvh-8rem)] md:min-h-0 md:grid-cols-[24rem_minmax(0,1fr)_24rem]"
      >
        <aside className="lyrics-rail order-last flex w-full min-h-0 flex-col gap-4 p-8 md:order-none md:p-12">
            <h3 className="font-mono text-xs uppercase tracking-widest text-secondary-text">lyrics</h3>
            <div className="flex flex-wrap gap-1.5">
              <label className="filter-chip flex w-fit cursor-pointer select-none items-center gap-2 rounded-full py-1 pl-1 pr-2.5 font-mono text-xs">
              <input
                type="checkbox"
                checked={lyricsFocus}
                onChange={(event) => setLyricsFocus(event.target.checked)}
              />
                focus sync
              </label>
            </div>
            <LyricsPanel track={active} time={time} focus={lyricsFocus} onSeek={seekTo} />
        </aside>

        <section className="flex w-full min-h-0 flex-col items-center justify-center gap-5 p-8">
          <div className="w-full max-w-[min(25rem,42vh)]" ref={deckRef}>
            <Vinyl
              track={active}
              deck
              spinning={playing}
              scrubbing={scrubbing}
              seeking={seeking}
              scrubAngle={scrubAngle}
              onPointerDown={grabRecord}
              onPointerMove={turnRecord}
              onPointerUp={releaseRecord}
            />
          </div>

          <div className="flex w-full max-w-md flex-col items-center gap-1 text-center">
            <h2 lang={langFor(active.title)} className="text-2xl font-medium leading-tight">
              {active.title}
            </h2>
            <p className="text-sm text-secondary-text">
              {[active.artist, active.album, active.date.slice(0, 4)].filter(Boolean).join(" · ")}
            </p>
          </div>

          <div className="flex w-full max-w-md items-center gap-3 font-mono text-xs text-secondary-text">
            <span className="tabular-nums">{formatTime(time)}</span>
            <input
              className="vinyl-seek grow"
              style={{ "--vinyl-progress": `${(time / (duration || active.duration)) * 100}%` } as React.CSSProperties}
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
              className="text-secondary-text transition-transform hover:opacity-70 active:scale-[0.96]"
              onClick={() => step(-1)}
              aria-label="Previous track"
            >
              <FiSkipBack />
            </button>
            <button
              type="button"
              className="play-button flex h-12 w-12 items-center justify-center rounded-full active:scale-[0.96]"
              onClick={toggle}
              aria-pressed={playing}
              aria-label={playing ? "Pause" : "Play"}
            >
              <span className="relative block h-4 w-4">
                <FiPlay className={`icon-swap icon-play ${playing ? "" : "is-shown"}`} />
                <FiPause className={`icon-swap ${playing ? "is-shown" : ""}`} />
              </span>
            </button>
            <button
              type="button"
              className="text-secondary-text transition-transform hover:opacity-70 active:scale-[0.96]"
              onClick={() => step(1)}
              aria-label="Next track"
            >
              <FiSkipForward />
            </button>
          </div>
        </section>

        <aside className="rail flex w-full min-h-0 flex-col gap-4 p-8 md:p-12">
          <h3 className="font-mono text-xs uppercase tracking-widest text-secondary-text">records</h3>

          <div className="flex flex-wrap gap-1.5">
            {FILTERS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                className={`filter-chip rounded-full px-2.5 py-1 font-mono text-xs ${filter === key ? "is-on" : ""}`}
                onClick={() => setFilter(key)}
                aria-pressed={filter === key}
              >
                {label}
              </button>
            ))}
          </div>
          <Scrollable>
          <ul className="queue flex w-full flex-col gap-1">
            {shown.map((track) => (
              <li key={track.slug}>
                <button
                  type="button"
                  className={`queue-item flex w-full items-center gap-3 rounded-lg p-1.5 text-left transition-transform active:scale-[0.98] ${
                    track.slug === activeSlug ? "is-current" : ""
                  }`}
                  onClick={() => open(track)}
                  aria-current={track.slug === activeSlug}
                >
                  <div className="w-12 shrink-0">
                    <Vinyl track={track} spinning={track.slug === activeSlug && playing} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div lang={langFor(track.title)} className="truncate text-sm font-medium leading-tight">
                      {track.title}
                    </div>
                    {(track.originalArtist ?? track.album) && (
                      <div className="truncate text-xs text-secondary-text">
                        {track.originalArtist ?? track.album}
                      </div>
                    )}
                  </div>
                  <span className="shrink-0 font-mono text-xs tabular-nums text-secondary-text">
                    {formatTime(track.duration)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          </Scrollable>
          {shown.length === 0 && (
            <p className="font-mono text-xs text-secondary-text">no {filter === "cover" ? "covers" : "originals"} yet</p>
          )}
        </aside>
      </div>
    </div>
  );
}
