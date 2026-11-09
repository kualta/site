import { useEffect, useMemo, useRef, useState } from "react";
import {
  BlueskyIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  CommentIcon,
  FarcasterIcon,
  GrainIcon,
  ImageIcon,
  InstagramIcon,
  LensIcon,
  TiktokIcon,
  VideoIcon,
  XiaohongshuIcon,
  XLogoIcon,
  YoutubeIcon,
  type IconComponent,
} from "@/components/icons";
import PublisherChinese, { type ChineseDraft } from "./PublisherChinese";
import type { CalendarPost, CalendarTarget } from "@/lib/publisher/calendar";
import { needsTitle, platformNames, postLabel, type Platform } from "@/lib/publisher/presets";
import { previewSources, storedThumbnail } from "@/lib/publisher/preview";
import { readMonth } from "@/lib/publisher/route";
import { localInput, UPLOAD_LIFETIME } from "@/lib/publisher/schedule";
import { parseTags, problem, renderVariant } from "@/lib/publisher/variants";

type Props = {
  request: (path: string, body?: unknown, method?: string) => Promise<any>;
  onError: (message: string) => void;
  /** The tab's address query, which holds its month. */
  search: string;
  onNavigate: (search: string, replace?: boolean) => void;
  /** Changes when the composer queues or schedules a post, so the month is read again. */
  postsVersion: number;
};

/** Each platform's mark, small enough for a day's cell. */
const platformIcons: Record<Platform, IconComponent> = {
  grain: GrainIcon,
  instagram: InstagramIcon,
  bluesky: BlueskyIcon,
  twitter: XLogoIcon,
  farcaster: FarcasterIcon,
  lens: LensIcon,
  xiaohongshu: XiaohongshuIcon,
  youtube: YoutubeIcon,
  tiktok: TiktokIcon,
};
function PlatformIcon({ platform, size }: { platform: Platform; size: number }) {
  const Icon = platformIcons[platform];
  return <Icon size={size} />;
}
const kindIcons = { text: CommentIcon, photo: ImageIcon, video: VideoIcon, mixed: VideoIcon };

/** A destination's state in a word: what the calendar marks it with. */
function stateOf(
  target: CalendarTarget,
): "published" | "scheduled" | "queued" | "failed" | "check" | "deleted" | "stopped" {
  if (target.deleted) return "deleted";
  if (target.scheduled) return "scheduled";
  if (target.stopped) return "stopped";
  switch (target.state) {
    case "succeeded":
      return "published";
    case "queued":
    case "working":
      return "queued";
    case "failed":
      return "failed";
    default:
      return "check";
  }
}
const stateWords = {
  published: "Published",
  scheduled: "Scheduled for",
  queued: "Publishing",
  failed: "Failed",
  check: "Check the platform",
  deleted: "Deleted",
  stopped: "Stopped",
};
const dayKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const clock = (time: number) => new Date(time).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
/** The week's first day in the reader's locale, Sunday 0; Monday where the browser can't say. */
function firstWeekday(): number {
  try {
    const locale = new Intl.Locale(navigator.language) as Intl.Locale & { getWeekInfo?: () => { firstDay: number } };
    const first = locale.getWeekInfo?.().firstDay;
    return first ? first % 7 : 1;
  } catch {
    return 1;
  }
}
/** The month's days in whole weeks, from its first week's first day to its last week's last. */
function monthGrid(month: string): Date[] {
  const [year, index] = month.split("-").map(Number);
  const first = new Date(year, index - 1, 1);
  const start = new Date(year, index - 1, 1 - ((first.getDay() - firstWeekday() + 7) % 7));
  const last = new Date(year, index, 0);
  const days: Date[] = [];
  for (
    let date = start;
    date <= last || days.length % 7;
    date = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1)
  )
    days.push(date);
  return days;
}
function shiftMonth(month: string, by: number): string {
  const [year, index] = month.split("-").map(Number);
  const date = new Date(year, index - 1 + by, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** A small picture of the post: its kept thumbnail, cover, YouTube still or first photo, never a video file. */
function Thumb({ post }: { post: CalendarPost }) {
  const sources = previewSources(
    post,
    post.targets.map((target) => target.url),
    post.thumbnail ? storedThumbnail(post.id, post.thumbnail) : null,
  ).filter((source) => !source.video);
  const [failed, setFailed] = useState(0);
  const Icon = kindIcons[post.kind] ?? ImageIcon;
  const source = sources[failed];
  return (
    <span className="publisher-calendar-thumb">
      {source ? (
        <img src={source.src} alt="" loading="lazy" onError={() => setFailed((n) => n + 1)} />
      ) : (
        <Icon size={14} />
      )}
    </span>
  );
}

/** A destination that hasn't gone out and isn't going now, so it can take another time. */
const movable = (target: CalendarTarget) => target.state === "queued" || target.stopped;
/** The same time of day on another day. */
function onDay(time: number, day: string): number {
  const [year, month, date] = day.split("-").map(Number);
  const at = new Date(time);
  return new Date(year, month - 1, date, at.getHours(), at.getMinutes()).getTime();
}
/** The latest a post can go out: within the next week, and before its uploads expire. */
const latest = (post: CalendarPost) => Math.min(Date.now() + UPLOAD_LIFETIME, post.expires ?? Number.POSITIVE_INFINITY);
/** A destination's time as its field starts: its scheduled one, or none for one waiting on the laptop or stopped. */
const startingTime = (target: CalendarTarget) => (target.scheduled ? localInput(target.at) : "");
const briefPlatforms: Platform[] = ["twitter", "bluesky", "farcaster"];
const namesOf = (list: Platform[]) => list.map((platform) => platformNames[platform]).join(", ");

type Words = { title: string; caption: string; tags: string; short: string; zh?: ChineseDraft };
const wordsOf = (post: CalendarPost): Words => ({
  title: post.title,
  caption: post.caption,
  tags: post.tags.join(" "),
  short: post.short,
  ...(post.zh ? { zh: { title: post.zh.title, text: post.zh.text, topics: post.zh.topics.join(" ") } } : {}),
});

/**
 * One post: each destination with its state, a time for each still to go out and a way to cancel it, and the post's
 * words while any destination is left to publish them. Saving sends only what changed.
 */
function PostEditor({
  post,
  request,
  onError,
  onClose,
  onChanged,
}: Pick<Props, "request" | "onError"> & { post: CalendarPost; onClose: () => void; onChanged: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  // Where its words can still change: destinations waiting, stopped, or failed and so retried as edited.
  const open = [
    ...new Set(post.targets.filter((t) => t.state === "queued" || t.state === "failed").map((t) => t.platform)),
  ];
  const [initial] = useState(() => wordsOf(post));
  const [words, setWords] = useState(initial);
  const [times, setTimes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [translating, setTranslating] = useState(false);
  const edit = (patch: Partial<Words>) => setWords((current) => ({ ...current, ...patch }));
  const text = {
    title: words.title,
    caption: words.caption,
    tags: parseTags(words.tags),
    short: words.short,
    ...(words.zh ? { zh: { ...words.zh, topics: parseTags(words.zh.topics) } } : {}),
  };
  const titled = open.filter((platform) => needsTitle(platform, post.kind));
  const brief = open.filter((platform) => briefPlatforms.includes(platform));
  const chinese = open.includes("xiaohongshu") && words.zh;
  const problems = [
    ...(titled.length && !words.title.trim() ? [`Add a title for ${namesOf(titled)}.`] : []),
    ...open.flatMap((platform) => {
      const issue = problem(platform, renderVariant(platform, text));
      return issue ? [`${platformNames[platform]}: ${issue}`] : [];
    }),
  ];
  const changedWords = open.length > 0 && JSON.stringify(words) !== JSON.stringify(initial);
  const moved = post.targets.filter(
    (target) => movable(target) && times[target.id] !== undefined && times[target.id] !== startingTime(target),
  );
  const sorted = [...post.targets].sort((a, b) => a.at - b.at);
  // Some destination is out or publishing, so it keeps the words it got.
  const settled = post.targets.some((target) => target.state !== "queued" && target.state !== "failed");

  async function save() {
    setBusy(true);
    onError("");
    try {
      if (changedWords) await request("edit", { job: post.id, ...text });
      for (const target of moved) {
        const at = new Date(times[target.id]).getTime();
        if (!Number.isFinite(at)) throw new Error(`Choose a day and time for ${platformNames[target.platform]}.`);
        await request("reschedule", { job: post.id, target: target.id, at });
      }
      dialog.current?.close();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      onChanged();
      setBusy(false);
    }
  }
  async function stop(target: CalendarTarget) {
    setBusy(true);
    onError("");
    try {
      await request("stop", { job: post.id, target: target.id });
      setTimes((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== target.id)));
    } catch (error) {
      onError((error as Error).message);
    } finally {
      onChanged();
      setBusy(false);
    }
  }
  async function translate() {
    setTranslating(true);
    onError("");
    try {
      const draft = await request("translate", { title: words.title, text: words.caption, tags: text.tags });
      edit({ zh: { title: draft.title, text: draft.text, topics: draft.topics.join(" ") } });
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setTranslating(false);
    }
  }

  return (
    <dialog ref={dialog} className="publisher-calendar-editor" aria-labelledby="publisher-editor-title" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="publisher-calendar-editor-head">
          <Thumb post={post} />
          <h2 id="publisher-editor-title">{postLabel(post)}</h2>
          <button type="button" aria-label="Close" onClick={() => dialog.current?.close()}>
            <CloseIcon size={16} />
          </button>
        </div>
        <ul className="publisher-calendar-destinations">
          {sorted.map((target) => {
            const name = platformNames[target.platform];
            const state = stateOf(target);
            return (
              <li key={target.id} data-state={state}>
                <span>
                  <PlatformIcon platform={target.platform} size={14} />
                  {name}
                </span>
                {movable(target) ? (
                  <label>
                    <span>{state === "scheduled" ? "Scheduled for" : stateWords[state]}</span>
                    <input
                      type="datetime-local"
                      aria-label={`Time for ${name}`}
                      value={times[target.id] ?? startingTime(target)}
                      min={localInput(Date.now())}
                      max={localInput(latest(post))}
                      disabled={busy}
                      onChange={(event) => setTimes((current) => ({ ...current, [target.id]: event.target.value }))}
                    />
                  </label>
                ) : (
                  <span>
                    {stateWords[state]}{" "}
                    {new Date(target.at).toLocaleString(undefined, {
                      weekday: "short",
                      day: "numeric",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                    {target.url && state === "published" && (
                      <>
                        {" · "}
                        <a href={target.url} target="_blank" rel="noreferrer">
                          Open
                        </a>
                      </>
                    )}
                  </span>
                )}
                {(target.state === "queued" || target.state === "working") && (
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`${target.state === "queued" ? "Cancel" : "Stop"} publishing to ${name}`}
                    onClick={() => void stop(target)}
                  >
                    {target.state === "queued" ? "Cancel" : "Stop"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {open.length > 0 && (
          <>
            {titled.length > 0 && (
              <label>
                Title<span className="publisher-for"> · {namesOf(titled)}</span>
                <input
                  value={words.title}
                  maxLength={100}
                  disabled={busy}
                  onChange={(event) => edit({ title: event.target.value })}
                />
              </label>
            )}
            <label>
              Caption
              <textarea
                value={words.caption}
                maxLength={5000}
                rows={5}
                disabled={busy}
                onChange={(event) => edit({ caption: event.target.value })}
              />
            </label>
            <label>
              Tags
              <input
                value={words.tags}
                maxLength={1000}
                disabled={busy}
                onChange={(event) => edit({ tags: event.target.value })}
                placeholder="#travel #bogota"
              />
            </label>
            {brief.length > 0 && (
              <label>
                Short version<span className="publisher-for"> · {namesOf(brief)}</span>
                <textarea
                  value={words.short}
                  maxLength={1000}
                  rows={3}
                  disabled={busy}
                  onChange={(event) => edit({ short: event.target.value })}
                />
              </label>
            )}
            {chinese && (
              <PublisherChinese
                value={chinese}
                onChange={(zh) => edit({ zh })}
                onTranslate={() => void translate()}
                translating={translating}
                canTranslate={Boolean(words.title.trim() || words.caption.trim())}
                disabled={busy}
              />
            )}
          </>
        )}
        {/* Kept in view however long the post is, with why it can't be saved yet. */}
        {(open.length > 0 || post.targets.some(movable)) && (
          <div className="publisher-calendar-editor-foot">
            {(problems.length > 0 || (open.length > 0 && settled)) && (
              <p className="publisher-note" data-problem={problems.length > 0 || undefined}>
                {problems.length
                  ? problems.join(" ")
                  : "Edits reach the destinations still to publish; the rest keep what they got."}
              </p>
            )}
            <button
              type="submit"
              className="publish-button"
              disabled={busy || problems.length > 0 || !(changedWords || moved.length)}
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        )}
      </form>
    </dialog>
  );
}

type Drag = { post: CalendarPost; day: string; targets: CalendarTarget[] };

/**
 * Posts on a month grid, on the days they published or are scheduled to, each platform marked with its state. A post
 * with destinations still to go drags to another day; clicking one opens it to edit.
 */
export default function PublisherCalendar({ request, onError, search, onNavigate, postsVersion }: Props) {
  const month = readMonth(search);
  const days = useMemo(() => monthGrid(month), [month]);
  const [posts, setPosts] = useState<CalendarPost[]>([]);
  const [loading, setLoading] = useState(true);
  // Bumped after a change made here, so the month is read again.
  const [reads, setReads] = useState(0);
  const reread = () => setReads((n) => n + 1);
  const [editing, setEditing] = useState<string | null>(null);
  // The post under the pointer or keyboard focus: its entries on every day stand out, the rest fade back.
  const [hovered, setHovered] = useState<string | null>(null);
  const leave = (id: string) => setHovered((current) => (current === id ? null : current));
  // The destinations a drag carries, from the day it started on, and the day it's over now.
  const [drag, setDrag] = useState<Drag | null>(null);
  const [dropDay, setDropDay] = useState<string | null>(null);
  const from = days[0].getTime();
  // The midnight after the grid's last day; a fixed 24 hours would be off by one across a daylight-saving change.
  const last = days[days.length - 1];
  const to = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1).getTime();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a newly queued, scheduled or edited post is the trigger to read again
  useEffect(() => {
    let active = true;
    setLoading(true);
    request(`calendar?from=${from}&to=${to}`)
      .then((result) => active && setPosts(result.posts))
      .catch((error) => active && onError((error as Error).message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [request, onError, from, to, postsVersion, reads]);
  // Each day's posts, with only the destinations that fall on it.
  const byDay = useMemo(() => {
    const map = new Map<string, { post: CalendarPost; targets: CalendarTarget[] }[]>();
    for (const post of posts)
      for (const target of post.targets) {
        const key = dayKey(new Date(target.at));
        const entries = map.get(key) ?? [];
        const entry = entries.find((item) => item.post.id === post.id);
        if (entry) entry.targets.push(target);
        else entries.push({ post, targets: [target] });
        map.set(key, entries);
      }
    for (const entries of map.values()) entries.sort((a, b) => a.targets[0].at - b.targets[0].at);
    return map;
  }, [posts]);
  const today = dayKey(new Date());
  const [year, index] = month.split("-").map(Number);
  const title = new Date(year, index - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const go = (next: string) => {
    setEditing(null);
    onNavigate(next === readMonth("") ? "" : `?month=${next}`);
  };
  const weekdays = days.slice(0, 7).map((date) => date.toLocaleDateString(undefined, { weekday: "short" }));
  const editingPost = editing ? posts.find((post) => post.id === editing) : undefined;
  /** Whether the dragged destinations can move to a day: each at its time of day there, in the future and in time. */
  function fits(day: string): boolean {
    if (!drag || day === drag.day) return false;
    const limit = latest(drag.post);
    return drag.targets.every((target) => {
      const at = onDay(target.at, day);
      return at > Date.now() && at <= limit;
    });
  }
  function endDrag() {
    setDrag(null);
    setDropDay(null);
  }
  async function move({ post, targets }: Drag, day: string) {
    endDrag();
    const times = new Map(targets.map((target) => [target.id, onDay(target.at, day)]));
    // It shows on the new day at once; the month is read again once every time is saved.
    setPosts((current) =>
      current.map((item) =>
        item.id !== post.id
          ? item
          : {
              ...item,
              targets: item.targets.map((target) => {
                const at = times.get(target.id);
                return at === undefined
                  ? target
                  : { ...target, state: "queued" as const, at, scheduled: true, stopped: false };
              }),
            },
      ),
    );
    onError("");
    try {
      for (const [target, at] of times) await request("reschedule", { job: post.id, target, at });
    } catch (error) {
      onError((error as Error).message);
    } finally {
      reread();
    }
  }

  return (
    <section
      className="publisher-calendar"
      aria-labelledby="publisher-calendar-title"
      data-loading={loading || undefined}
    >
      <div className="publisher-calendar-head">
        <h1 id="publisher-calendar-title">{title}</h1>
        <div className="publisher-actions">
          <button type="button" aria-label="Previous month" onClick={() => go(shiftMonth(month, -1))}>
            <ChevronLeftIcon size={16} />
          </button>
          <button type="button" disabled={month === readMonth("")} onClick={() => go(readMonth(""))}>
            Today
          </button>
          <button type="button" aria-label="Next month" onClick={() => go(shiftMonth(month, 1))}>
            <ChevronRightIcon size={16} />
          </button>
        </div>
      </div>
      <p className="publisher-note">
        Filled: published. Outlined: scheduled. Struck through: failed or deleted. Times are yours. Drag a post to
        another day to move what's still to go out, or click it to edit.
      </p>
      <div className="publisher-calendar-grid" data-hovered={hovered !== null || undefined}>
        {weekdays.map((name) => (
          <div key={name} className="publisher-calendar-weekday" aria-hidden="true">
            {name}
          </div>
        ))}
        {days.map((date) => {
          const key = dayKey(date);
          const entries = byDay.get(key) ?? [];
          const droppable = fits(key);
          return (
            <div
              key={key}
              className="publisher-calendar-day"
              data-outside={date.getMonth() !== index - 1 || undefined}
              data-today={key === today || undefined}
              data-empty={!entries.length || undefined}
              data-droppable={droppable || undefined}
              data-drop={(droppable && dropDay === key) || undefined}
              onDragOver={(event) => {
                if (!droppable) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDropDay(key);
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                  setDropDay((current) => (current === key ? null : current));
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (drag && droppable) void move(drag, key);
              }}
            >
              <time dateTime={key}>
                <span className="publisher-calendar-weekname">
                  {date.toLocaleDateString(undefined, { weekday: "short" })}{" "}
                </span>
                {date.getDate()}
              </time>
              {entries.map(({ post, targets }) => {
                const carried = targets.filter(movable);
                return (
                  <button
                    type="button"
                    key={post.id}
                    className="publisher-calendar-post"
                    aria-haspopup="dialog"
                    draggable={carried.length > 0}
                    data-related={hovered === post.id || undefined}
                    data-carried={(drag?.post.id === post.id && drag.day === key) || undefined}
                    // A tap would only flash it, so touch leaves it out; a click's focus doesn't hold it either.
                    onPointerEnter={(event) => event.pointerType !== "touch" && setHovered(post.id)}
                    onPointerLeave={() => leave(post.id)}
                    onFocus={(event) => event.currentTarget.matches(":focus-visible") && setHovered(post.id)}
                    onBlur={() => leave(post.id)}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move";
                      // Firefox starts a drag only with something to carry.
                      event.dataTransfer.setData("text/plain", postLabel(post));
                      setHovered(null);
                      // After the browser has its picture of the post, so the picture isn't the faded original.
                      setTimeout(() => setDrag({ post, day: key, targets: carried }));
                    }}
                    onDragEnd={endDrag}
                    onClick={() => setEditing(post.id)}
                  >
                    <Thumb post={post} />
                    <span className="publisher-calendar-text">
                      <span className="publisher-calendar-label">
                        <small>{clock(targets[0].at)}</small> {postLabel(post)}
                      </span>
                      <span className="publisher-calendar-marks">
                        {targets.map((target) => {
                          const state = stateOf(target);
                          const label = `${platformNames[target.platform]}: ${stateWords[state]} ${clock(target.at)}`;
                          return (
                            <span
                              key={target.id}
                              className="publisher-calendar-mark"
                              role="img"
                              aria-label={label}
                              title={label}
                              data-state={state}
                              data-platform={target.platform}
                            >
                              <PlatformIcon platform={target.platform} size={13} />
                            </span>
                          );
                        })}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
      {!loading && !posts.length && <p className="publisher-note">Nothing published or scheduled this month.</p>}
      {editingPost && (
        <PostEditor
          key={editingPost.id}
          post={editingPost}
          request={request}
          onError={onError}
          onClose={() => setEditing(null)}
          onChanged={reread}
        />
      )}
    </section>
  );
}
