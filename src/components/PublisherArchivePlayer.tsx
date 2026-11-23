import { useEffect, useRef, useState } from "react";
import {
  CloseIcon,
  MaximizeIcon,
  MinimizeIcon,
  PauseIcon,
  PlayIcon,
  VolumeIcon,
  VolumeMuteIcon,
} from "@/components/icons";
import { composeLut, parseCube } from "../../scripts/grade/color.mjs";
import { Viewer } from "../../scripts/grade/ui/viewer.mjs";
import type { ArchivedClip, ArchivedSettings } from "@/lib/publisher/archive-tab";
import {
  clipNumber,
  clock,
  type Cue,
  cueAt,
  defaultLook,
  fileSize,
  fileUrl,
  type Look,
  nameTime,
  ownGrade,
  parseVtt,
  PROFILES,
  stemOf,
  watchCost,
} from "@/lib/publisher/archive-view";
import type { LedgerClip } from "@/lib/publisher/ledger";

interface Props {
  clip: ArchivedClip;
  day: string;
  record: LedgerClip | undefined;
  request: (path: string) => Promise<any>;
  onClose: () => void;
  /** Opens the clip in the Grade tab, whose Cloudflare list brings it to the Mac. */
  onGrade: () => void;
}

type LookChoice = "log" | "default" | "grade";
const LOOK_KEY = "publisher.archiveLook";
const LOOKS: { id: LookChoice; name: string }[] = [
  { id: "log", name: "Log" },
  { id: "default", name: "Default look" },
  { id: "grade", name: "Its grade" },
];

/* Read once a page: the settings backup, and its files (grades, export records, looks), by their hashes. */
let settingsRead: Promise<ArchivedSettings> | null = null;
const filesRead = new Map<string, Promise<any>>();
function readSettings(request: Props["request"]) {
  settingsRead ??= request("archive/settings").catch((error) => {
    settingsRead = null;
    throw error;
  });
  return settingsRead;
}
function readFile(sha256: string, name: string, parse: (response: Response) => Promise<unknown>) {
  if (!filesRead.has(sha256))
    filesRead.set(
      sha256,
      fetch(fileUrl(sha256, name))
        .then((response) => {
          if (!response.ok) throw new Error(`The archive answered ${response.status}`);
          return parse(response);
        })
        .catch((error) => {
          filesRead.delete(sha256);
          throw error;
        }),
    );
  return filesRead.get(sha256) as Promise<any>;
}
const readCube = (sha256: string, name: string) =>
  readFile(sha256, name, async (response) => parseCube(await response.text())) as Promise<ReturnType<typeof parseCube>>;

/** The camera's 10-bit HEVC, which Safari and Chrome or Edge on a Mac decode in hardware, and Firefox doesn't. */
function playsHevc(file: string) {
  if (!/\.(mp4|mov)$/i.test(file)) return true;
  const video = document.createElement("video");
  return ['video/mp4; codecs="hvc1.2.4.L153.B0"', 'video/mp4; codecs="hev1.2.4.L153.B0"'].some(
    (type) => video.canPlayType(type) !== "",
  );
}

const signed = (value: number, digits = 1) => `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
/** A grade in words: "Velvia, +0.3 stops, 5200 K, saturation 1.20". */
function gradeWords(name: string, grade: Record<string, any>) {
  const parts = [name];
  if (grade.exposure) parts.push(`${signed(grade.exposure)} stops`);
  if (grade.kelvin) parts.push(`${Math.round(grade.kelvin)} K`);
  if (grade.tint) parts.push(`tint ${signed(grade.tint, 0)}`);
  if (grade.contrast !== 1) parts.push(`contrast ${grade.contrast.toFixed(2)}`);
  if (grade.saturation !== 1) parts.push(`saturation ${grade.saturation.toFixed(2)}`);
  return parts.join(", ");
}

/**
 * A clip of the archive, in a player that streams the original from Cloudflare (nothing is read until Watch), with its
 * transcript beside it and as captions, and a Look: as shot, the default look, or its own grade, applied live on this
 * browser's GPU from the small LUTs the grade app backs up, the way its own preview does.
 */
export default function PublisherArchivePlayer({ clip, day, record, request, onClose, onGrade }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const track = useRef<HTMLTrackElement>(null);
  const lines = useRef<HTMLOListElement>(null);
  const viewer = useRef<InstanceType<typeof Viewer> | null>(null);
  const [webgl, setWebgl] = useState(true);
  const [hevc, setHevc] = useState(true);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [failure, setFailure] = useState("");
  const [playing, setPlaying] = useState(false);
  const [framed, setFramed] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(record?.duration ?? 0);
  const [muted, setMuted] = useState(false);
  const [captions, setCaptions] = useState(true);
  const [full, setFull] = useState(false);
  // Where watching starts: a transcript line picked before it began.
  const [startAt, setStartAt] = useState(0);
  const [cues, setCues] = useState<Cue[] | null>(null);
  const [cuesError, setCuesError] = useState<string | null>(null);
  const [settings, setSettings] = useState<ArchivedSettings | null>(null);
  const [grades, setGrades] = useState<Record<string, Record<string, unknown>> | null>(null);
  const [exportsRead, setExportsRead] = useState<Record<string, { cameraKelvin?: number | null }> | null>(null);
  const [look, setLook] = useState<LookChoice>(() => {
    try {
      const saved = localStorage.getItem(LOOK_KEY);
      return LOOKS.some((option) => option.id === saved) ? (saved as LookChoice) : "log";
    } catch {
      return "log";
    }
  });
  const [lookNote, setLookNote] = useState<{ text: string; problem?: boolean }>({ text: "" });
  const profile = record?.profile ?? null;
  const vttUrl = clip.vtt ? fileUrl(clip.vtt, `${stemOf(clip.file)}.vtt`) : null;

  useEffect(() => {
    dialog.current?.showModal();
    setHevc(playsHevc(clip.file));
    const element = video.current;
    try {
      viewer.current = new Viewer(canvas.current);
      viewer.current.setMode(1);
      viewer.current.attach(element);
    } catch {
      setWebgl(false);
    }
    const fullscreen = () => setFull(document.fullscreenElement === screen.current);
    document.addEventListener("fullscreenchange", fullscreen);
    return () => {
      document.removeEventListener("fullscreenchange", fullscreen);
      // Stop reading the clip at once: every byte read from the archive is paid for.
      if (element) {
        element.pause();
        element.removeAttribute("src");
        element.load();
      }
      if (viewer.current) {
        viewer.current.video = null;
        viewer.current.gl.getExtension("WEBGL_lose_context")?.loseContext();
      }
    };
  }, [clip.file]);

  // The transcript, as filed beside the clip.
  useEffect(() => {
    if (!clip.vtt) return;
    let active = true;
    readFile(clip.vtt, `${stemOf(clip.file)}.vtt`, async (response) => parseVtt(await response.text()))
      .then((read: Cue[]) => active && setCues(read))
      .catch((error: Error) => active && setCuesError(error.message));
    return () => {
      active = false;
    };
  }, [clip.vtt, clip.file]);
  // The captions track shows through the player's own line, over the picture whichever look it has.
  useEffect(() => {
    const text = track.current?.track;
    if (text) text.mode = "hidden";
  });

  // The settings backup: the clip's grade, its export record, and the looks.
  useEffect(() => {
    let active = true;
    readSettings(request)
      .then(async (read) => {
        if (!active) return;
        setSettings(read);
        const clipsOf = async (path: string) => {
          const file = read.files[path];
          if (!file) return {};
          const data = await readFile(file.sha256, path, (response) => response.json());
          return (data?.clips ?? {}) as Record<string, any>;
        };
        const [gradesRead, recordsRead] = await Promise.all([clipsOf("grades.json"), clipsOf("exports.json")]);
        if (!active) return;
        setGrades(gradesRead);
        setExportsRead(recordsRead);
      })
      .catch(
        (error: Error) => active && setLookNote({ text: `Couldn't read the looks: ${error.message}`, problem: true }),
      );
    return () => {
      active = false;
    };
  }, [request]);

  const noWebgl: Look = { ok: false, why: "This browser has no WebGL2" };
  const available: Record<LookChoice, Look> = {
    log: { ok: true, path: null, grade: null, shotK: null, name: "log" },
    default: webgl ? defaultLook(profile, settings) : noWebgl,
    grade: webgl ? ownGrade(clip, profile, settings, grades, exportsRead) : noWebgl,
  };
  const chosen = available[look];
  const shown: LookChoice = chosen.ok ? look : "log";
  // A look picked before that can't be shown for this clip says why, and the clip is shown as shot.
  const why = chosen.ok ? null : chosen.why;
  const lutKey = chosen.ok ? `${chosen.path}\n${JSON.stringify(chosen.grade)}\n${chosen.shotK}` : "";
  // The look, as a LUT on the GPU: the default look's as backed up, or its grade composed over its look's.
  // biome-ignore lint/correctness/useExhaustiveDependencies: lutKey stands for what the look is made of
  useEffect(() => {
    const gpu = viewer.current;
    const profileName = profile ? PROFILES[profile] : "its profile";
    if (!gpu || shown === "log") {
      gpu?.setMode(1);
      setLookNote({ text: why ?? `As shot, in ${profileName}: flat until it's graded.` });
      return;
    }
    if (!chosen.ok) return;
    let active = true;
    setLookNote({ text: "Loading the look…" });
    (async () => {
      const file = chosen.path ? settings?.files[chosen.path] : null;
      const base =
        file && chosen.path ? await readCube(file.sha256, chosen.path.split("/").pop() ?? "look.cube") : null;
      if (!active) return;
      const name = base?.title?.split(" · ")[0] || (chosen.name === "none" ? "As shot" : chosen.name);
      if (shown === "default" && base) {
        gpu.setLut(base.size, base.data);
        setLookNote({ text: `${profileName} through ${name}, live on this browser's GPU.` });
      } else {
        const size = 33;
        gpu.setLut(size, composeLut({ profile, grade: chosen.grade, shotK: chosen.shotK, base, size }));
        setLookNote({ text: `Its grade: ${gradeWords(name, chosen.grade ?? {})}.` });
      }
      gpu.setMode(0);
    })().catch(
      (error: Error) => active && setLookNote({ text: `Couldn't load the look: ${error.message}`, problem: true }),
    );
    return () => {
      active = false;
    };
  }, [shown, lutKey, why, settings, profile]);

  function choose(next: LookChoice) {
    setLook(next);
    try {
      localStorage.setItem(LOOK_KEY, next);
    } catch {}
  }

  function watch() {
    const element = video.current;
    if (!element) return;
    setState("loading");
    setFailure("");
    element.src = `${fileUrl(clip.sha256, clip.file)}${startAt ? `#t=${startAt}` : ""}`;
    element.play().catch(() => {});
  }
  function failed() {
    const code = video.current?.error?.code;
    // A source the browser can't play, or can't decode, is the browser's; anything else, the archive or the network.
    if (code !== 3 && code !== 4) setFailure("Couldn't read it from the archive.");
    else if (hevc) setFailure("This browser couldn't decode it.");
    else setFailure("This browser can't play HEVC, which the camera records.");
    setState("failed");
  }
  /** Goes to `at`, playing from there when asked; before watching, it's where watching starts. */
  function seek(at: number, play = false) {
    const element = video.current;
    if (state === "ready" && element) {
      element.currentTime = at;
      if (play) void element.play().catch(() => {});
    } else setStartAt(at);
  }

  const now = state === "idle" || state === "failed" ? startAt : time;
  const active = cues ? cueAt(cues, now) : -1;
  // The line being said stays in view in the transcript, which scrolls by itself, never the page.
  useEffect(() => {
    const list = lines.current;
    const item = list?.children[active] as HTMLElement | undefined;
    if (!list || !item) return;
    const top = item.offsetTop;
    if (top < list.scrollTop || top + item.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = Math.max(0, top - list.clientHeight / 3);
  }, [active]);

  const recorded = record?.recorded ? record.recorded.slice(11, 19) : nameTime(clip.file);
  const here = Boolean(record?.original.mac || record?.original.camera);
  const ready = state === "ready";
  let watchLabel = "Watch";
  if (state === "failed") watchLabel = "Try again";
  else if (!hevc) watchLabel = "Try anyway";
  if (startAt) watchLabel += ` from ${clock(startAt)}`;
  let transcriptNote = "Reading…";
  if (!clip.vtt) transcriptNote = "No transcript is filed for it.";
  else if (cuesError) transcriptNote = `Couldn't read it: ${cuesError}`;
  else if (cues) transcriptNote = "Nobody speaks in it.";

  return (
    <dialog
      ref={dialog}
      className="publisher-archive-player"
      aria-labelledby="publisher-archive-player-title"
      onClose={onClose}
    >
      <div className="publisher-archive-player-head">
        <h2 id="publisher-archive-player-title">
          Clip {clipNumber(clip.file)}
          <small>
            {new Date(`${day}T12:00:00`).toLocaleDateString("en-GB", {
              day: "numeric",
              month: "short",
              year: "numeric",
            })}
            {recorded ? `, ${recorded}` : ""} · {fileSize(clip.size)} ·{" "}
            {profile ? PROFILES[profile] : "Profile unknown"}
          </small>
        </h2>
        <button
          type="button"
          className="publisher-archive-bring"
          title="Opens it in the Grade tab's Cloudflare list, where Bring to Mac takes it"
          onClick={onGrade}
        >
          {here ? "Open in Grade" : "Bring to Mac"}
        </button>
        <button type="button" aria-label="Close" onClick={() => dialog.current?.close()}>
          <CloseIcon size={16} />
        </button>
      </div>
      <div className="publisher-archive-player-body">
        <div className="publisher-archive-watch">
          <div ref={screen} className="publisher-archive-screen">
            <div className="publisher-archive-stage">
              {record?.thumb && !framed && (
                <img src={`/api/publisher/footage/thumbs/${encodeURIComponent(stemOf(clip.file))}.jpg`} alt="" />
              )}
              <canvas ref={canvas} hidden={!webgl} aria-label="Picture" />
              {/* biome-ignore lint/a11y/useMediaCaption: its transcript is its captions track, when one is filed */}
              <video
                ref={video}
                className={webgl ? undefined : "shown"}
                preload="none"
                playsInline
                onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || duration)}
                onLoadedData={() => setFramed(true)}
                onPlaying={() => {
                  setState("ready");
                  setFramed(true);
                }}
                onCanPlay={() => setState((now) => (now === "loading" ? "ready" : now))}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
                onVolumeChange={(event) => setMuted(event.currentTarget.muted)}
                onError={() => state !== "idle" && failed()}
              >
                {vttUrl && <track ref={track} kind="captions" label="Transcript" src={vttUrl} default />}
              </video>
              {/* A line of its own for each line said, so one never slides into the next's place. */}
              {captions && active >= 0 && cues && ready && (
                <p key={active} className="publisher-archive-caption">
                  {cues[active].text}
                </p>
              )}
              {!ready && (
                <div className="publisher-archive-overlay">
                  {state === "loading" ? (
                    <p>Loading…</p>
                  ) : (
                    <>
                      {state === "failed" && <p>{failure}</p>}
                      {state === "idle" && !hevc && (
                        <p>
                          This browser can't play HEVC, which the camera records. Safari, or Chrome or Edge on a Mac,
                          plays it; or bring it to the Mac.
                        </p>
                      )}
                      <button type="button" onClick={watch}>
                        <PlayIcon size={16} />
                        {watchLabel}
                      </button>
                      <small>Reads up to {watchCost(clip.size)}, from Cloudflare</small>
                    </>
                  )}
                </div>
              )}
            </div>
            <div className="publisher-archive-controls">
              <button
                type="button"
                aria-label={playing ? "Pause" : "Play"}
                disabled={!ready}
                onClick={() => (playing ? video.current?.pause() : void video.current?.play().catch(() => {}))}
              >
                {playing ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
              </button>
              <input
                type="range"
                aria-label="Position"
                min={0}
                max={duration || 1}
                step={0.01}
                value={Math.min(now, duration || 1)}
                disabled={!ready}
                onChange={(event) => seek(Number(event.currentTarget.value))}
              />
              <span className="publisher-archive-time">
                {clock(now)} / {clock(duration)}
              </span>
              <button
                type="button"
                aria-pressed={captions}
                aria-label="Captions"
                disabled={!cues?.length}
                onClick={() => setCaptions((on) => !on)}
              >
                CC
              </button>
              <button
                type="button"
                aria-label={muted ? "Unmute" : "Mute"}
                disabled={!ready}
                onClick={() => {
                  if (video.current) video.current.muted = !video.current.muted;
                }}
              >
                {muted ? <VolumeMuteIcon size={16} /> : <VolumeIcon size={16} />}
              </button>
              <button
                type="button"
                aria-label={full ? "Leave full screen" : "Full screen"}
                onClick={() =>
                  full
                    ? void document.exitFullscreen().catch(() => {})
                    : void screen.current?.requestFullscreen().catch(() => {})
                }
              >
                {full ? <MinimizeIcon size={16} /> : <MaximizeIcon size={16} />}
              </button>
            </div>
          </div>
          <fieldset className="publisher-archive-looks">
            <legend>Look</legend>
            <div role="group" aria-label="Look">
              {LOOKS.map((option) => {
                const can = available[option.id];
                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={shown === option.id}
                    disabled={!can.ok}
                    title={can.ok ? undefined : can.why}
                    onClick={() => choose(option.id)}
                  >
                    {option.name}
                  </button>
                );
              })}
            </div>
            <p className="publisher-note" data-problem={lookNote.problem || undefined}>
              {lookNote.text}
            </p>
          </fieldset>
        </div>
        <aside className="publisher-archive-transcript" aria-label="Transcript">
          <h3>Transcript</h3>
          {cues?.length ? (
            <ol ref={lines}>
              {cues.map((cue, i) => (
                <li key={`${cue.start}-${i}`}>
                  <button type="button" aria-current={i === active || undefined} onClick={() => seek(cue.start, true)}>
                    <time>{clock(cue.start)}</time>
                    <span>{cue.text}</span>
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="publisher-note">{transcriptNote}</p>
          )}
        </aside>
      </div>
    </dialog>
  );
}
