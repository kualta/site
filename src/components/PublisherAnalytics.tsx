import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { CommentIcon, ImageIcon, VideoIcon } from "@/components/icons";
import {
  addUp,
  combined,
  cumulativeSeries,
  dailySeries,
  metricSeries,
  metricValue,
  platformColor,
  reportingPlatforms,
  retentionByPlatform,
  timeAgo,
  watchTime,
  type DailyChange,
  type Metric,
  type Metrics,
  type RetentionReading,
  type Sample,
  type SeriesPoint,
  type VideoMark,
} from "@/lib/publisher/metrics";
import { kindNames, platformNames, postLabel, type Platform, type PostKind } from "@/lib/publisher/presets";
import { previewSources, storedThumbnail } from "@/lib/publisher/preview";
import { saveThumbnail, thumbnailFrom } from "@/lib/publisher/thumbnail";
import {
  kindsOf,
  periods,
  postTypes,
  readView,
  typeNames,
  writeView,
  type AnalyticsView,
  type PostType,
} from "@/lib/publisher/route";

// Only the Analytics tab downloads the chart library, and the Worker never loads it.
const TrendChart = lazy(async () => {
  if (import.meta.env.SSR) throw new Error("The chart renders in the browser");
  return import("./PublisherTrendChart");
});

type Target = {
  id: string;
  platform: Platform;
  state: string;
  url: string | null;
  metrics: Metrics | null;
  /** The latest reading with a watch time, which can be older than `metrics`. */
  retention: Metrics | null;
  observed_at: number | null;
  checked_at: number | null;
  analytics_error: string | null;
  deletion_state: string | null;
  /** 1 when the owner published it themselves and linked it to the post. */
  linked: number;
  /** 1 when the helper published it before the platform's sign-in last changed. */
  earlier_sign_in: number;
};
type Post = {
  id: string;
  created_at: number;
  post: {
    title: string;
    caption: string;
    kind: PostKind;
    media: string[];
    mediaKinds?: ("photo" | "video")[];
    cover?: string;
  };
  /** When its kept thumbnail was saved, or null before it has one. */
  thumbnail: number | null;
  targets: Target[];
};
type Page = { posts: Post[]; next: string | null };
type Refresh = { job: string; at: number; queued: string[] };
type Request = (path: string, body?: unknown) => Promise<any>;
type Props = {
  request: Request;
  online: boolean;
  /** The Analytics tab's query, which holds what it shows. */
  search: string;
  /** Opens another view: pushed for a post or page, replaced for a filter. */
  onNavigate: (search: string, replace?: boolean) => void;
};
const IDLE_POLL = 60_000;
const REFRESH_POLL = 5_000;
const REFRESH_TIMEOUT = 3 * 60_000;
const number = (value: number | null) => (value === null ? "—" : new Intl.NumberFormat().format(value));
const dateTime = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
function shortDate(at: number) {
  const date = new Date(at);
  const year = date.getFullYear() === new Date().getFullYear() ? undefined : "numeric";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year });
}
const metricNames: Record<Metric, string> = {
  exposure: "Views / impressions",
  views: "Views",
  impressions: "Impressions",
  reach: "Reach",
  likes: "Likes / favorites",
  comments: "Comments / replies",
  shares: "Shares / reposts",
  saves: "Saves",
};
/** Whether every kind of post is listed; otherwise at most two of the three are. */
const allTypes = (types: PostType[]) => types.length === postTypes.length;
/** "every video and photo post", or "every post" when nothing is left out. */
function scopeOf(types: PostType[]) {
  return allTypes(types) ? "every post" : `every ${types.join(" and ")} post`;
}

function Spinner() {
  return <span className="publisher-spinner" aria-hidden="true" />;
}
function Block({ height, width }: { height: number; width?: number | string }) {
  return <div className="publisher-skeleton" style={{ height, width }} />;
}
/** Beside a repost on the same platform, what tells the two apart. */
function origin(target: Target) {
  if (target.linked) return "Linked";
  if (target.earlier_sign_in) return "Earlier sign-in";
  return "";
}
function targetStatus(target: Target) {
  if (target.deletion_state === "deleted") return "Deleted · history retained";
  if (target.state !== "succeeded") return target.state;
  const reading = target.analytics_error || (target.observed_at ? "" : "Waiting for first sample");
  return [origin(target), reading].filter(Boolean).join(" · ");
}
const live = (target: Target) => target.state === "succeeded" && target.deletion_state !== "deleted";
/** Where the post is, once each, in the order it went out. */
const destinations = (post: Post) => [...new Set(post.targets.filter(live).map((t) => t.platform))];
function Loading() {
  return (
    <>
      <div className="publisher-analytics-overview" aria-hidden="true">
        <Block height={600} />
      </div>
      <div className="publisher-analytics-layout" role="status">
        <span className="sr-only">Loading analytics…</span>
        <div className="publisher-analytics-posts" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <Block key={i} height={96} />
          ))}
        </div>
        <div className="publisher-analytics-detail publisher-analytics-loading" aria-hidden="true">
          <Block height={160} />
          <Block height={58} width={140} />
          <Block height={260} />
          <Block height={160} />
        </div>
      </div>
    </>
  );
}

const kindIcons = { text: CommentIcon, photo: ImageIcon, video: VideoIcon, mixed: VideoIcon };
const YOUTUBE_STILL = "https://i.ytimg.com/";
// Posts whose thumbnail this page has already sent, so the list and the header don't both send it.
const kept = new Set<string>();
/** Keeps a thumbnail of an upload the page is showing, for when the upload has expired. */
function keepThumbnail(job: string, element: HTMLImageElement | HTMLVideoElement) {
  if (kept.has(job)) return;
  kept.add(job);
  thumbnailFrom(element)
    .then((thumbnail) => saveThumbnail(job, thumbnail))
    .catch(() => kept.delete(job));
}
/**
 * The post's picture: its kept thumbnail, its cover, a YouTube still or its first upload, whichever loads. A post
 * without a thumbnail keeps one of its upload while that's still there; after that, a post with none of them shows
 * what kind it is instead.
 */
function Preview({ post, large = false }: { post: Post; large?: boolean }) {
  const sources = previewSources(
    post.post,
    post.targets.filter(live).map((t) => t.url),
    post.thumbnail ? storedThumbnail(post.id, post.thumbnail) : null,
  );
  const [failed, setFailed] = useState(0);
  const source = sources[failed];
  const next = () => setFailed((n) => n + 1);
  const keep = (element: HTMLImageElement | HTMLVideoElement) => {
    if (!post.thumbnail && source?.upload) keepThumbnail(post.id, element);
  };
  const Icon = kindIcons[post.post.kind] ?? ImageIcon;
  let picture = <Icon size={large ? 28 : 18} />;
  if (source?.video)
    picture = (
      <video
        src={source.src}
        preload="metadata"
        muted
        playsInline
        onError={next}
        onLoadedData={(event) => keep(event.currentTarget)}
      />
    );
  else if (source)
    picture = (
      <img
        src={source.src}
        alt=""
        loading="lazy"
        onError={next}
        onLoad={(event) => {
          // YouTube answers a missing still with a 120×90 placeholder rather than an error.
          if (source.src.startsWith(YOUTUBE_STILL) && event.currentTarget.naturalWidth === 120) next();
          else keep(event.currentTarget);
        }}
      />
    );
  return (
    <div className="publisher-analytics-thumb" data-size={large ? "large" : undefined}>
      {picture}
      {post.post.media.length > 1 && <small>{post.post.media.length}</small>}
    </div>
  );
}
function Dots({ platforms }: { platforms: Platform[] }) {
  return (
    <span className="publisher-analytics-dots" aria-hidden="true">
      {platforms.map((platform) => (
        <i key={platform} title={platformNames[platform]} style={{ background: platformColor(platform) }} />
      ))}
    </span>
  );
}

function share(value: number, total: number) {
  const percent = (value / total) * 100;
  return percent > 0 && percent < 1 ? "<1%" : `${Math.round(percent)}%`;
}
/** What each platform adds up to at the latest point. One platform needs no key. */
function Contributions({ point, busy }: { point: SeriesPoint; busy: boolean }) {
  const reporting = reportingPlatforms(point);
  if (reporting.length < 2) return null;
  return (
    <ul className="publisher-analytics-legend" data-busy={busy}>
      {reporting.map((platform) => (
        <li key={platform}>
          <i className="publisher-analytics-swatch" style={{ background: platformColor(platform) }} />
          {platformNames[platform]}
          <strong>{number(point.parts[platform]!)}</strong>
          {point.value > 0 && <small>{share(point.parts[platform]!, point.value)}</small>}
        </li>
      ))}
    </ul>
  );
}

const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;
/**
 * How long each platform's viewers watched, from what it shows its creator: the average per view, weighed by views
 * across videos. Platforms that don't share it are left out rather than shown as zero.
 */
function Retention({ readings, scope }: { readings: RetentionReading[]; scope?: string }) {
  const rows = retentionByPlatform(readings);
  if (!rows.length) return null;
  return (
    <div className="publisher-analytics-retention">
      <p className="publisher-note">Average watch time per view{scope && ` · ${scope}`}</p>
      <ul className="publisher-analytics-legend">
        {rows.map((row) => (
          <li key={row.platform}>
            <i className="publisher-analytics-swatch" style={{ background: platformColor(row.platform) }} />
            {platformNames[row.platform]}
            <strong>{watchTime(row.average)}</strong>
            {row.watched !== null && <small>{percent(row.watched)} of the video</small>}
            {scope && (
              <small>
                · {row.videos} video{row.videos === 1 ? "" : "s"}
              </small>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function WatchCell({ metrics }: { metrics: Metrics | null }) {
  const average = metrics?.average_watch_ms;
  if (average === undefined) return <td>—</td>;
  return (
    <td>
      {watchTime(average)}
      {!!metrics?.duration_ms && <small>{percent(average / metrics.duration_ms)} of the video</small>}
    </td>
  );
}

function Observations({ points, label, byDay = false }: { points: SeriesPoint[]; label: string; byDay?: boolean }) {
  return (
    <details>
      <summary>View observations</summary>
      <div className="publisher-analytics-table publisher-analytics-observations">
        <table>
          <thead>
            <tr>
              <th>{byDay ? "Date" : "Time"}</th>
              <th>{label}</th>
              <th>Sources</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.at}>
                <td>
                  {byDay ? new Date(p.at).toLocaleDateString(undefined, { dateStyle: "medium" }) : dateTime(p.at)}
                </td>
                <td>{number(p.value)}</td>
                <td>{p.coverage}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
function Failed({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="publisher-analytics-empty">
      <p>The chart didn't load.</p>
      <button onClick={onRetry}>Try again</button>
    </div>
  );
}

/** Every listed post's views, as a running total or day by day, with the moments videos went out marked along the axis. */
function Overview({
  request,
  observed,
  view,
  onDaily,
  canOpen,
  onOpen,
}: {
  request: Request;
  observed?: string;
  view: AnalyticsView;
  onDaily: (daily: boolean) => void;
  canOpen: (id: string) => boolean;
  onOpen: (id: string) => void;
}) {
  const [data, setData] = useState<{
    kinds: string;
    changes: DailyChange[];
    videos: VideoMark[];
    retention: (RetentionReading & { at: number })[];
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const { period: days, daily } = view;
  const kinds = kindsOf(view.types).join(",");
  const utcOffset = -new Date().getTimezoneOffset();
  useEffect(() => {
    let active = true;
    setFailed(false);
    request(`analytics/overview?${new URLSearchParams({ utcOffset: String(utcOffset), kinds })}`)
      .then((value) => {
        if (active) setData({ ...value, kinds });
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [request, observed, attempt, kinds]);
  const label = metricNames.exposure;
  const cutoff = days ? Date.now() - days * 86_400_000 : 0;
  const points = useMemo(() => {
    const changes = data?.changes ?? [];
    const series = daily ? dailySeries(changes, utcOffset) : cumulativeSeries(changes);
    return series.filter((point) => point.at >= cutoff);
  }, [data, days, daily]);
  const marks = useMemo(() => (data?.videos ?? []).filter((video) => video.at >= cutoff), [data, days]);
  // Like the marks, the videos that went out in the period.
  const watched = useMemo(() => (data?.retention ?? []).filter((reading) => reading.at >= cutoff), [data, days]);
  // The running total's last day already holds everything; separate days have to be added up.
  let summary: SeriesPoint | null = null;
  if (points.length) summary = daily ? addUp(points) : points.at(-1)!;
  const period = days ? `in the last ${days} days` : "so far";
  const title = daily ? "Daily views" : "Cumulative views";
  const stale = Boolean(data) && data?.kinds !== kinds;
  let plot;
  if (points.length)
    plot = (
      <Suspense fallback={<Block height={310} />}>
        <TrendChart points={points} label={label} marks={marks} bars={daily} canOpen={canOpen} onOpen={onOpen} />
      </Suspense>
    );
  else if (!data && !failed) plot = <Block height={310} />;
  else if (failed) plot = <Failed onRetry={() => setAttempt((n) => n + 1)} />;
  else plot = <div className="publisher-analytics-empty">No views observed in this period.</div>;
  return (
    <section className="publisher-analytics-overview" aria-label="Views">
      <div className="publisher-heading">
        <h2>Views</h2>
        <div className="publisher-analytics-view" role="group" aria-label="Chart view">
          <button type="button" aria-pressed={!daily} onClick={() => onDaily(false)}>
            Cumulative
          </button>
          <button type="button" aria-pressed={daily} onClick={() => onDaily(true)}>
            Daily
          </button>
        </div>
      </div>
      <div className="publisher-analytics-total">
        <strong>{number(summary?.value ?? null)}</strong>
        <span className="publisher-note">
          {label} {daily ? `${period}, ` : ""}across {scopeOf(view.types)}
        </span>
      </div>
      <figure
        className="publisher-analytics-trend"
        aria-label={points.length ? `${title}: ${number(points[0].value)} to ${number(points.at(-1)!.value)}` : title}
      >
        <div className="publisher-analytics-chart" aria-busy={stale}>
          {plot}
        </div>
        {summary && <Contributions point={summary} busy={stale} />}
        <Retention readings={watched} scope={days ? `videos posted in the last ${days} days` : "every video"} />
        <figcaption className="publisher-note">
          {daily
            ? "Views gained each day, stacked by platform, with marks on the axis when videos went out. Today's bar is still filling. A platform's first report counts everything it had so far, and a day nothing was read rolls into the next."
            : "Each day's closing total, stacked by platform, with marks on the axis when videos went out. A platform's first report counts everything it had so far, and views of deleted posts stay in."}
        </figcaption>
        {!!points.length && <Observations points={points} label={label} byDay={daily} />}
      </figure>
    </section>
  );
}

function Trend({
  samples,
  retention,
  metric,
  days,
  loading,
  failed,
  onRetry,
}: {
  samples: Sample[];
  retention: RetentionReading[];
  metric: Metric;
  days: number;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
}) {
  const label = metricNames[metric];
  const points = useMemo(() => {
    const cutoff = days ? Date.now() - days * 86_400_000 : 0;
    return metricSeries(samples, metric).filter((point) => point.at >= cutoff);
  }, [samples, metric, days]);
  let plot;
  if (points.length)
    plot = (
      <Suspense fallback={<Block height={260} />}>
        <TrendChart points={points} label={label} />
      </Suspense>
    );
  else if (loading) plot = <Block height={260} />;
  else if (failed) plot = <Failed onRetry={onRetry} />;
  else
    plot = (
      <div className="publisher-analytics-empty">
        {samples.length
          ? "No observations for this metric in this period."
          : "No observations yet. The first arrives when your helper reads this post."}
      </div>
    );
  return (
    <figure
      className="publisher-analytics-trend"
      aria-label={
        points.length
          ? `${label} over time: ${number(points[0].value)} to ${number(points.at(-1)!.value)}`
          : `${label} over time`
      }
    >
      <div className="publisher-analytics-chart" aria-busy={loading}>
        {plot}
      </div>
      {!!points.length && <Contributions point={points.at(-1)!} busy={loading} />}
      <Retention readings={retention} />
      <figcaption className="publisher-note">
        Counts are cumulative, stacked by platform. Hourly for the last three days, daily before that; a platform's band
        starts when it first reports.
      </figcaption>
      {!!points.length && <Observations points={points} label={label} />}
    </figure>
  );
}

export default function PublisherAnalytics({ request, online, search, onNavigate }: Props) {
  const view = useMemo(() => readView(search), [search]);
  /** Shows `changes` on top of the current view. Filters replace the address; a post or a page adds to history. */
  const show = (changes: Partial<AnalyticsView>, replace = true) =>
    onNavigate(writeView({ ...view, ...changes }), replace);
  const kinds = kindsOf(view.types).join(",");
  const cursor = view.before;
  const listKey = `${kinds}|${cursor ?? ""}`;
  const [loaded, setLoaded] = useState<{ key: string; page: Page } | null>(null);
  // Which page each "Older" came from, so "Newer" can go back; a page opened from a link goes back to the newest.
  const newer = useRef(new Map<string, string | null>());
  const [series, setSeries] = useState<{ post: string; samples: Sample[] } | null>(null);
  const [seriesFailed, setSeriesFailed] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [requesting, setRequesting] = useState(false);
  const [refresh, setRefresh] = useState<Refresh | null>(null);
  const layout = useRef<HTMLDivElement>(null);
  const page = loaded?.page;
  const paging = Boolean(loaded) && loaded?.key !== listKey && !error;
  const post = page?.posts.find((p) => p.id === view.post) || page?.posts[0];
  const postId = post?.id;
  const refreshing = Boolean(refresh);
  useEffect(() => {
    let active = true;
    const query = new URLSearchParams({ kinds });
    if (cursor) query.set("before", cursor);
    const load = async () => {
      try {
        const value = await request(`analytics?${query}`);
        if (active) {
          setLoaded({ key: listKey, page: value });
          setError("");
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    };
    void load();
    const timer = setInterval(
      () => {
        if (!document.hidden) void load();
      },
      refreshing ? REFRESH_POLL : IDLE_POLL,
    );
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [listKey, request, refreshing, attempt]);
  // The series only changes when a destination gets a new observation.
  const observed = post?.targets.map((t) => t.observed_at ?? 0).join();
  useEffect(() => {
    if (!postId) return;
    let active = true;
    setSeriesFailed(false);
    request(`analytics/${postId}`)
      .then((data) => {
        if (active) setSeries({ post: postId, samples: data.samples });
      })
      .catch(() => {
        if (active) setSeriesFailed(true);
      });
    return () => {
      active = false;
    };
  }, [postId, observed, request, attempt]);
  useEffect(() => {
    setNotice("");
  }, [postId]);
  const refreshed = refresh && page?.posts.find((p) => p.id === refresh.job);
  const checking = new Set(
    refreshed
      ? refresh.queued.filter((id) => (refreshed.targets.find((t) => t.id === id)?.checked_at ?? 0) < refresh.at)
      : [],
  );
  useEffect(() => {
    if (!refresh) return;
    if (!checking.size) {
      setRefresh(null);
      setNotice(refreshed ? "Metrics are up to date." : "");
      return;
    }
    const timer = setTimeout(() => {
      setRefresh(null);
      setNotice("Some destinations are still queued. They'll update when your helper reaches them.");
    }, REFRESH_TIMEOUT);
    return () => clearTimeout(timer);
  }, [refresh, checking.size]);
  async function startRefresh() {
    if (!postId) return;
    setRequesting(true);
    setNotice("");
    try {
      const { at, queued } = await request("analytics/refresh", { job: postId });
      if (queued.length) setRefresh({ job: postId, at, queued });
      else setNotice("Every destination was read in the last five minutes.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRequesting(false);
    }
  }
  function openPost(id: string, scroll = false) {
    show({ post: id, platform: "all" }, false);
    if (scroll) layout.current?.scrollIntoView({ block: "start" });
  }
  function toggleType(type: PostType) {
    const types = view.types.includes(type) ? view.types.filter((t) => t !== type) : [...view.types, type];
    // Something always stays listed.
    if (!types.length) return;
    newer.current.clear();
    show({ types, before: null, post: null, platform: "all" });
  }
  function turnPage(before: string | null) {
    show({ before, post: null, platform: "all" }, false);
  }
  const postPlatforms = post ? [...new Set(post.targets.map((t) => t.platform))] : [];
  const platform = postPlatforms.includes(view.platform as Platform) ? view.platform : "all";
  const targets = post?.targets.filter((t) => platform === "all" || t.platform === platform) || [];
  const reported = (key: keyof Metrics) => Boolean(post?.targets.some((t) => t.metrics?.[key] !== undefined));
  const metricOptions = (Object.keys(metricNames) as Metric[]).filter((key) => {
    if (key === "views") return reported("views") && reported("impressions");
    if (key === "impressions") return reported("impressions");
    if (key === "reach") return platform !== "all" && reported("reach");
    return true;
  });
  const activeMetric = metricOptions.includes(view.metric) ? view.metric : "exposure";
  const published = targets.filter((t) => t.state === "succeeded");
  const values = published.map((t) => metricValue(t.metrics, activeMetric));
  const total = combined(values);
  // While another post's series loads, its predecessor holds the frame, dimmed.
  const seriesCurrent = series?.post === postId;
  const samples = useMemo(() => {
    if (!series) return [];
    if (!seriesCurrent) return seriesFailed ? [] : series.samples;
    return series.samples.filter((sample) => platform === "all" || sample.platform === platform);
  }, [series, seriesCurrent, seriesFailed, platform]);
  const columns = (["exposure", "reach", "likes", "comments", "shares", "saves"] as Metric[]).filter(
    (key) => key !== "reach" || reported("reach"),
  );
  const retained = Boolean(post?.targets.some((t) => t.retention?.average_watch_ms !== undefined));
  const refreshBusy = requesting || refreshing;
  let refreshLabel = "Refresh metrics";
  if (refresh) refreshLabel = `Reading ${refresh.queued.length - checking.size} of ${refresh.queued.length}…`;
  else if (requesting) refreshLabel = "Requesting…";
  const observations = page?.posts.flatMap((p) => p.targets.map((t) => t.observed_at ?? 0)) ?? [];
  const lastObserved = Math.max(0, ...observations);
  const updated = lastObserved ? `Updated ${timeAgo(lastObserved, Date.now())}` : "No observations yet";
  const label = post ? postLabel(post.post) : "";
  // The caption, when the label above doesn't already say all of it.
  const caption = post && post.post.caption.trim() !== label ? post.post.caption.trim() : "";
  let body;
  if (page?.posts.length)
    body = (
      <>
        <Overview
          request={request}
          observed={observations.join()}
          view={view}
          onDaily={(daily) => show({ daily })}
          canOpen={(id) => page.posts.some((p) => p.id === id)}
          onOpen={(id) => openPost(id, true)}
        />
        <div className="publisher-analytics-layout" ref={layout}>
          <aside aria-label="Choose a post" aria-busy={paging}>
            <div className="publisher-analytics-posts" data-busy={paging}>
              {page.posts.map((p) => (
                <button key={p.id} aria-pressed={post?.id === p.id} onClick={() => openPost(p.id)}>
                  <Preview post={p} />
                  <span className="publisher-analytics-post-text">
                    <strong>{postLabel(p.post)}</strong>
                    <span>
                      {shortDate(p.created_at)} · {kindNames[p.post.kind]}
                    </span>
                    <span className="publisher-analytics-post-reach">
                      {number(combined(p.targets.map((t) => metricValue(t.metrics, "exposure"))))} views
                      <Dots platforms={destinations(p)} />
                    </span>
                  </span>
                </button>
              ))}
            </div>
            <div className="publisher-history-pagination">
              {paging && <Spinner />}
              <button
                disabled={!cursor || paging}
                onClick={() => turnPage((cursor && newer.current.get(cursor)) ?? null)}
              >
                Newer
              </button>
              <button
                disabled={!page.next || paging}
                onClick={() => {
                  newer.current.set(page.next!, cursor);
                  turnPage(page.next);
                }}
              >
                Older
              </button>
            </div>
          </aside>
          {post && (
            <div className="publisher-analytics-detail">
              <header className="publisher-analytics-post">
                <Preview key={post.id} post={post} large />
                <div className="publisher-analytics-post-about">
                  <h2>{label}</h2>
                  {caption && <p className="publisher-analytics-caption">{caption}</p>}
                  <p className="publisher-note">
                    {dateTime(post.created_at)} · {kindNames[post.post.kind]}
                  </p>
                </div>
                <button disabled={!online || refreshBusy} aria-busy={refreshBusy} onClick={startRefresh}>
                  {refreshBusy && <Spinner />}
                  {refreshLabel}
                </button>
              </header>
              <div className="publisher-analytics-filters">
                {postPlatforms.length > 1 && (
                  <div className="publisher-analytics-chips" role="group" aria-label="Platform">
                    <button type="button" aria-pressed={platform === "all"} onClick={() => show({ platform: "all" })}>
                      All platforms
                    </button>
                    {postPlatforms.map((p) => (
                      <button key={p} type="button" aria-pressed={platform === p} onClick={() => show({ platform: p })}>
                        <i className="publisher-analytics-swatch" style={{ background: platformColor(p) }} />
                        {platformNames[p]}
                      </button>
                    ))}
                  </div>
                )}
                <select
                  aria-label="Metric"
                  value={activeMetric}
                  onChange={(e) => show({ metric: e.target.value as Metric })}
                >
                  {metricOptions.map((key) => (
                    <option key={key} value={key}>
                      {metricNames[key]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="publisher-analytics-total">
                <span className="publisher-note">
                  Latest {platform === "all" ? "combined " : ""}
                  {metricNames[activeMetric].toLowerCase()}
                </span>
                <strong>{number(total)}</strong>
                <span className="publisher-note">
                  {values.filter((v) => v !== null).length} of {published.length} published destinations reporting
                </span>
              </div>
              {notice && (
                <p role="status" className="publisher-note">
                  {notice}
                </p>
              )}
              <Trend
                samples={samples}
                retention={published.map((t) => ({ platform: t.platform, metrics: t.retention }))}
                metric={activeMetric}
                days={view.period}
                loading={!seriesCurrent && !seriesFailed}
                failed={seriesFailed}
                onRetry={() => setAttempt((n) => n + 1)}
              />
              <div className="publisher-analytics-table">
                <table>
                  <thead>
                    <tr>
                      <th>Platform</th>
                      <th>Views / impressions</th>
                      {reported("reach") && <th>Reach</th>}
                      <th>Likes / favorites</th>
                      <th>Comments</th>
                      <th>Shares</th>
                      <th>Saves</th>
                      {retained && <th>Avg watch time</th>}
                      <th>Observed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {targets.map((t) => (
                      <tr key={t.id}>
                        <th>
                          <i className="publisher-analytics-swatch" style={{ background: platformColor(t.platform) }} />
                          {t.url && t.deletion_state !== "deleted" ? (
                            <a href={t.url} target="_blank" rel="noreferrer">
                              {platformNames[t.platform]}
                            </a>
                          ) : (
                            platformNames[t.platform]
                          )}
                          <small>
                            {checking.has(t.id) ? (
                              <>
                                <Spinner />
                                Reading…
                              </>
                            ) : (
                              targetStatus(t)
                            )}
                          </small>
                        </th>
                        {columns.map((key) => (
                          <td key={key}>
                            {number(metricValue(t.metrics, key))}
                            {key === "exposure" && metricValue(t.metrics, key) !== null && (
                              <small>{t.metrics?.impressions !== undefined ? "impressions" : "views"}</small>
                            )}
                          </td>
                        ))}
                        {retained && <WatchCell metrics={t.retention} />}
                        <td>{t.observed_at ? dateTime(t.observed_at) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </>
    );
  else if (page)
    body = (
      <p className="publisher-analytics-empty">
        {allTypes(view.types)
          ? "Publish a post to start tracking performance."
          : `No ${view.types.join(" or ")} posts yet.`}
      </p>
    );
  else if (error) body = <button onClick={() => setAttempt((n) => n + 1)}>Try again</button>;
  else body = <Loading />;
  return (
    <section className="publisher-analytics" aria-label="Post analytics">
      <div className="publisher-heading">
        <h1>Analytics</h1>
        <span className="publisher-note">
          {updated} · {online ? "hourly while your helper runs" : "helper offline"}
        </span>
      </div>
      <p className="publisher-note">
        Posts published through this app. Combined views / impressions add reported counts, not unique people.
        Unavailable metrics stay blank.
      </p>
      {error && (
        <p role="alert" className="publisher-error">
          {error}
        </p>
      )}
      <div className="publisher-analytics-toolbar">
        <div className="publisher-analytics-chips" role="group" aria-label="Post types">
          {postTypes.map((type) => (
            <button key={type} type="button" aria-pressed={view.types.includes(type)} onClick={() => toggleType(type)}>
              {typeNames[type]}
            </button>
          ))}
        </div>
        <div className="publisher-analytics-view" role="group" aria-label="Period">
          {periods.map((days) => (
            <button key={days} type="button" aria-pressed={view.period === days} onClick={() => show({ period: days })}>
              {days ? `${days}d` : "All time"}
            </button>
          ))}
        </div>
      </div>
      {body}
    </section>
  );
}
