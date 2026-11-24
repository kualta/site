import { useEffect, useState } from "react";
import {
  formatDuration as duration,
  formatRate as rate,
  formatWhen as when,
  type Paused,
  pausedText,
} from "@/lib/publisher/mac";
import PublisherLedger from "./PublisherLedger";
import PublisherMac from "./PublisherMac";

/** A graded clip as the laptop reports it: up on the footage channel, waiting, or going up now. */
export interface FootageClip {
  name: string;
  title: string;
  size: number;
  from: "exported" | "archive";
  state: "up" | "due" | "uploading";
  /** The clip's video, or for a clip graded again since, its earlier grade's. */
  video: string | null;
  uploadedAt: string | null;
}
export interface FootageStatus {
  at: number;
  channel: string | null;
  daily: number;
  today: number;
  /** `held`: paused from this tab, with the clip in flight, if any, held after its part. */
  state: "uploading" | "waiting" | "done" | "limit" | "paused" | "busy" | "held" | "failed";
  /** Why nothing can go up, while the state is failed. */
  error?: string | null;
  pausedUntil: number | null;
  lastError: { clip: string; message: string; at: string } | null;
  current: { name: string; title: string; size: number; sent: number; from: string } | null;
  /** Bytes a second over the last minute of parts. */
  speed: number | null;
  totals: { up: number; upBytes: number; due: number; dueBytes: number; today: number; todayBytes: number };
  clips: FootageClip[];
}
interface Reply {
  watching: boolean;
  /** How long ago the laptop sent the status. */
  age: number | null;
  /** Everything paused from here, and since when. */
  paused: Paused | null;
  status: FootageStatus | null;
}
interface Props {
  request: (path: string, body?: unknown, method?: string) => Promise<any>;
  online: boolean;
  /** Whether the YouTube footage archive is connected in Accounts. */
  connected: boolean;
  /** Whether the laptop found its profile signed out, which Accounts signs in again. */
  signedOut: boolean;
  onAccounts: () => void;
  /** Opens a clip in the Grade tab. */
  onGrade: (clip: string) => void;
  /** Where a post's numbers are. */
  statsHref: (job: string) => string;
  /** How far the clip going up is, in percent, for the page's title; null with none. */
  onProgress: (percent: number | null) => void;
  /** When the Grade tab asked for This Mac, which is then brought into view. */
  showMac: number | null;
  /** The tab's address query, which holds the clip playing. */
  search: string;
  onNavigate: (search: string, replace?: boolean) => void;
}

/** The laptop reports every 5 seconds during an upload and every 10 otherwise; older than this, it hasn't started. */
const FRESH = 30_000;

const size = (bytes: number) =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.max(0, Math.round(bytes / 1e6))} MB`;
const clipsOf = (count: number, bytes: number) => `${count} ${count === 1 ? "clip" : "clips"} · ${size(bytes)}`;

/** What the network says when a connection is cut: undici's "terminated", a reset, a timeout, a socket hung up. */
const DROPPED = /\b(terminated|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up)\b/i;

/**
 * Why the uploads wait after one failed, and until when, in plain words: the clip (by its title when the status lists
 * it), when it failed and why, the connection dropping said as such, and when the next try is.
 */
export function failedText({
  lastError,
  pausedUntil,
  clips,
}: Pick<FootageStatus, "lastError" | "pausedUntil" | "clips">) {
  const again = `trying again at ${when(pausedUntil ?? Date.now())}`;
  if (!lastError) return `Paused: ${again}`;
  const clip = clips.find((one) => one.name === lastError.clip)?.title ?? lastError.clip;
  const at = Date.parse(lastError.at);
  const time = Number.isFinite(at) ? ` at ${when(at)}` : "";
  if (DROPPED.test(lastError.message)) return `Upload of ${clip} cut off${time}: the connection dropped; ${again}`;
  return `Upload of ${clip} failed${time}: ${lastError.message.replace(/\.$/, "")}; ${again}`;
}

/** What's holding the uploads, or what they're doing, in a line; null while a clip goes up and the bar says it. */
function noticeFor(
  {
    connected,
    signedOut,
    online,
    reply,
    failed,
  }: { connected: boolean; signedOut: boolean; online: boolean; reply: Reply | null; failed: boolean },
  fresh: boolean,
): { text: string; tone?: "ok" | "bad"; accounts?: boolean } | null {
  if (!connected) return { text: "Not connected.", accounts: true };
  if (signedOut) return { text: "Signed out.", tone: "bad", accounts: true };
  if (reply?.paused) return { text: pausedText(reply.paused) };
  if (!online) return { text: "Laptop offline." };
  if (!reply) return failed ? { text: "Couldn't load. Retrying…" } : { text: "Reading…" };
  const status = reply.status;
  if (!status || !fresh) return { text: "Waiting for the laptop…" };
  switch (status.state) {
    case "paused":
      return { text: failedText(status), tone: "bad" };
    case "failed": {
      const error = status.error ?? "Can't upload.";
      // The channel signed out is fixed in Accounts.
      return { text: error, tone: "bad", accounts: /signed out|session is gone|connect/i.test(error) };
    }
    case "limit":
      return { text: "Daily limit reached. More tomorrow." };
    case "busy":
      return { text: "Uploading from the terminal." };
    case "done":
      return { text: "All clips are up.", tone: "ok" };
    case "waiting":
      return { text: "Starting…" };
    default:
      return null;
  }
}

/**
 * The composer's Footage tab: the graded footage going up to the footage archive's YouTube channel, then how the grade
 * app's offload on the Mac stands (This Mac), then the footage ledger (every clip, its grade, where its copies are, and
 * the player for one in the cloud). The
 * laptop uploads only while this tab is open, so it says so on opening and every 30 seconds, and says it closed on
 * leaving.
 */
export default function PublisherFootage({
  request,
  online,
  connected,
  signedOut,
  onAccounts,
  onGrade,
  statsHref,
  onProgress,
  showMac,
  search,
  onNavigate,
}: Props) {
  const [reply, setReply] = useState<Reply | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    const load = async (path: string, body?: unknown) => {
      try {
        const next = (await request(path, body)) as Reply;
        if (!active) return;
        setReply(next);
        setFailed(false);
      } catch {
        if (active) setFailed(true);
      }
    };
    // The answer says how the uploads are going, so a hidden tab's title keeps up.
    const watch = () => load("footage/watch", {});
    // A hidden tab keeps the uploads going but reads nothing; it catches up once it's shown.
    const read = async () => {
      if (!document.hidden) await load("footage");
    };
    // Sent as the page goes away, so it has to outlive it.
    const leave = () => {
      void fetch("/api/publisher/footage/watch", { method: "DELETE", keepalive: true }).catch(() => {});
    };
    const shown = (event: PageTransitionEvent) => {
      if (event.persisted) void watch().then(read);
    };
    const visible = () => {
      if (!document.hidden) void read();
    };
    void watch().then(read);
    const beat = window.setInterval(watch, 30_000);
    const poll = window.setInterval(read, 4_000);
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", shown);
    document.addEventListener("visibilitychange", visible);
    return () => {
      active = false;
      clearInterval(beat);
      clearInterval(poll);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", shown);
      document.removeEventListener("visibilitychange", visible);
      leave();
    };
  }, [request]);

  // Pausing everything, or going on, from here: the answer says how it is now.
  const [pausing, setPausing] = useState(false);
  const [pauseError, setPauseError] = useState<string | null>(null);
  const paused = reply?.paused ?? null;
  async function togglePause() {
    setPausing(true);
    try {
      const answer = (await (paused
        ? request("footage/pause", undefined, "DELETE")
        : request("footage/pause", {}))) as { paused: Paused | null };
      setReply((was) => was && { ...was, paused: answer.paused });
      setPauseError(null);
    } catch (error) {
      setPauseError((error as Error).message);
    } finally {
      setPausing(false);
    }
  }

  const status = reply?.status ?? null;
  const fresh = status !== null && typeof reply?.age === "number" && reply.age < FRESH;
  const notice = noticeFor({ connected, signedOut, online, reply, failed }, fresh);
  const current = fresh && online ? status?.current : null;
  const speed = status?.speed ?? null;
  const share = current?.size ? Math.min(100, Math.floor((current.sent / current.size) * 100)) : 0;
  const clipLeft = current && speed ? (current.size - current.sent) / speed : null;
  const todayLeft = current && speed && status && status.totals.today > 1 ? status.totals.todayBytes / speed : null;
  // Unheard from, the upload may be over, so the title lets go of it; paused, it isn't going up.
  const percent = current && !failed && !paused ? share : null;
  useEffect(() => {
    onProgress(percent);
    return () => onProgress(null);
  }, [onProgress, percent]);

  // What each figure says while a clip goes up; otherwise there's nothing to say.
  let [sent, pace, left] = ["—", "—", "—"];
  if (current) {
    sent = `${size(current.sent)} of ${size(current.size)}`;
    pace = speed ? rate(speed) : "Measuring…";
    left = clipLeft !== null ? duration(clipLeft) : "Measuring…";
  }

  return (
    <section className="publisher-archive" aria-label="Footage">
      <div className="publisher-heading">
        <h1>Footage</h1>
        {/* Everything: the offload, transcripts and exports on the Mac, and the uploads to YouTube. */}
        <button
          type="button"
          className="publisher-pause"
          aria-pressed={Boolean(paused)}
          disabled={!reply || pausing}
          title={
            pauseError ?? (paused ? "Go on with everything" : "Pause the offload, transcripts, exports and uploads")
          }
          onClick={togglePause}
        >
          {paused ? "Resume all" : "Pause all"}
        </button>
        {status?.channel && (
          <a
            className="publisher-archive-channel"
            href={`https://www.youtube.com/${status.channel}`}
            target="_blank"
            rel="noreferrer"
          >
            Channel
          </a>
        )}
      </div>
      {/* One panel whatever the laptop's doing, so a clip starting, stopping or finishing moves nothing under it. */}
      <div className="publisher-archive-current">
        <div className="publisher-archive-current-head">
          {notice && (
            <p className="publisher-archive-notice" data-tone={notice.tone} role="status">
              {notice.text}
              {notice.accounts && (
                <button type="button" onClick={onAccounts}>
                  Open Accounts
                </button>
              )}
            </p>
          )}
          {!notice && current && <h2>{current.title}</h2>}
          <span>{current ? `${share}%` : ""}</span>
        </div>
        {current ? (
          <div
            className="publisher-archive-bar"
            role="progressbar"
            aria-label={`Uploading ${current.title}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={share}
          >
            <span style={{ width: `${share}%` }} />
          </div>
        ) : (
          <div className="publisher-archive-bar" />
        )}
        <dl className="publisher-archive-figures">
          <div>
            <dt>Sent</dt>
            <dd>{sent}</dd>
          </div>
          <div>
            <dt>Speed</dt>
            <dd>{pace}</dd>
          </div>
          <div>
            <dt>Time left</dt>
            <dd>{left}</dd>
          </div>
          <div>
            <dt>{status && todayLeft !== null ? `Today's ${status.totals.today} clips` : "Today's clips"}</dt>
            <dd>{todayLeft !== null ? duration(todayLeft) : "—"}</dd>
          </div>
        </dl>
      </div>
      <dl className="publisher-archive-totals">
        <div>
          <dt>Up</dt>
          <dd>{status ? clipsOf(status.totals.up, status.totals.upBytes) : "—"}</dd>
        </div>
        <div>
          <dt>Waiting</dt>
          <dd>{status ? clipsOf(status.totals.due, status.totals.dueBytes) : "—"}</dd>
        </div>
        <div>
          <dt>Today</dt>
          <dd>{status ? `${status.today} of ${status.daily}` : "—"}</dd>
        </div>
      </dl>
      <p className="publisher-note" data-unsaid={!status || fresh || undefined}>
        As of {status ? when(status.at) : "now"}
      </p>
      <PublisherMac request={request} shown={showMac} />
      <PublisherLedger
        request={request}
        uploading={current ? { name: current.name, share } : null}
        onGrade={onGrade}
        statsHref={statsHref}
        search={search}
        onNavigate={onNavigate}
      />
    </section>
  );
}
