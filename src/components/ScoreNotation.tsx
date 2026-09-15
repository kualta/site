import { MusicCheckbox } from "@/components/MusicCheckbox";
import { useEffect, useRef, useState, type RefObject } from "react";
import { FiDownload, FiMinus, FiPlus } from "react-icons/fi";
import type { AlphaTabApi } from "@coderline/alphatab";
import bravuraUrl from "@coderline/alphatab/font/Bravura.woff2?url";

interface Props {
  source: string;
  title: string;
  audioRef: RefObject<HTMLAudioElement | null>;
  onSeek: (seconds: number) => void;
}

/** Notation follows the persistent audio element; no synthesizer or second player. */
export function ScoreNotation({ source, title, audioRef, onSeek }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const apiRef = useRef<AlphaTabApi | null>(null);
  const seekRef = useRef(onSeek);
  seekRef.current = onSeek;
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  const [zoom, setZoom] = useState(100);
  const [follow, setFollow] = useState(true);
  const preferences = useRef({ zoom, follow });
  preferences.current = { zoom, follow };

  useEffect(() => {
    const abort = new AbortController();
    let disposed = false;
    let cleanup = () => {};
    setState("loading");
    async function load() {
      const [alphaTab, response] = await Promise.all([
        import("@coderline/alphatab"),
        fetch(source, { signal: abort.signal }),
      ]);
      if (!response.ok) throw new Error("Score could not be loaded");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (disposed || !container.current || !scroller.current || !audioRef.current) return;
      const audio = audioRef.current;
      const settings = new alphaTab.Settings();
      settings.core.useWorkers = false;
      settings.core.smuflFontSources = new Map([[alphaTab.FontFileFormat.Woff2, bravuraUrl]]);
      settings.display.staveProfile = alphaTab.StaveProfile.Score;
      for (const element of [
        alphaTab.NotationElement.ScoreTitle,
        alphaTab.NotationElement.ScoreSubTitle,
        alphaTab.NotationElement.ScoreArtist,
        alphaTab.NotationElement.ScoreWords,
        alphaTab.NotationElement.ScoreMusic,
        alphaTab.NotationElement.ScoreWordsAndMusic,
      ]) {
        settings.notation.elements.set(element, false);
      }
      settings.display.scale = preferences.current.zoom / 100;
      settings.player.playerMode = alphaTab.PlayerMode.EnabledExternalMedia;
      settings.player.scrollElement = scroller.current;
      settings.player.scrollMode = preferences.current.follow ? alphaTab.ScrollMode.OffScreen : alphaTab.ScrollMode.Off;
      settings.player.scrollOffsetY = -30;
      const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes, settings);
      const api = new alphaTab.AlphaTabApi(container.current, settings);
      apiRef.current = api;
      const output = api.player!.output as import("@coderline/alphatab").synth.IExternalMediaSynthOutput;
      let ready = false;
      let updatingFromAudio = false;
      output.handler = {
        get backingTrackDuration() {
          return Number.isFinite(audio.duration) ? audio.duration * 1000 : 0;
        },
        get playbackRate() {
          return audio.playbackRate;
        },
        set playbackRate(value) {
          if (audio.playbackRate !== value) audio.playbackRate = value;
        },
        get masterVolume() {
          return audio.volume;
        },
        set masterVolume(value) {
          if (audio.volume !== value) audio.volume = value;
        },
        seekTo(milliseconds) {
          if (ready && !updatingFromAudio) seekRef.current((milliseconds * audio.playbackRate) / 1000);
        },
        play() {
          if (ready && audio.paused) void audio.play().catch(() => api.pause());
        },
        pause() {
          if (ready && !audio.paused) audio.pause();
        },
      };
      let timer = 0;
      const update = () => {
        if (api.endTime <= 0) return;
        // Let the MP3 ring out and advance the queue itself. Reaching alphaTab's
        // musical end would otherwise stop and rewind the shared audio element.
        output.updatePosition(Math.min((audio.currentTime / audio.playbackRate) * 1000, api.endTime - 1));
      };
      const play = () => {
        window.clearInterval(timer);
        update();
        api.play();
        timer = window.setInterval(update, 50);
      };
      const pause = () => {
        window.clearInterval(timer);
        api.pause();
        update();
      };
      const volume = () => {
        if (api.masterVolume !== audio.volume) api.masterVolume = audio.volume;
      };
      const rate = () => {
        if (api.playbackSpeed !== audio.playbackRate) api.playbackSpeed = audio.playbackRate;
        update();
      };
      const seeked = () => {
        if (api.endTime <= 0) return;
        // Mark a real seek so alphaTab renders and reveals distant systems too.
        updatingFromAudio = true;
        try {
          api.timePosition = Math.min((audio.currentTime / audio.playbackRate) * 1000, api.endTime - 1);
        } finally {
          updatingFromAudio = false;
        }
        update();
        // alphaTab queues position and cursor updates on successive frames.
        api.uiFacade.beginInvoke(() =>
          api.uiFacade.beginInvoke(() => {
            if (disposed || !preferences.current.follow) return;
            if (audio.currentTime < 0.1) scroller.current?.scrollTo({ top: 0 });
            else api.scrollToCursor();
          }),
        );
      };
      const listeners = {
        play,
        pause,
        ended: pause,
        timeupdate: update,
        seeked,
        volumechange: volume,
        ratechange: rate,
      };
      for (const [event, handler] of Object.entries(listeners)) audio.addEventListener(event, handler);
      cleanup = () => {
        window.clearInterval(timer);
        for (const [event, handler] of Object.entries(listeners)) audio.removeEventListener(event, handler);
        // Destroying the notation must not stop the shared music player.
        output.handler = undefined;
        api.destroy();
        apiRef.current = null;
      };
      api.error.on(() => {
        if (!disposed) setState("error");
      });
      api.postRenderFinished.on(() => {
        if (!disposed) {
          setState("ready");
          update();
        }
      });
      api.playerReady.on(() => {
        // MIDI loading fires readiness before completing its transport reset.
        // Connect on the next microtask so those initialization seeks cannot
        // rewind audio that was already playing on another page.
        queueMicrotask(() => {
          if (disposed) return;
          volume();
          rate();
          ready = true;
          if (!audio.paused) play();
          else update();
        });
      });
      api.renderScore(score);
    }
    void load().catch((error) => {
      if (!disposed) {
        console.error("Score rendering failed", error);
        setState("error");
      }
    });
    return () => {
      disposed = true;
      abort.abort();
      cleanup();
    };
  }, [source, audioRef, attempt]);

  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    api.settings.display.scale = zoom / 100;
    api.updateSettings();
    api.render();
  }, [zoom]);

  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    // ScrollMode.Off = 0, OffScreen = 2.
    api.settings.player.scrollMode = follow ? 2 : 0;
    api.updateSettings();
  }, [follow]);

  return (
    <div className="score-player">
      <div className="score-toolbar">
        <MusicCheckbox
          label="follow score"
          disabled={state !== "ready"}
          checked={follow}
          onChange={setFollow}
        />
        <div className="score-zoom">
          <button
            type="button"
            aria-label="Zoom out"
            disabled={zoom <= 70 || state !== "ready"}
            onClick={() => setZoom(Math.max(70, zoom - 10))}
          >
            <FiMinus />
          </button>
          <span>{zoom}%</span>
          <button
            type="button"
            aria-label="Zoom in"
            disabled={zoom >= 150 || state !== "ready"}
            onClick={() => setZoom(Math.min(150, zoom + 10))}
          >
            <FiPlus />
          </button>
          <a href={source} download aria-label={`Download ${title} score`}>
            <FiDownload />
          </a>
        </div>
      </div>
      <div
        ref={scroller}
        className="score-scroll pretty-scroll"
        tabIndex={0}
        role="region"
        aria-label={`${title} sheet music`}
        aria-busy={state === "loading"}
      >
        {state === "loading" && (
          <p className="score-message" role="status">
            Loading score…
          </p>
        )}
        {state === "error" && (
          <div className="score-message" role="alert">
            The score couldn’t be displayed.{" "}
            <button type="button" onClick={() => setAttempt((value) => value + 1)}>
              Try again
            </button>
          </div>
        )}
        <div ref={container} className="score-notation" aria-hidden="true" hidden={state === "error"} />
      </div>
    </div>
  );
}
