import { useEffect, useState } from "react";
import type { Content } from "@/lib/publisher/content";
import {
  atRisk,
  type FootageLink,
  filmsByClip,
  type Ledger,
  type LedgerClip,
  lost,
  needsGrade,
  storage,
} from "@/lib/publisher/ledger";

interface Props {
  request: (path: string) => Promise<any>;
  /** The clip going up to YouTube now, by its graded file's name, and how far it is. */
  uploading: { name: string; share: number } | null;
  /** Opens the clip in the Grade tab. */
  onGrade: (clip: string) => void;
  /** Where a post's numbers are. */
  statsHref: (job: string) => string;
}

const PROFILES: Record<string, string> = { dlog2: "D-Log2", dlog: "D-Log", hlg: "HLG", rec709: "Rec.709" };
/** How a row is marked at its edge: no copy left anywhere, or none off the Mac and the card. */
function riskOf(c: LedgerClip) {
  if (lost(c)) return "lost";
  if (atRisk(c)) return "risk";
  return undefined;
}
const FILTERS = {
  all: { name: "All", shows: () => true },
  risk: { name: "At risk", shows: atRisk },
  ungraded: { name: "Not graded", shows: needsGrade },
  youtube: { name: "Not on YouTube", shows: (c: LedgerClip) => Boolean(c.graded) && !c.graded?.youtube },
  cloudflare: { name: "Not in Cloudflare", shows: (c: LedgerClip) => !c.original.cloudflare && !c.graded?.cloudflare },
} as const;
type Filter = keyof typeof FILTERS;
const FILTER_KEY = "publisher.footageFilter";

/** A file size as Finder shows it: 980 KB, 8.4 MB, 104 MB, 1.2 GB. */
function fileSize(bytes: number) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e7) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}
const when = (iso: string) =>
  new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function gradeText(c: LedgerClip) {
  if (c.graded) return c.graded.look ?? "Graded";
  if (c.gradePending) return "Not exported";
  if (c.profile === "rec709") return "Not log";
  return c.profile ? "Not graded" : "—";
}

/** A yes or no in a location column ("current" is a yes); an earlier grade says so. */
function Mark({
  value,
  first = false,
  title,
}: {
  value: boolean | "current" | "earlier" | null | undefined;
  first?: boolean;
  title?: string;
}) {
  const className = first ? "mark first" : "mark";
  if (value === "earlier")
    return (
      <td className={className}>
        <span className="old" title="An earlier grade">
          Earlier
        </span>
      </td>
    );
  return (
    <td className={className}>
      {value ? (
        <span className="tick" aria-label="Yes" title={title}>
          ✓
        </span>
      ) : (
        <span className="no" aria-label="No">
          –
        </span>
      )}
    </td>
  );
}

/** The YouTube column: the upload in flight, the video (an earlier grade's says so), or nothing. */
function YouTubeMark({ record, share }: { record: LedgerClip; share: number | null }) {
  const youtube = record.graded?.youtube;
  if (share !== null)
    return (
      <td className="mark">
        <span className="busy">↑ {share}%</span>
      </td>
    );
  if (!youtube) return <Mark value={false} />;
  return (
    <td className="mark">
      <a
        className={youtube.current ? "tick" : "old"}
        href={`https://youtu.be/${youtube.video}`}
        target="_blank"
        rel="noreferrer"
      >
        {youtube.current ? "✓" : "Earlier"}
      </a>
    </td>
  );
}

/** A clip's small picture from the archive, else its YouTube video's, else an empty frame the same size. */
function Thumb({ clip, record }: { clip: string; record: LedgerClip }) {
  const [failed, setFailed] = useState(false);
  const video = record.graded?.youtube?.video;
  let src: string | null = null;
  if (record.thumb) src = `/api/publisher/footage/thumbs/${encodeURIComponent(clip)}.jpg`;
  else if (video) src = `https://i.ytimg.com/vi/${encodeURIComponent(video)}/default.jpg`;
  if (!src || failed) return <span className="publisher-ledger-thumb" />;
  return (
    <img
      className="publisher-ledger-thumb"
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

/** The films a clip is in, each linking to its post's numbers once a Pipeline piece made from it is posted. */
function Films({
  names,
  posted,
  statsHref,
}: { names: string[]; posted: Map<string, string>; statsHref: Props["statsHref"] }) {
  if (!names.length) return null;
  return (
    <span className="films">
      {names.map((name, i) => {
        const job = posted.get(name);
        return (
          <span key={name}>
            {i ? ", " : " · in "}
            {job ? (
              <a href={statsHref(job)} title="Its post's numbers">
                {name}
              </a>
            ) : (
              name
            )}
          </span>
        );
      })}
    </span>
  );
}

/**
 * The footage ledger: every clip the grade app has seen, newest day first, with its grade, where its original and
 * graded copies are, and the films it's in. Read from the archive as the grade app last sent it, and again every 30
 * seconds.
 */
export default function PublisherLedger({ request, uploading, onGrade, statsHref }: Props) {
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Each film's post, from the Pipeline pieces that name it: read once, as nothing here changes them.
  const [posted, setPosted] = useState(new Map<string, string>());
  useEffect(() => {
    let active = true;
    Promise.all([request("footage/links"), request("content")])
      .then(([{ links }, { items }]: [{ links: Record<string, FootageLink> }, { items: Content[] }]) => {
        const films = new Map<string, string>();
        for (const piece of items) {
          const film = links[piece.id]?.project;
          if (film && piece.stage === "posted" && piece.job_id) films.set(film, piece.job_id);
        }
        if (active) setPosted(films);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [request]);
  const [filter, setFilter] = useState<Filter>(() => {
    try {
      const saved = localStorage.getItem(FILTER_KEY);
      return saved && saved in FILTERS ? (saved as Filter) : "all";
    } catch {
      return "all";
    }
  });
  useEffect(() => {
    let active = true;
    const read = async () => {
      if (document.hidden) return;
      try {
        const next = (await request("footage/ledger")) as Ledger;
        if (active) {
          setLedger(next);
          setError(null);
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    };
    void read();
    const timer = window.setInterval(read, 30_000);
    document.addEventListener("visibilitychange", read);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", read);
    };
  }, [request]);
  function choose(next: Filter) {
    setFilter(next);
    try {
      localStorage.setItem(FILTER_KEY, next);
    } catch {}
  }

  if (!ledger)
    return (
      <section className="publisher-ledger" aria-label="Footage ledger">
        <p className="publisher-note">
          {error === "No ledger yet" ? "No ledger yet: the grade app sends it once it's running." : error ?? "Reading…"}
        </p>
      </section>
    );
  const entries = Object.entries(ledger.clips);
  const shows = FILTERS[filter].shows;
  // Newest day first; within a day, in the order they were shot.
  const shown = entries
    .filter(([, c]) => shows(c))
    .sort(([, a], [, b]) => {
      const [da, db] = [a.recorded?.slice(0, 10) ?? "", b.recorded?.slice(0, 10) ?? ""];
      return da === db ? (a.recorded ?? "").localeCompare(b.recorded ?? "") : db.localeCompare(da);
    });
  const days = new Map<string, [string, LedgerClip][]>();
  for (const entry of shown) {
    const day = entry[1].recorded?.slice(0, 10) ?? "";
    const list = days.get(day) ?? [];
    list.push(entry);
    days.set(day, list);
  }
  const { camera } = ledger;
  const asOf =
    !camera.mounted && camera.seenAt
      ? `As of ${when(camera.seenAt)}, when the ${camera.name} was last plugged in`
      : undefined;
  const live = uploading?.name.replace(/\.[^.]+$/, "").toLowerCase();
  const films = filmsByClip(ledger);

  const kept = storage(Object.values(ledger.clips));
  const weight = (bytes: number) => (bytes ? fileSize(bytes) : "0 GB");
  function copies({ originals, graded }: { originals: number; graded: number }) {
    const parts: string[] = [];
    if (originals) parts.push(`${originals} ${originals === 1 ? "original" : "originals"}`);
    if (graded) parts.push(`${graded} graded`);
    return parts.join(" · ") || "Nothing";
  }

  return (
    <section className="publisher-ledger" aria-label="Footage ledger">
      <dl className="publisher-ledger-storage" aria-label="Where the footage is">
        <div>
          <dt>Camera</dt>
          <dd>
            {weight(kept.camera.bytes)}
            <small>
              {kept.camera.clips} {kept.camera.clips === 1 ? "clip" : "clips"}
              {asOf && camera.seenAt ? ` · as of ${when(camera.seenAt)}` : ""}
            </small>
          </dd>
        </div>
        <div>
          <dt>Mac</dt>
          <dd>
            {weight(kept.mac.bytes)}
            <small>{copies(kept.mac)}</small>
          </dd>
        </div>
        <div>
          <dt>Cloudflare</dt>
          <dd>
            {weight(kept.cloudflare.bytes)}
            <small>{copies(kept.cloudflare)}</small>
          </dd>
        </div>
        <div>
          <dt>YouTube</dt>
          <dd>
            {`${kept.youtube.videos} ${kept.youtube.videos === 1 ? "video" : "videos"}`}
            <small>Re-encoded copies</small>
          </dd>
        </div>
      </dl>
      <div className="publisher-ledger-head">
        <p className="publisher-note" title={error ?? undefined}>
          {[
            `${entries.length} clips`,
            error ?? `updated ${when(ledger.updatedAt)}`,
            ...(asOf ? [`${camera.name} as of ${when(camera.seenAt ?? ledger.updatedAt)}`] : []),
          ].join(" · ")}
        </p>
        <div className="publisher-ledger-filters" role="group" aria-label="Show">
          {(Object.keys(FILTERS) as Filter[]).map((key) => (
            <button key={key} type="button" aria-pressed={key === filter} onClick={() => choose(key)}>
              {FILTERS[key].name}{" "}
              <span style={{ minWidth: `${String(entries.length).length}ch` }}>
                {entries.filter(([, c]) => FILTERS[key].shows(c)).length}
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="publisher-ledger-scroll">
        <table className="publisher-ledger-table">
          <colgroup>
            <col style={{ width: 76 }} />
            <col />
            <col style={{ width: 84 }} />
            <col style={{ width: 112 }} />
            <col style={{ width: 76 }} />
            <col style={{ width: 56 }} />
            <col style={{ width: 102 }} />
            <col style={{ width: 56 }} />
            <col style={{ width: 102 }} />
            <col style={{ width: 86 }} />
            <col style={{ width: 78 }} />
          </colgroup>
          <thead>
            <tr>
              <th rowSpan={2}>Recorded</th>
              <th rowSpan={2}>Clip</th>
              <th rowSpan={2}>Profile</th>
              <th rowSpan={2}>Grade</th>
              <th colSpan={3} scope="colgroup" className="span first">
                Original
              </th>
              <th colSpan={3} scope="colgroup" className="span first">
                Graded copy
              </th>
              <th rowSpan={2}>
                <span className="publisher-hidden">Open</span>
              </th>
            </tr>
            <tr>
              <th className="mark first">Camera</th>
              <th className="mark">Mac</th>
              <th className="mark">Cloudflare</th>
              <th className="mark first">Mac</th>
              <th className="mark">Cloudflare</th>
              <th className="mark">YouTube</th>
            </tr>
          </thead>
          {[...days].map(([day, rows]) => (
            <tbody key={day}>
              <tr className="day">
                <th colSpan={11} scope="colgroup">
                  {day
                    ? new Date(`${day}T12:00:00`).toLocaleDateString([], {
                        weekday: "short",
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })
                    : "Date unknown"}{" "}
                  · {rows.length} {rows.length === 1 ? "clip" : "clips"}
                </th>
              </tr>
              {rows.map(([key, c]) => {
                const bytes = c.size ?? c.graded?.size;
                const share = uploading && live === key.toLowerCase() ? uploading.share : null;
                const reachable = c.original.camera || c.original.mac;
                return (
                  <tr key={key} data-risk={riskOf(c)}>
                    <td className="dim">{c.recorded?.slice(11, 16) ?? ""}</td>
                    <td className="clip" title={[c.name, ...(films.get(key) ?? [])].join(" · ")}>
                      <Thumb clip={key} record={c} />
                      <b>{/^DJI_\d{14}_(\d+)/.exec(c.name)?.[1] ?? c.name.replace(/\.[^.]+$/, "")}</b>
                      {bytes ? <small>{fileSize(bytes)}</small> : null}
                      {lost(c) ? <span className="note">No copy left</span> : null}
                      <Films names={films.get(key) ?? []} posted={posted} statsHref={statsHref} />
                    </td>
                    <td className="dim">{(c.profile && PROFILES[c.profile]) ?? "—"}</td>
                    <td className={c.graded ? undefined : "dim"}>{gradeText(c)}</td>
                    <Mark value={c.original.camera} first title={asOf} />
                    <Mark value={c.original.mac} />
                    <Mark value={c.original.cloudflare} />
                    <Mark value={c.graded?.mac} first />
                    <Mark value={c.graded?.cloudflare} />
                    <YouTubeMark record={c} share={share} />
                    <td className="open">
                      <button
                        type="button"
                        disabled={!reachable}
                        title={reachable ? "Open it in the grade app" : "Its original isn't on the camera or the Mac"}
                        onClick={() => onGrade(c.name)}
                      >
                        Grade
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
        {!shown.length && <p className="publisher-note">Nothing here.</p>}
      </div>
    </section>
  );
}
