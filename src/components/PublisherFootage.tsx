import { useEffect, useState } from "react";
import PublisherLedger from "./PublisherLedger";

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
  state: "uploading" | "waiting" | "done" | "limit" | "paused" | "busy";
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
  status: FootageStatus | null;
}
interface Props {
  request: (path: string, body?: unknown, method?: string) => Promise<any>;
  online: boolean;
  /** Whether the YouTube footage archive is connected in Accounts. */
  connected: boolean;
  onAccounts: () => void;
  /** Opens a clip in the Grade tab. */
  onGrade: (clip: string) => void;
  /** Where a post's numbers are. */
  statsHref: (job: string) => string;
  /** How far the clip going up is, in percent, for the page's title; null with none. */
  onProgress: (percent: number | null) => void;
}

/** The laptop reports every 5 seconds during an upload and every 10 otherwise; older than this, it hasn't started. */
const FRESH = 30_000;

const size = (bytes: number) =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.max(0, Math.round(bytes / 1e6))} MB`;
const clipsOf = (count: number, bytes: number) => `${count} ${count === 1 ? "clip" : "clips"} · ${size(bytes)}`;
/** Network speed in the unit an internet plan states it in. */
function rate(bytesPerSecond: number) {
  const mbit = (bytesPerSecond * 8) / 1e6;
  return `${mbit.toFixed(mbit < 10 ? 1 : 0)} Mbit/s`;
}
function duration(seconds: number) {
  if (seconds < 60) return "under a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}
function when(ms: number) {
  const date = new Date(ms);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** What's holding the uploads, or what they're doing, in a line; null while a clip goes up and the bar says it. */
function noticeFor(
  { connected, online, reply, failed }: { connected: boolean; online: boolean; reply: Reply | null; failed: boolean },
  fresh: boolean,
): { text: string; tone?: "ok" | "bad"; accounts?: boolean } | null {
  if (!connected) return { text: "Not connected.", accounts: true };
  if (!online) return { text: "Laptop offline." };
  if (!reply) return failed ? { text: "Couldn't load. Retrying…" } : { text: "Reading…" };
  const status = reply.status;
  if (!status || !fresh) return { text: "Waiting for the laptop…" };
  switch (status.state) {
    case "paused": {
      const until = `Paused until ${when(status.pausedUntil ?? Date.now())}`;
      return { text: status.lastError ? `${until}: ${status.lastError.message}` : until, tone: "bad" };
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
 * The composer's Footage tab: the footage ledger (every clip, its grade, where its copies are) under the graded
 * footage going up to the footage archive's YouTube channel. The laptop uploads only while this tab is open, so it
 * says so on opening and every 30 seconds, and says it closed on leaving.
 */
export default function PublisherFootage({
  request,
  online,
  connected,
  onAccounts,
  onGrade,
  statsHref,
  onProgress,
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

  const status = reply?.status ?? null;
  const fresh = status !== null && typeof reply?.age === "number" && reply.age < FRESH;
  const notice = noticeFor({ connected, online, reply, failed }, fresh);
  const current = fresh && online ? status?.current : null;
  const speed = status?.speed ?? null;
  const share = current?.size ? Math.min(100, Math.floor((current.sent / current.size) * 100)) : 0;
  const clipLeft = current && speed ? (current.size - current.sent) / speed : null;
  const todayLeft = current && speed && status && status.totals.today > 1 ? status.totals.todayBytes / speed : null;
  // Unheard from, the upload may be over, so the title lets go of it.
  const percent = current && !failed ? share : null;
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
      <PublisherLedger
        request={request}
        uploading={current ? { name: current.name, share } : null}
        onGrade={onGrade}
        statsHref={statsHref}
      />
    </section>
  );
}
