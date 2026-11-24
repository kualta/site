import { useEffect, useRef, useState } from "react";
import {
  formatDuration,
  formatRate,
  formatWhen,
  type Heard,
  LANE_NAMES,
  type LaneAsk,
  type LaneAsks,
  type LaneWant,
  MAC_LANES,
  MAC_STALE,
  type MacLane,
  type MacLaneName,
  type MacLaneState,
  type MacReport,
  type Space,
} from "@/lib/publisher/mac";

/** What `footage/mac` answers: the grade app's last report, how long ago it came, and the owner's Start and Pause. */
export interface MacReply {
  age: number | null;
  report: MacReport | null;
  lanes: LaneAsks;
}
interface Props {
  request: (path: string, body?: unknown, method?: string) => Promise<any>;
  /** When the Grade tab last asked for this section: it's brought into view then, as by `#this-mac`. */
  shown: number | null;
}

const STATES: Record<MacLaneState, string> = {
  idle: "Paused",
  running: "Running",
  paused: "Held",
  waiting: "Waiting",
  stopping: "Pausing",
  done: "Done",
  stopped: "Paused",
  failed: "Failed",
};
/** A switch that's on, whatever it's doing. */
const ON: MacLaneState[] = ["running", "paused", "waiting", "stopping"];
/** Where each switch takes its clips from, whose space it shows: the whole volume, footage and everything else. */
const FROM: Record<MacLaneName, string> = { copy: "Card", send: "Disk" };

const gb = (bytes: number) => (bytes / 1e9).toFixed(1);
/** GB as a volume's size is said: tenths below 100, whole above. */
const volumeGb = (bytes: number) => (bytes >= 100e9 ? String(Math.round(bytes / 1e9)) : gb(bytes));
/** How full a volume is, in whole percent: 100 only when it is. */
const share = ({ used, total }: Space) =>
  total ? Math.min(used < total ? 99 : 100, Math.round((used / total) * 100)) : 0;
export const spaceText = (space: Space) => `${volumeGb(space.used)} of ${volumeGb(space.total)} GB · ${share(space)}%`;
/** How much of a volume the footage still to go from it takes, in whole percent: "<1%" for a sliver, null for none. */
export function goingShare(bytes: number, { total }: Space) {
  if (!total || bytes <= 0) return null;
  const going = (bytes / total) * 100;
  return going < 1 ? "<1%" : `${Math.min(100, Math.round(going))}%`;
}
const clips = (count: number) => `${count} ${count === 1 ? "clip" : "clips"}`;
/** The camera's number for a clip (DJI_20261120183012_0399_D.MP4 → 0399), or its name. */
const clipNumber = (name: string) => /^DJI_\d{14}_(\d+)/.exec(name)?.[1] ?? name;
/** The rows kept for clips in flight, as many as each switch has at once, so one starting or ending moves nothing. */
const IN_FLIGHT_ROWS: Record<MacLaneName, string[]> = { copy: ["first"], send: ["first", "second"] };
/** How long a time is, roughly: 25 min, 3 h, 2 days. */
function howLong(ms: number) {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} days`;
}
const ago = (ms: number) => (ms < 60_000 ? "just now" : `${howLong(ms)} ago`);

/**
 * What a switch shows and what its button does: its state as the Mac last said, unless the owner has asked for the
 * other since and the Mac hasn't done it yet. The button always asks for the other of what was last wanted, so a Start
 * still on its way can be taken back.
 */
export function laneControl(
  lane: MacLane | undefined,
  ask: LaneAsk | undefined,
  heard: Heard | null | undefined,
): { state: string; next: LaneWant; asked: LaneWant | null } {
  const going = Boolean(lane && ON.includes(lane.state) && lane.state !== "stopping");
  const asked = ask && ask.at > (heard?.at ?? 0) ? ask.want : null;
  let state = lane ? STATES[lane.state] : "—";
  if (asked === "start" && !going) state = "Starting…";
  if (asked === "pause" && going) state = "Pausing…";
  return { state, next: (asked ? asked === "start" : going) ? "pause" : "start", asked };
}

/** What's in a switch's way, or what it's doing that its state doesn't say, in a line; or the clips it passed over. */
function laneLine(name: MacLaneName, lane: MacLane, report: MacReport, trouble: string | null) {
  if (trouble) return { text: trouble };
  if (lane.state === "failed") return { text: lane.error ?? "Failed" };
  const { waiting } = lane;
  const held = waiting?.for === "owner";
  if (lane.state === "stopping") {
    const after = name === "copy" ? "After the clip in flight" : "After the clips in flight";
    return { text: held ? `${after}, once you resume all` : after };
  }
  if (lane.state === "paused") return { text: held ? "Held by Pause all" : "Held until a Grade page is open" };
  if (waiting) {
    const again = waiting.until ? `, tries again ${formatWhen(Date.parse(waiting.until))}` : "";
    if (waiting.for === "camera") return { text: `Waiting for the camera${again}` };
    if (waiting.for === "network") return { text: `Can't reach the cloud${again}`, title: waiting.why };
    if (waiting.for === "cloudflare") return { text: "Keeping clips on the camera until the cloud has them" };
    return { text: `${waiting.why}${again}` };
  }
  const passed = report.skipped.filter((clip) => clip.lane === name);
  if (!passed.length) return { text: "" };
  const [first] = passed;
  const what = `${clipNumber(first.name)}: ${first.why}`;
  return {
    text: passed.length === 1 ? `Passed over ${what}` : `${passed.length} passed over · ${what}`,
    title: passed.map((clip) => `${clip.name}: ${clip.why}`).join("\n"),
  };
}

/** One switch: its state and button, the space where it takes clips from, what's left for it and how fast it goes. */
function Lane({
  name,
  report,
  ask,
  trouble,
  busy,
  onAsk,
}: {
  name: MacLaneName;
  report: MacReport | null;
  ask: LaneAsk | undefined;
  trouble: string | null;
  busy: boolean;
  onAsk: (lane: MacLaneName, want: LaneWant) => void;
}) {
  const lane = report?.lanes[name];
  const heard = report?.heard?.[name];
  const control = laneControl(lane, ask, heard);
  // A Start or Pause the Mac couldn't do says why, while it's the last one asked.
  const refused = heard?.error && ask?.at === heard.at ? `Couldn't ${ask.want}: ${heard.error}` : null;
  const line = lane && report ? laneLine(name, lane, report, trouble ?? refused) : { text: "" };
  const source = name === "copy" ? report?.camera : report?.mac;
  const unplugged = name === "copy" && report && !report.camera.mounted;
  const space = source?.space ?? null;
  // The footage still to go from the volume, which the bar shows solid: its share is said beside the volume's.
  const toGo = source && !unplugged ? Math.min(source.bytes, space?.used ?? 0) : 0;
  const leftLabel = name === "copy" ? "To copy" : "To send";
  let spaceSays = "—";
  if (space) {
    spaceSays = spaceText(space);
    const going = goingShare(toGo, space);
    if (going) spaceSays += ` · ${going} ${leftLabel.toLowerCase()}`;
  } else if (unplugged) spaceSays = "Not plugged in";
  // What's left for it: unknown while the card's unplugged.
  let left = "—";
  let leftBytes = "";
  if (source && !unplugged) left = source.clips ? clips(source.clips) : "None";
  if (source && !unplugged && source.clips) leftBytes = `${gb(source.bytes)} GB`;
  const measuring = lane?.state === "running" ? "Measuring…" : "—";
  // The bar is the whole volume: what's used, faint, and solid within it the footage still to go from it.
  const percent = (bytes: number) => (space?.total ? Math.min(100, (bytes / space.total) * 100) : 0);
  return (
    <div className="publisher-mac-lane" role="group" aria-label={LANE_NAMES[name]} data-state={lane?.state}>
      <div className="publisher-mac-lane-head">
        <h3>{LANE_NAMES[name]}</h3>
        <span>{control.state}</span>
        <button type="button" disabled={!report || busy} onClick={() => onAsk(name, control.next)}>
          {control.next === "start" ? "Start" : "Pause"}
        </button>
      </div>
      <div className="publisher-mac-space">
        <span>{FROM[name]}</span>
        <span>{spaceSays}</span>
      </div>
      <div
        className="publisher-archive-bar publisher-mac-bar"
        aria-hidden="true"
        title={space ? `Solid: ${gb(toGo)} GB ${leftLabel.toLowerCase()}. Faint: everything else on it.` : undefined}
      >
        <span style={{ width: `${percent(space?.used ?? 0)}%` }} />
        <span style={{ width: `${percent(toGo)}%` }} />
      </div>
      <dl>
        <div>
          <dt>{leftLabel}</dt>
          <dd>
            {left}
            <small>{leftBytes}</small>
          </dd>
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
      <ul className="publisher-mac-files" aria-label="In flight">
        {IN_FLIGHT_ROWS[name].map((row, i) => {
          const file = lane?.state === "running" || lane?.state === "stopping" ? lane.current?.[i] : undefined;
          const done = file?.size ? Math.min(100, Math.floor((file.sent / file.size) * 100)) : 0;
          // An empty row keeps a file's parts, hidden, so one starting or ending moves nothing.
          return (
            <li
              key={row}
              data-empty={file ? undefined : ""}
              title={file ? `${file.name}: ${gb(file.sent)} of ${gb(file.size)} GB` : undefined}
            >
              <span>{file ? clipNumber(file.name) : "\u00a0"}</span>
              <span className="publisher-archive-bar" aria-hidden="true">
                <span style={{ width: `${done}%` }} />
              </span>
              <span>{file ? `${done}%` : "\u00a0"}</span>
            </li>
          );
        })}
      </ul>
      <p className="publisher-mac-why" title={line.title ?? (line.text || undefined)}>
        {line.text}
      </p>
    </div>
  );
}

/** How the Mac's word stands, beside the heading: how old it is, or that it isn't there. */
function statusFor(reply: MacReply | null, failed: boolean, heardAgo: number | null): { text: string; bad?: boolean } {
  if (!reply) return { text: failed ? "Couldn't load. Retrying…" : "Reading…" };
  if (!reply.report) return { text: "No report from the Mac yet" };
  if (reply.report.running && heardAgo !== null && heardAgo > MAC_STALE)
    return { text: `Not heard from for ${howLong(heardAgo)}`, bad: true };
  return { text: heardAgo !== null ? `Updated ${ago(heardAgo)}` : "" };
}

/** The switches and the figures under them, as they read with the report, or a dash each without one. */
export function MacSection({
  reply,
  failed = false,
  now = Date.now(),
  heardAt = null,
  busy = false,
  trouble = {},
  onAsk = () => {},
}: {
  reply: MacReply | null;
  failed?: boolean;
  now?: number;
  heardAt?: number | null;
  /** A Start or Pause on its way to the site. */
  busy?: boolean;
  /** Why asking for one failed, by switch. */
  trouble?: Partial<Record<MacLaneName, string>>;
  onAsk?: (lane: MacLaneName, want: LaneWant) => void;
}) {
  const report = reply?.report ?? null;
  const heardAgo = report && heardAt !== null ? Math.max(0, now - heardAt) : null;
  const status = statusFor(reply, failed, heardAgo);
  const kept = report?.kept;
  let keptDays = "—";
  if (kept) keptDays = kept.days.length ? `${kept.days.length} ${kept.days.length === 1 ? "day" : "days"}` : "None";
  const t = report?.transcripts;
  // Beside the transcripts waiting: those made and not sent yet, and those that failed, with why.
  const more: string[] = [];
  if (t?.toSend) more.push(`${t.toSend} to send`);
  if (t?.failed) more.push(t.error ? `${t.failed} failed: ${t.error}` : `${t.failed} failed`);
  const transcriptsMore = more.join(" · ");
  return (
    <>
      <div className="publisher-mac-head">
        <h2 id="publisher-mac-title">This Mac</h2>
        {/* A line whatever it says, so the heading beside it stays put. */}
        <p role="status" data-tone={status.bad ? "bad" : undefined} title={status.text || undefined}>
          {status.text || "\u00a0"}
        </p>
      </div>
      <div className="publisher-mac-body" data-stale={status.bad || undefined}>
        <div className="publisher-mac-lanes">
          {MAC_LANES.map((name) => (
            <Lane
              key={name}
              name={name}
              report={report}
              ask={reply?.lanes[name]}
              trouble={trouble[name] ?? null}
              busy={busy}
              onAsk={onAsk}
            />
          ))}
        </div>
        <dl className="publisher-mac-figures">
          <div>
            <dt>Kept</dt>
            <dd title={kept?.days.join(", ") || undefined}>
              {keptDays}
              <small>{kept?.clips ? clips(kept.clips) : ""}</small>
            </dd>
          </div>
          <div>
            <dt>Transcripts</dt>
            <dd title={transcriptsMore || undefined}>
              {t ? `${t.waiting} waiting` : "—"}
              <small>{transcriptsMore}</small>
            </dd>
          </div>
        </dl>
      </div>
    </>
  );
}

/**
 * The Footage tab's This Mac: how the grade app's offload stands, as the Mac last said, read again every 15 seconds
 * while the tab is shown, and every 5 while a Start or Pause is on its way. The Mac says so when it changes, so how
 * long ago that was tells a Mac that's asleep or off. Each switch's Start and Pause go to the site, which the Mac hears.
 */
export default function PublisherMac({ request, shown }: Props) {
  const box = useRef<HTMLElement>(null);
  const [reply, setReply] = useState<MacReply | null>(null);
  const [heardAt, setHeardAt] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [trouble, setTrouble] = useState<Partial<Record<MacLaneName, string>>>({});
  // Whether a Start or Pause is still on its way to the Mac: read more often meanwhile, for the 2 minutes it takes a Mac
  // that's awake to take it.
  const waiting = useRef(false);
  waiting.current = MAC_LANES.some((name) => {
    const ask = reply?.lanes[name];
    const { asked } = laneControl(reply?.report?.lanes[name], ask, reply?.report?.heard?.[name]);
    return asked !== null && ask !== undefined && Date.now() - ask.at < 120_000;
  });
  useEffect(() => {
    let active = true;
    let readAt = 0;
    const read = async () => {
      if (document.hidden) return;
      readAt = Date.now();
      try {
        const next = (await request("footage/mac")) as MacReply;
        if (!active) return;
        const at = Date.now();
        setReply({ ...next, lanes: next.lanes ?? {} });
        setHeardAt(next.age === null ? null : at - next.age);
        setNow(at);
        setFailed(false);
      } catch {
        if (active) setFailed(true);
      }
    };
    void read();
    const timer = window.setInterval(() => {
      if (waiting.current || Date.now() - readAt >= 15_000) void read();
    }, 5_000);
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
  async function ask(lane: MacLaneName, want: LaneWant) {
    setBusy(true);
    try {
      const { lanes } = (await request("footage/lanes", { lane, want })) as { lanes: LaneAsks };
      setReply((was) => was && { ...was, lanes });
      setTrouble((was) => ({ ...was, [lane]: undefined }));
    } catch (error) {
      setTrouble((was) => ({ ...was, [lane]: `Couldn't ask: ${(error as Error).message}` }));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section ref={box} id="this-mac" className="publisher-mac" aria-labelledby="publisher-mac-title">
      <MacSection reply={reply} failed={failed} now={now} heardAt={heardAt} busy={busy} trouble={trouble} onAsk={ask} />
    </section>
  );
}
