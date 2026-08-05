import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { FiPause, FiPlay, FiSkipBack, FiSkipForward, FiX } from "react-icons/fi";
import { Vinyl } from "@/components/Vinyl";
import { ScratchDeck } from "@/lib/scratch";
import type { Track } from "@/types";

const ACTIVE_VT = "active-vinyl";
const DECK_EXIT_MS = 180;
const SPIN_UP_MS = 700;
const SPIN_DOWN_MS = 900;
// one full turn of the record moves the audio by one turn's worth of groove,
// matching --vinyl-rpm so the hand, the label and the sound all agree
const SECONDS_PER_TURN = 1.8;
// a few degrees of slack so tapping the record does not interrupt playback
const ENGAGE_RADIANS = 0.06;
const MAX_SCRATCH_RATE = 8;

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
  const [activeId, setActiveId] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [animateEnter, setAnimateEnter] = useState(false);
  const [closing, setClosing] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [scrubAngle, setScrubAngle] = useState(0);
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
  const spinReadyFor = useRef<number | null>(null);
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

      const opening = activeId === null;
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const source = crateRefs.current[track.id];
      const startViewTransition = document.startViewTransition?.bind(document);
      // the morph replaces the staggered enter, so only one of them ever runs
      const morph = opening && !reduced && Boolean(source) && Boolean(startViewTransition);

      const commit = () =>
        flushSync(() => {
          setActiveId(track.id);
          setTime(0);
          setDuration(track.duration);
          setScrubAngle(0);
          setAnimateEnter(opening && !morph && !reduced);
        });

      if (morph && source && startViewTransition) {
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
    // a decoded track is tens of megabytes, so let it go with the deck
    deck?.unload();
    if (prefersReducedMotion()) {
      setActiveId(null);
      setPlaying(false);
      return;
    }
    // let the deck animate out before it leaves the tree
    setClosing(true);
    window.setTimeout(() => {
      setClosing(false);
      setActiveId(null);
      setPlaying(false);
    }, DECK_EXIT_MS);
  }, []);

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

  // a turntable takes a moment to reach speed, and coasts down when it stops
  useEffect(() => {
    let frame = 0;
    const target = playing && !scrubbing ? 1 : 0;

    const ramp = (spin: Animation) => {
      // a record that just landed on the platter is always at rest first
      if (spinReadyFor.current !== activeId) {
        spin.playbackRate = 0;
        spinReadyFor.current = activeId;
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
  }, [playing, activeId, scrubbing]);

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
        <section
          className={`flex w-full flex-col items-center gap-5 ${animateEnter ? "deck-enter" : ""} ${closing ? "deck-exit" : ""}`}
        >
          <div className="w-full max-w-[19rem]" ref={deckRef}>
            <Vinyl
              track={active}
              deck
              spinning={playing}
              scrubbing={scrubbing}
              scrubAngle={scrubAngle}
              viewTransitionName={ACTIVE_VT}
              onPointerDown={grabRecord}
              onPointerMove={turnRecord}
              onPointerUp={releaseRecord}
            />
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
            <button
              type="button"
              className="text-secondary-text transition-transform hover:opacity-70 active:scale-[0.96]"
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
        <ul className="shelf grid w-full grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-3">
          {shelf.map((track) => (
            <li key={track.id}>
              <button
                type="button"
                ref={(element) => {
                  crateRefs.current[track.id] = element;
                }}
                className="crate-item flex w-full flex-col gap-2 text-left transition-transform active:scale-[0.96]"
                onClick={() => open(track)}
              >
                <Vinyl track={track} />
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
