import { useEffect, useMemo, useState } from "react";
import {
  BlueskyIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
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
import type { CalendarPost, CalendarTarget } from "@/lib/publisher/calendar";
import { platformNames, postLabel, type Platform } from "@/lib/publisher/presets";
import { previewSources, storedThumbnail } from "@/lib/publisher/preview";
import { readMonth } from "@/lib/publisher/route";

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

/** Posts on a month grid, on the days they published or are scheduled to, each platform marked with its state. */
export default function PublisherCalendar({ request, onError, search, onNavigate, postsVersion }: Props) {
  const month = readMonth(search);
  const days = useMemo(() => monthGrid(month), [month]);
  const [posts, setPosts] = useState<CalendarPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<{ post: string; day: string } | null>(null);
  // The post under the pointer or keyboard focus: its entries on every day stand out, the rest fade back.
  const [hovered, setHovered] = useState<string | null>(null);
  const leave = (id: string) => setHovered((current) => (current === id ? null : current));
  const from = days[0].getTime();
  // The midnight after the grid's last day; a fixed 24 hours would be off by one across a daylight-saving change.
  const last = days[days.length - 1];
  const to = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1).getTime();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a newly queued or scheduled post is the trigger to read again
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
  }, [request, onError, from, to, postsVersion]);
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
    setOpen(null);
    onNavigate(next === readMonth("") ? "" : `?month=${next}`);
  };
  const weekdays = days.slice(0, 7).map((date) => date.toLocaleDateString(undefined, { weekday: "short" }));
  // The open post's details list every platform, on whichever day.
  const selectedPost = open ? posts.find((post) => post.id === open.post) : undefined;

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
        Filled: published. Outlined: scheduled. Struck through: failed or deleted. Times are yours.
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
          return (
            <div
              key={key}
              className="publisher-calendar-day"
              data-outside={date.getMonth() !== index - 1 || undefined}
              data-today={key === today || undefined}
              data-empty={!entries.length || undefined}
            >
              <time dateTime={key}>
                <span className="publisher-calendar-weekname">
                  {date.toLocaleDateString(undefined, { weekday: "short" })}{" "}
                </span>
                {date.getDate()}
              </time>
              {entries.map(({ post, targets }) => (
                <button
                  type="button"
                  key={post.id}
                  className="publisher-calendar-post"
                  aria-expanded={open?.post === post.id && open.day === key}
                  data-related={hovered === post.id || undefined}
                  // A tap would only flash it, so touch leaves it out; a click's focus doesn't hold it either.
                  onPointerEnter={(event) => event.pointerType !== "touch" && setHovered(post.id)}
                  onPointerLeave={() => leave(post.id)}
                  onFocus={(event) => event.currentTarget.matches(":focus-visible") && setHovered(post.id)}
                  onBlur={() => leave(post.id)}
                  onClick={() =>
                    setOpen(open?.post === post.id && open.day === key ? null : { post: post.id, day: key })
                  }
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
                            key={target.platform}
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
              ))}
            </div>
          );
        })}
      </div>
      {!loading && !posts.length && <p className="publisher-note">Nothing published or scheduled this month.</p>}
      {selectedPost && (
        <div className="publisher-calendar-detail" role="region" aria-label={postLabel(selectedPost)}>
          <Thumb post={selectedPost} />
          <div>
            <h2>{postLabel(selectedPost)}</h2>
            <ul>
              {selectedPost.targets.map((target) => (
                <li key={target.platform} data-state={stateOf(target)}>
                  <span>
                    <PlatformIcon platform={target.platform} size={14} />
                    {platformNames[target.platform]}
                  </span>
                  <span>
                    {stateWords[stateOf(target)]}{" "}
                    {new Date(target.at).toLocaleString(undefined, {
                      weekday: "short",
                      day: "numeric",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                    {target.url && stateOf(target) === "published" && (
                      <>
                        {" · "}
                        <a href={target.url} target="_blank" rel="noreferrer">
                          Open
                        </a>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <p className="publisher-note">
              Change a scheduled time, or cancel it, from the post's entry in History.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
