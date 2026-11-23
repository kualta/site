import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "@/components/icons";
import PublisherArchivePlayer from "./PublisherArchivePlayer";
import type { ArchivedClip, ArchivedDay } from "@/lib/publisher/archive-tab";
import {
  type ArchiveView,
  clipNumber,
  clock,
  fileSize,
  nameTime,
  otherCopies,
  PAGE_SIZE,
  PROFILES,
  readArchiveView,
  stemOf,
  writeArchiveView,
} from "@/lib/publisher/archive-view";
import { dayOf, type Ledger, type LedgerClip, thumbUrl } from "@/lib/publisher/ledger";
import "@/styles/publisher-archive.css";

interface Props {
  request: (path: string) => Promise<any>;
  /** The tab's address query, which holds the day, page and clip open. */
  search: string;
  onNavigate: (search: string, replace?: boolean) => void;
  /** Opens a clip in the Grade tab, whose Cloudflare list brings it to the Mac. */
  onGrade: (clip: string) => void;
}

const dayName = (day: string, long = false) =>
  new Date(`${day}T12:00:00`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(long ? { year: "numeric" } : {}),
  });

/** A clip's small picture from the archive, where the ledger has one, else an empty frame the same size. */
function Thumb({ stem, record }: { stem: string; record: LedgerClip | undefined }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="publisher-archive-thumb">
      {record?.thumb && !failed && (
        <img
          src={thumbUrl(stem, record.thumb)}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      )}
      {record?.duration ? <small>{clock(record.duration)}</small> : null}
    </span>
  );
}

/** Which clips of the day are shown: "25–48 of 230", between Previous and Next. */
function Pager({
  page,
  pages,
  count,
  onPage,
}: { page: number; pages: number; count: number; onPage: (page: number) => void }) {
  return (
    <div className="publisher-archive-pager" role="group" aria-label="Pages">
      <button type="button" aria-label="Previous page" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        <ChevronLeftIcon size={16} />
      </button>
      <span>{count ? `${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, count)} of ${count}` : ""}</span>
      <button type="button" aria-label="Next page" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        <ChevronRightIcon size={16} />
      </button>
    </div>
  );
}

function ClipCard({
  clip,
  record,
  onOpen,
}: { clip: ArchivedClip; record: LedgerClip | undefined; onOpen: () => void }) {
  const time = record?.recorded?.slice(11, 19) ?? nameTime(clip.file) ?? "";
  const profile = record?.profile ? PROFILES[record.profile] ?? record.profile : "Profile unknown";
  return (
    <li>
      <button
        type="button"
        className="publisher-archive-clip"
        aria-label={`Clip ${clipNumber(clip.file)}${time ? `, recorded ${time}` : ""}`}
        title={clip.file}
        onClick={onOpen}
      >
        <Thumb stem={stemOf(clip.file)} record={record} />
        <span className="line head">
          <b>{clipNumber(clip.file)}</b>
          <span>{time}</span>
        </span>
        <span className="line">
          {fileSize(clip.size)} · {profile}
        </span>
        <span className="line" data-dim={!clip.vtt || undefined}>
          {clip.vtt ? "Transcript" : "No transcript"}
        </span>
        <span className="line" data-dim>
          {otherCopies(record)}
        </span>
      </button>
    </li>
  );
}

/**
 * The composer's Archive tab: the originals the grade app offloaded to the archive, a shoot day at a time and a page of
 * clips at a time, each with what the ledger knows of it. A clip opens in a player that streams it from the archive.
 */
export default function PublisherArchive({ request, search, onNavigate, onGrade }: Props) {
  const view = readArchiveView(search);
  const go = (next: Partial<ArchiveView>, replace = false) =>
    onNavigate(writeArchiveView({ ...view, ...next }), replace);
  const [days, setDays] = useState<string[] | null>(null);
  const [daysError, setDaysError] = useState<string | null>(null);
  const [ledger, setLedger] = useState<Ledger | null>(null);
  // A clip's player opens once the ledger has been read, so what it says of the clip doesn't change under it.
  const [ledgerRead, setLedgerRead] = useState(false);
  const [listing, setListing] = useState<ArchivedDay | null>(null);
  const [listingError, setListingError] = useState<string | null>(null);
  // Read again when the tab is shown again, for what was offloaded meanwhile or what failed to load.
  const [round, setRound] = useState(0);
  useEffect(() => {
    const again = () => {
      if (!document.hidden) setRound((n) => n + 1);
    };
    document.addEventListener("visibilitychange", again);
    return () => document.removeEventListener("visibilitychange", again);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new round is the trigger to read again
  useEffect(() => {
    let active = true;
    request("archive/days")
      .then(({ days }: { days: string[] }) => {
        if (!active) return;
        setDays(days);
        setDaysError(null);
      })
      .catch((error: Error) => active && setDaysError(error.message));
    // What the ledger knows of each clip: without it (none yet, or unreadable) the clips are shown as the archive has them.
    request("footage/ledger")
      .then((next: Ledger) => active && setLedger(next))
      .catch(() => {})
      .finally(() => active && setLedgerRead(true));
    return () => {
      active = false;
    };
  }, [request, round]);
  const day = view.day ?? days?.[0] ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new round is the trigger to read again
  useEffect(() => {
    if (!day) return;
    let active = true;
    request(`archive/days/${day}`)
      .then((next: ArchivedDay) => {
        if (!active) return;
        setListing(next);
        setListingError(null);
      })
      .catch((error: Error) => active && setListingError(error.message));
    return () => {
      active = false;
    };
  }, [request, day, round]);

  const shown = listing?.day === day ? listing : null;
  const clips = shown?.clips ?? [];
  const pages = Math.max(1, Math.ceil(clips.length / PAGE_SIZE));
  const page = Math.min(view.page, pages);
  const onPage = clips.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const records = ledger?.clips ?? {};
  const open = view.clip ? clips.find((clip) => stemOf(clip.file) === view.clip) : undefined;
  const bytes = clips.reduce((sum, clip) => sum + clip.size, 0);
  const transcribed = clips.filter((clip) => clip.vtt).length;
  // While a day is read, a place for each clip the ledger knows it to have in the archive, up to a page.
  const known = Object.values(records).filter((c) => c.original.cloudflare && dayOf(c) === day).length;
  const waiting = Math.min(PAGE_SIZE, known || PAGE_SIZE);
  const grid = useRef<HTMLUListElement>(null);
  // On a phone the days run sideways; the open one is kept in view.
  const daysBar = useRef<HTMLElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the day open and the days listed are what move it
  useLayoutEffect(() => {
    const bar = daysBar.current;
    const open = bar?.querySelector('[aria-pressed="true"]');
    if (!bar || !open || bar.scrollWidth <= bar.clientWidth) return;
    const shown = bar.getBoundingClientRect();
    const button = open.getBoundingClientRect();
    bar.scrollLeft += Math.max(0, button.right - shown.right + 16) + Math.min(0, button.left - shown.left - 16);
  }, [day, days]);

  let summary = "Reading…";
  if (listingError && !shown) summary = listingError;
  else if (shown)
    summary = clips.length
      ? `${clips.length} ${clips.length === 1 ? "clip" : "clips"} · ${fileSize(bytes)} · ${transcribed} transcribed`
      : "No clips filed this day";

  return (
    <section className="publisher-archive" aria-label="Archive">
      <p className="publisher-note publisher-archive-intro">
        The originals offloaded to Cloudflare, by shoot day. Watching one reads it from the archive, about $0.01 a GB.
      </p>
      <div className="publisher-archive-body">
        <nav ref={daysBar} className="publisher-archive-days" aria-label="Shoot days">
          {days?.map((name) => (
            <button
              key={name}
              type="button"
              aria-pressed={name === day}
              onClick={() => go({ day: name, page: 1, clip: null })}
            >
              {dayName(name, true)}
            </button>
          ))}
          {!days && <p className="publisher-note">{daysError ?? "Reading…"}</p>}
        </nav>
        <div className="publisher-archive-day">
          {days && !days.length ? (
            <p className="publisher-note">
              Nothing is in the archive yet. The grade app's Mac → Cloudflare offload files each shoot day here.
            </p>
          ) : (
            <>
              <div className="publisher-archive-head">
                <h2>{day ? dayName(day, true) : " "}</h2>
                <p className="publisher-note" title={listingError ?? undefined}>
                  {summary}
                </p>
                <Pager page={page} pages={pages} count={clips.length} onPage={(next) => go({ page: next })} />
              </div>
              <ul ref={grid} className="publisher-archive-clips" aria-busy={!shown}>
                {shown
                  ? onPage.map((clip) => (
                      <ClipCard
                        key={clip.file}
                        clip={clip}
                        record={records[stemOf(clip.file)]}
                        onOpen={() => go({ clip: stemOf(clip.file) })}
                      />
                    ))
                  : Array.from({ length: waiting }, (_, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: a place held for a clip has nothing else to go by
                      <li key={i} className="publisher-archive-slot" aria-hidden="true">
                        <span className="publisher-archive-clip">
                          <span className="publisher-archive-thumb" />
                          <span className="line" />
                          <span className="line" />
                          <span className="line" />
                          <span className="line" />
                        </span>
                      </li>
                    ))}
              </ul>
              {/* At the foot of a long page too, going back up to its top. */}
              {shown && pages > 1 && (
                <div className="publisher-archive-foot">
                  <Pager
                    page={page}
                    pages={pages}
                    count={clips.length}
                    onPage={(next) => {
                      go({ page: next });
                      const top = grid.current?.getBoundingClientRect().top ?? 0;
                      if (top < 0) window.scrollBy(0, top - 80);
                    }}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {open && day && ledgerRead && (
        <PublisherArchivePlayer
          key={open.file}
          clip={open}
          day={day}
          record={records[stemOf(open.file)]}
          request={request}
          onClose={() => go({ clip: null })}
          onGrade={() => onGrade(open.file)}
        />
      )}
    </section>
  );
}
