import { type RefObject, useEffect, useRef, useState } from "react";
import PublisherArchivePlayer from "./PublisherArchivePlayer";
import { clipNumber, clock, readFootageView, writeFootageView } from "@/lib/publisher/archive-view";
import type { Content } from "@/lib/publisher/content";
import {
  archiveCost,
  atRisk,
  dayOf,
  type FootageLink,
  filmPosts,
  filmsByClip,
  type Ledger,
  type LedgerClip,
  ledgerKey,
  lost,
  storage,
  thumbUrl,
} from "@/lib/publisher/ledger";

interface Props {
  request: (path: string) => Promise<any>;
  /** The clip going up to YouTube now, by its graded file's name, and how far it is. */
  uploading: { name: string; share: number } | null;
  /** Opens the clip in the Grade tab. */
  onGrade: (clip: string) => void;
  /** Where a post's numbers are. */
  statsHref: (job: string) => string;
  /** The tab's address query, which holds the clip playing. */
  search: string;
  onNavigate: (search: string, replace?: boolean) => void;
}

const PROFILES: Record<string, string> = { dlog2: "D-Log2", dlog: "D-Log", hlg: "HLG", rec709: "Rec.709" };
/** How a row is marked at its edge: no original left anywhere, or none off the Mac and the card. */
function riskOf(c: LedgerClip) {
  if (lost(c)) return "lost";
  if (atRisk(c)) return "risk";
  return undefined;
}
/** The clips whose original is in a place: on the camera, on this Mac, in the cloud. */
const FILTERS = {
  all: { name: "All", shows: () => true },
  camera: { name: "Camera", shows: (c: LedgerClip) => c.original.camera },
  mac: { name: "Mac", shows: (c: LedgerClip) => c.original.mac },
  cloud: { name: "Cloud", shows: (c: LedgerClip) => c.original.cloudflare },
} as const;
type Filter = keyof typeof FILTERS;
const FILTER_KEY = "publisher.footageFilter";
/** How big each row's picture is: Small keeps a row a line of text; Large is enough to judge a shot. */
const SIZES = { small: "Small", medium: "Medium", large: "Large" } as const;
type Size = keyof typeof SIZES;
const SIZE_KEY = "publisher.footageThumbs";

/** A choice kept in this browser, or `fallback` where there's none (or no storage: a private window, the server). */
function saved<T extends string>(key: string, options: Record<T, unknown>, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value && value in options ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}
function keep(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

/** A file size as Finder shows it: 980 KB, 8.4 MB, 104 MB, 1.2 GB. */
function fileSize(bytes: number) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e7) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}
const when = (iso: string) =>
  new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
/** A shoot day's heading: "Sun, 8 Nov 2026 · 30 clips". */
function dayText(day: string, count: number) {
  const date = day
    ? new Date(`${day}T12:00:00`).toLocaleDateString([], {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "Date unknown";
  return `${date} · ${count} ${count === 1 ? "clip" : "clips"}`;
}

function gradeText(c: LedgerClip) {
  if (c.graded) return c.graded.look ?? "Graded";
  if (c.gradePending) return "Not exported";
  if (c.profile === "rec709") return "Not log";
  return c.profile ? "Not graded" : "—";
}

/** A yes or no in a location column. */
function Mark({ value, first = false, title }: { value: boolean; first?: boolean; title?: string }) {
  return (
    <td className={first ? "mark first" : "mark"}>
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

/**
 * A clip's picture from the archive, else its YouTube video's, else an empty frame the same size, with its length once
 * it's big enough to read. A clip with an original anywhere plays from it.
 */
function Thumb({ clip, record, size, onPlay }: { clip: string; record: LedgerClip; size: Size; onPlay?: () => void }) {
  const [failed, setFailed] = useState(false);
  const video = record.graded?.youtube?.video;
  let src: string | null = null;
  if (record.thumb) src = thumbUrl(clip, record.thumb);
  else if (video)
    src = `https://i.ytimg.com/vi/${encodeURIComponent(video)}/${size === "small" ? "default" : "mqdefault"}.jpg`;
  const inside = (
    <>
      {src && !failed && <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />}
      {record.duration ? <span className="length">{clock(record.duration)}</span> : null}
    </>
  );
  if (!onPlay) return <span className="publisher-ledger-thumb">{inside}</span>;
  return (
    <button
      type="button"
      className="publisher-ledger-thumb"
      aria-label={`Play clip ${clipNumber(record.name)}`}
      onClick={onPlay}
    >
      {inside}
    </button>
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

function Columns() {
  return (
    <colgroup>
      <col style={{ width: 76 }} />
      <col />
      <col style={{ width: 84 }} />
      <col style={{ width: 112 }} />
      <col style={{ width: 76 }} />
      <col style={{ width: 56 }} />
      <col style={{ width: 64 }} />
      <col style={{ width: 86 }} />
      <col style={{ width: 78 }} />
    </colgroup>
  );
}
function Heads() {
  return (
    <thead>
      <tr>
        <th>Recorded</th>
        <th>Clip</th>
        <th>Profile</th>
        <th>Grade</th>
        <th className="mark first">Camera</th>
        <th className="mark">Mac</th>
        <th className="mark">Cloud</th>
        <th className="mark">YouTube</th>
        <th>
          <span className="publisher-hidden">Open</span>
        </th>
      </tr>
    </thead>
  );
}

/**
 * The column heads and the shoot day of the rows at the top, held at the top of the window while the table scrolls
 * under them. The table scrolls sideways in a box of its own where it's wider than the page (on a phone), and a heading
 * in that box could only stick to the box, so these are a copy outside it, shifted sideways with it. The day changes as
 * the next day's heading slides under it, so it never shows a day the rows under it aren't.
 */
function Pinned({
  frame,
  scroller,
  table,
  size,
  counts,
}: {
  frame: RefObject<HTMLDivElement | null>;
  scroller: RefObject<HTMLDivElement | null>;
  table: RefObject<HTMLTableElement | null>;
  size: Size;
  counts: Map<string, number>;
}) {
  const heads = useRef<HTMLTableElement>(null);
  const [day, setDay] = useState<string | null>(null);
  const place = useRef(() => {});
  place.current = () => {
    const [box, body, all] = [scroller.current, table.current, frame.current];
    if (!box || !body || !all) return;
    const top = body.tHead?.getBoundingClientRect().height ?? 0;
    const first = body.tBodies[0]?.rows[0]?.getBoundingClientRect().height ?? 0;
    const { top: from, bottom: to } = all.getBoundingClientRect();
    let now: string | null = null;
    if (from < 0 && to > top + first)
      for (const group of body.tBodies) {
        if (group.getBoundingClientRect().top > top + 0.5) break;
        now = group.dataset.day ?? "";
      }
    setDay(now);
    if (heads.current) heads.current.style.transform = `translateX(${-box.scrollLeft}px)`;
  };
  // Placed again after every change to the rows under it, and as the page or the table scrolls, once a frame.
  useEffect(() => place.current());
  useEffect(() => {
    let frameId = 0;
    const soon = () => {
      frameId ||= requestAnimationFrame(() => {
        frameId = 0;
        place.current();
      });
    };
    const box = scroller.current;
    window.addEventListener("scroll", soon, { passive: true });
    window.addEventListener("resize", soon);
    box?.addEventListener("scroll", soon, { passive: true });
    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener("scroll", soon);
      window.removeEventListener("resize", soon);
      box?.removeEventListener("scroll", soon);
    };
  }, [scroller]);
  return (
    <div className="publisher-ledger-pin" hidden={day === null} aria-hidden="true">
      <div className="publisher-ledger-pin-heads">
        <table ref={heads} className="publisher-ledger-table" data-thumbs={size}>
          <Columns />
          <Heads />
        </table>
      </div>
      <table className="publisher-ledger-table publisher-ledger-pin-day">
        <tbody>
          <tr className="day">
            <th>
              <span className="publisher-ledger-day">{day === null ? "" : dayText(day, counts.get(day) ?? 0)}</span>
            </th>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/**
 * The footage ledger: every clip the grade app has seen, newest day first, with its grade, where its original is,
 * whether it's on YouTube, and the films it's in. Graded copies aren't kept, so they aren't shown. Read from the archive
 * as the grade app last sent it, and again every 30 seconds. A clip with an original anywhere plays in the player, from
 * the Mac where it can and else from the cloud, its address keeping it open.
 */
export default function PublisherLedger({ request, uploading, onGrade, statsHref, search, onNavigate }: Props) {
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Each film's post, from the Pipeline piece with its number or that names it: read once, as nothing here changes them.
  const [posted, setPosted] = useState(new Map<string, string>());
  useEffect(() => {
    let active = true;
    Promise.all([request("footage/links"), request("content")])
      .then(([{ links }, { items }]: [{ links: Record<string, FootageLink> }, { items: Content[] }]) => {
        if (active) setPosted(filmPosts(items, links));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [request]);
  const [filter, setFilter] = useState<Filter>(() => saved(FILTER_KEY, FILTERS, "all"));
  const [size, setSize] = useState<Size>(() => saved(SIZE_KEY, SIZES, "small"));
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
  const frame = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const table = useRef<HTMLTableElement>(null);

  if (!ledger)
    return (
      <section className="publisher-ledger" aria-label="Footage ledger">
        <p className="publisher-note">{error ?? "Reading…"}</p>
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
  const counts = new Map([...days].map(([day, rows]) => [day, rows.length]));
  const { camera } = ledger;
  const asOf =
    !camera.mounted && camera.seenAt
      ? `As of ${when(camera.seenAt)}, when the ${camera.name} was last plugged in`
      : undefined;
  const live = uploading?.name.replace(/\.[^.]+$/, "").toLowerCase();
  const films = filmsByClip(ledger);

  // The clip playing, by its address: the ledger's key and record of it, and the day the cloud files it under. A clip
  // the ledger doesn't know opens only with a day in its address.
  const view = readFootageView(search);
  const go = (clip: string | null, replace = false) => onNavigate(writeFootageView({ clip, day: null }), replace);
  const openKey = view.clip ? ledgerKey(ledger, view.clip) : undefined;
  const openRecord = openKey ? ledger.clips[openKey] : undefined;
  const openStem = openKey ?? view.clip;
  const openDay = view.day ?? (openRecord ? dayOf(openRecord) : "");

  const kept = storage(Object.values(ledger.clips));
  const weight = (bytes: number) => (bytes ? fileSize(bytes) : "0 GB");
  // A line each whatever it says, so the figures above keep their places.
  const originals = ({ clips }: { clips: number }) =>
    clips ? `${clips} ${clips === 1 ? "original" : "originals"}` : " ";
  const cost = archiveCost(kept.cloudflare.bytes);
  let monthly = " ";
  if (kept.cloudflare.bytes) monthly = cost < 0.005 ? "Under $0.01 a month" : `$${cost.toFixed(2)} a month`;

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
            <small>{originals(kept.mac)}</small>
          </dd>
        </div>
        <div>
          <dt>Cloud</dt>
          <dd>
            {weight(kept.cloudflare.bytes)}
            <small>{originals(kept.cloudflare)}</small>
            <small title="R2 Infrequent Access: $0.01 a GB-month, no free tier">{monthly}</small>
          </dd>
        </div>
        <div>
          <dt>YouTube</dt>
          <dd>{`${kept.youtube.videos} ${kept.youtube.videos === 1 ? "video" : "videos"}`}</dd>
        </div>
      </dl>
      <div className="publisher-ledger-head">
        <p className="publisher-note" title={error ?? undefined}>
          {error ?? `Updated ${when(ledger.updatedAt)}`}
        </p>
        <div className="publisher-ledger-filters" role="group" aria-label="Show">
          {(Object.keys(FILTERS) as Filter[]).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={key === filter}
              onClick={() => {
                setFilter(key);
                keep(FILTER_KEY, key);
              }}
            >
              {FILTERS[key].name}{" "}
              <span style={{ minWidth: `${String(entries.length).length}ch` }}>
                {entries.filter(([, c]) => FILTERS[key].shows(c)).length}
              </span>
            </button>
          ))}
        </div>
        <div className="publisher-ledger-sizes" role="group" aria-label="Thumbnails">
          {(Object.keys(SIZES) as Size[]).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={key === size}
              onClick={() => {
                setSize(key);
                keep(SIZE_KEY, key);
              }}
            >
              {SIZES[key]}
            </button>
          ))}
        </div>
      </div>
      <div ref={frame} className="publisher-ledger-frame">
        <Pinned frame={frame} scroller={scroller} table={table} size={size} counts={counts} />
        <div ref={scroller} className="publisher-ledger-scroll">
          <table ref={table} className="publisher-ledger-table" data-thumbs={size}>
            <Columns />
            <Heads />
            {[...days].map(([day, rows]) => (
              <tbody key={day} data-day={day}>
                <tr className="day">
                  <th colSpan={9} scope="colgroup">
                    <span className="publisher-ledger-day">{dayText(day, rows.length)}</span>
                  </th>
                </tr>
                {rows.map(([key, c]) => {
                  const bytes = c.size;
                  const share = uploading && live === key.toLowerCase() ? uploading.share : null;
                  const reachable = c.original.camera || c.original.mac;
                  // With an original anywhere, the row plays the clip: its picture as a button, the rest of it for a
                  // pointer.
                  const play = lost(c) ? undefined : () => go(key);
                  return (
                    <tr
                      key={key}
                      data-risk={riskOf(c)}
                      data-plays={play ? true : undefined}
                      onClick={
                        play &&
                        ((event) => {
                          if ((event.target as Element).closest("a, button") || getSelection()?.toString()) return;
                          play();
                        })
                      }
                    >
                      <td className="dim">{c.recorded?.slice(11, 16) ?? ""}</td>
                      <td className="clip" title={[c.name, ...(films.get(key) ?? [])].join(" · ")}>
                        <Thumb clip={key} record={c} size={size} onPlay={play} />
                        <b>{clipNumber(c.name)}</b>
                        {bytes ? <small>{fileSize(bytes)}</small> : null}
                        {lost(c) ? <span className="note">No copy left</span> : null}
                        <Films names={films.get(key) ?? []} posted={posted} statsHref={statsHref} />
                      </td>
                      <td className="dim">{(c.profile && PROFILES[c.profile]) ?? "—"}</td>
                      <td className={c.graded ? undefined : "dim"}>{gradeText(c)}</td>
                      <Mark value={c.original.camera} first title={asOf} />
                      <Mark value={c.original.mac} />
                      <Mark value={c.original.cloudflare} />
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
      </div>
      {openStem && (openRecord || openDay) && (
        <PublisherArchivePlayer
          key={openStem}
          stem={openStem}
          day={openDay}
          record={openRecord}
          request={request}
          onClose={() => go(null)}
          onGrade={(file) => {
            // Gone to grade, the player is closed: coming back to this tab doesn't open it again.
            go(null, true);
            onGrade(file);
          }}
        />
      )}
    </section>
  );
}
