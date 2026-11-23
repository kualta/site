import { useEffect, useRef, useState } from "react";
import {
  formatDuration,
  formatRate,
  formatWhen,
  LANE_NAMES,
  MAC_LANES,
  MAC_STALE,
  type MacLane,
  type MacLaneName,
  type MacLaneState,
  type MacReport,
  type Paused,
  pausedText,
} from "@/lib/publisher/mac";

/** What `footage/mac` answers: the grade app's last report, and how long ago it came. */
export interface MacReply {
  age: number | null;
  report: MacReport | null;
}
interface Props {
  request: (path: string) => Promise<any>;
  /** When the Grade tab last asked for this section: it's brought into view then, as by `#this-mac`. */
  shown: number | null;
  /** Everything paused from the Footage tab, as it last read. */
  paused: Paused | null;
}

const STATES: Record<MacLaneState, string> = {
  idle: "Idle",
  running: "Running",
  paused: "Paused",
  waiting: "Waiting",
  stopping: "Stopping",
  done: "Done",
  stopped: "Stopped",
  failed: "Failed",
};
const gb = (bytes: number) => (bytes / 1e9).toFixed(1);
const clips = (count: number) => `${count} ${count === 1 ? "clip" : "clips"}`;
/** How long a time is, roughly: 25 min, 3 h, 2 days. */
function howLong(ms: number) {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} days`;
}
const ago = (ms: number) => (ms < 60_000 ? "just now" : `${howLong(ms)} ago`);
/** Which run the figures it frees are of. */
function runName(report: MacReport) {
  if (report.running) return "this run";
  return report.endedAt ? "last run" : "";
}

/** What a lane waits for, what it's doing, or what's left for it, in a line. */
function laneLine(name: MacLaneName, lane: MacLane, report: MacReport) {
  const { waiting } = lane;
  const again = waiting?.until ? `, tries again ${formatWhen(Date.parse(waiting.until))}` : "";
  if (lane.state === "running") return `${name === "copy" ? "Copying" : "Sending"}, ${lane.total - lane.done} to go`;
  if (lane.state === "stopping") return "Stopping once what's in flight is done";
  if (lane.state === "failed") return lane.error ?? "Failed";
  if (lane.state === "paused") return waiting?.for === "owner" ? "Paused by you" : "Paused while no Grade page is open";
  if (waiting) {
    if (waiting.for === "camera") return `Waiting for the camera${again}`;
    if (waiting.for === "network") return `Can't reach Cloudflare${again}`;
    if (waiting.for === "cloudflare") return "Keeping clips on the camera until Cloudflare has them";
    return `${waiting.why}${again}`;
  }
  if (name === "send")
    return report.mac.clips ? `${clips(report.mac.clips)} · ${gb(report.mac.bytes)} GB to send` : "Nothing to send";
  if (report.camera.mounted && report.camera.clips)
    return `${clips(report.camera.clips)} · ${gb(report.camera.bytes)} GB on the camera`;
  if (lane.state === "done") return "All copied: unplug the camera whenever";
  return report.camera.mounted ? "Nothing on the camera to copy" : "Camera not plugged in";
}

/** One switch: its state, its share done, its numbers and a line on what it's about, all in places that keep. */
function Lane({ name, report }: { name: MacLaneName; report: MacReport | null }) {
  const lane = report?.lanes[name];
  // A switch that hasn't run yet counts what waits for it.
  const waits = name === "copy" ? report?.camera : report?.mac;
  const pending = lane?.state === "idle" ? waits : undefined;
  const total = lane?.total || pending?.clips || 0;
  const bytes = lane?.totalBytes || pending?.bytes || 0;
  const share = lane && bytes ? Math.min(100, (lane.sentBytes / bytes) * 100) : 0;
  const measuring = lane?.state === "running" ? "Measuring…" : "—";
  return (
    <div className="publisher-mac-lane" role="group" aria-label={LANE_NAMES[name]} data-state={lane?.state}>
      <div className="publisher-mac-lane-head">
        <h3>{LANE_NAMES[name]}</h3>
        <span>{lane ? STATES[lane.state] : "—"}</span>
      </div>
      <div className="publisher-archive-bar" aria-hidden="true">
        <span style={{ width: `${share}%` }} />
      </div>
      <dl>
        <div>
          <dt>Clips</dt>
          <dd>{lane && total ? `${lane.done} / ${total}` : "—"}</dd>
        </div>
        <div>
          <dt>Size</dt>
          <dd>{lane && bytes ? `${gb(lane.sentBytes)} / ${gb(bytes)} GB` : "—"}</dd>
        </div>
        <div>
          <dt>Speed</dt>
          <dd>{lane?.speed ? formatRate(lane.speed) : measuring}</dd>
        </div>
        <div>
          <dt>Time left</dt>
          <dd>{lane && lane.left !== null ? formatDuration(lane.left) : measuring}</dd>
        </div>
      </dl>
      <p className="publisher-mac-why" title={lane?.waiting?.why ?? lane?.error ?? undefined}>
        {lane && report ? laneLine(name, lane, report) : ""}
      </p>
    </div>
  );
}

/** What's going on with the offload, in a line: going, paused, over, unheard from, or not yet heard of. */
function noticeFor(
  reply: MacReply | null,
  failed: boolean,
  heardAgo: number | null,
  paused: Paused | null,
): { text: string; bad?: boolean } {
  if (!reply) return { text: failed ? "Couldn't load. Retrying…" : "Reading…" };
  const { report } = reply;
  if (!report) return { text: "Nothing from the grade app yet: it reports here once it's running on the Mac, paired." };
  if (report.running && heardAgo !== null && heardAgo > MAC_STALE)
    return {
      text: `Not heard from the Mac for ${howLong(heardAgo)}: it may be asleep or off.`,
      bad: true,
    };
  if (paused) return { text: pausedText(paused) };
  const started = report.startedAt ? formatWhen(Date.parse(report.startedAt)) : null;
  if (report.running) return { text: started ? `Offloading since ${started}` : "Offloading" };
  if (report.endedAt && started)
    return { text: `Last offload ${started} to ${formatWhen(Date.parse(report.endedAt))}` };
  return { text: "Not offloading" };
}

/** The figures under the switches, as they read with the report, or a dash each without one. */
export function MacSection({
  reply,
  failed = false,
  now = Date.now(),
  heardAt = null,
  paused = null,
}: { reply: MacReply | null; failed?: boolean; now?: number; heardAt?: number | null; paused?: Paused | null }) {
  const report = reply?.report ?? null;
  const heardAgo = report && heardAt !== null ? Math.max(0, now - heardAt) : null;
  const notice = noticeFor(reply, failed, heardAgo, paused);
  const stale = notice.bad === true;
  const passed = report?.skipped ?? [];
  const when = report ? runName(report) : "";
  const kept = report?.kept;
  const t = report?.transcripts;
  return (
    <>
      <div className="publisher-mac-head">
        <h2 id="publisher-mac-title">This Mac</h2>
        {/* A line whatever it says, so the heading beside it stays put. */}
        <p className="publisher-note">{heardAgo !== null ? `Updated ${ago(heardAgo)}` : " "}</p>
      </div>
      <p className="publisher-mac-notice" role="status" data-tone={notice.bad ? "bad" : undefined} title={notice.text}>
        {notice.text}
      </p>
      <div className="publisher-mac-body" data-stale={stale || undefined}>
        <div className="publisher-mac-lanes">
          {MAC_LANES.map((name) => (
            <Lane key={name} name={name} report={report} />
          ))}
        </div>
        <dl className="publisher-mac-figures">
          <div>
            <dt>Transcripts</dt>
            <dd title={t?.error ?? undefined}>
              {t ? `${t.made} made` : "—"}
              <small>{t ? `${t.waiting} waiting · ${t.failed} failed` : ""}</small>
            </dd>
          </div>
          <div>
            <dt>Freed from the card</dt>
            <dd>
              {report ? `${gb(report.freed.camera)} GB` : "—"}
              <small>{when}</small>
            </dd>
          </div>
          <div>
            <dt>Freed from the Mac</dt>
            <dd>
              {report ? `${gb(report.freed.mac)} GB` : "—"}
              <small>{when}</small>
            </dd>
          </div>
          <div>
            <dt>Room on the Mac</dt>
            <dd>
              {report ? `${Math.round(report.room.free / 1e9)} GB` : "—"}
              <small>{report ? `${Math.round(report.room.keepFree / 1e9)} GB kept free` : ""}</small>
            </dd>
          </div>
          <div>
            <dt>Kept</dt>
            <dd title={kept?.days.join(", ") || undefined}>
              {kept ? `${kept.days.length} ${kept.days.length === 1 ? "day" : "days"}` : "—"}
              <small>{kept ? clips(kept.clips) : ""}</small>
            </dd>
          </div>
        </dl>
        <div className="publisher-mac-skipped">
          <h3>
            Passed over<span>{report ? passed.length : ""}</span>
          </h3>
          <ul aria-label="Clips passed over">
            {passed.map(({ lane, name, why }) => (
              <li key={`${lane}/${name}`} title={`${LANE_NAMES[lane]} · ${name}: ${why}`}>
                <b>{name}</b> {why}
              </li>
            ))}
            {!passed.length && <li className="publisher-note">{report ? "None" : "—"}</li>}
          </ul>
        </div>
      </div>
    </>
  );
}

/**
 * The Footage tab's This Mac: how the grade app's offload stands, as the Mac last said, read again every 15 seconds
 * while the tab is shown. The Mac says so when it changes, so how long ago that was tells a Mac that's asleep or off.
 */
export default function PublisherMac({ request, shown, paused }: Props) {
  const box = useRef<HTMLElement>(null);
  const [reply, setReply] = useState<MacReply | null>(null);
  const [heardAt, setHeardAt] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let active = true;
    const read = async () => {
      if (document.hidden) return;
      try {
        const next = (await request("footage/mac")) as MacReply;
        if (!active) return;
        const at = Date.now();
        setReply(next);
        setHeardAt(next.age === null ? null : at - next.age);
        setNow(at);
        setFailed(false);
      } catch {
        if (active) setFailed(true);
      }
    };
    void read();
    const timer = window.setInterval(read, 15_000);
    document.addEventListener("visibilitychange", read);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", read);
    };
  }, [request]);
  useEffect(() => {
    if (shown !== null || location.hash === "#this-mac") box.current?.scrollIntoView({ block: "start" });
  }, [shown]);
  return (
    <section ref={box} id="this-mac" className="publisher-mac" aria-labelledby="publisher-mac-title">
      <MacSection reply={reply} failed={failed} now={now} heardAt={heardAt} paused={paused} />
    </section>
  );
}
