import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  addUp,
  combined,
  cumulativeSeries,
  dailySeries,
  metricSeries,
  metricValue,
  platformColor,
  reportingPlatforms,
  timeAgo,
  type DailyChange,
  type Metric,
  type Metrics,
  type Sample,
  type SeriesPoint,
  type VideoMark,
} from "@/lib/publisher/metrics";
import { platformNames, postLabel, type Platform } from "@/lib/publisher/presets";

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
  observed_at: number | null;
  checked_at: number | null;
  analytics_error: string | null;
  deletion_state: string | null;
};
type Post = { id: string; created_at: number; post: { title: string; caption: string }; targets: Target[] };
type Page = { posts: Post[]; next: string | null };
type Refresh = { job: string; at: number; queued: string[] };
type Request = (path: string, body?: unknown) => Promise<any>;
type Props = { request: Request; online: boolean };
const IDLE_POLL = 60_000;
const REFRESH_POLL = 5_000;
const REFRESH_TIMEOUT = 3 * 60_000;
const number = (value: number | null) => (value === null ? "—" : new Intl.NumberFormat().format(value));
const dateTime = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
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

function Spinner() {
  return <span className="publisher-spinner" aria-hidden="true" />;
}
function Block({ height, width }: { height: number; width?: number | string }) {
  return <div className="publisher-skeleton" style={{ height, width }} />;
}
function targetStatus(target: Target) {
  if (target.deletion_state === "deleted") return "Deleted · history retained";
  if (target.state !== "succeeded") return target.state;
  return target.analytics_error || (target.observed_at ? "" : "Waiting for first sample");
}
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
            <Block key={i} height={104} />
          ))}
        </div>
        <div className="publisher-analytics-detail publisher-analytics-loading" aria-hidden="true">
          <Block height={22} width="40%" />
          <Block height={64} width={380} />
          <Block height={58} width={140} />
          <Block height={260} />
          <Block height={160} />
        </div>
      </div>
    </>
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

function PeriodOptions() {
  return (
    <>
      <option value={7}>7 days</option>
      <option value={30}>30 days</option>
      <option value={90}>90 days</option>
      <option value={0}>All time</option>
    </>
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

/** Every post's views, as a running total or day by day, with the moments videos went out marked along the axis. */
function Overview({
  request,
  observed,
  canOpen,
  onOpen,
}: {
  request: Request;
  observed?: string;
  canOpen: (id: string) => boolean;
  onOpen: (id: string) => void;
}) {
  const [data, setData] = useState<{ changes: DailyChange[]; videos: VideoMark[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [days, setDays] = useState(30);
  const [daily, setDaily] = useState(false);
  const utcOffset = -new Date().getTimezoneOffset();
  useEffect(() => {
    let active = true;
    setFailed(false);
    request(`analytics/overview?utcOffset=${utcOffset}`)
      .then((value) => {
        if (active) setData(value);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [request, observed, attempt]);
  const label = metricNames.exposure;
  const cutoff = days ? Date.now() - days * 86_400_000 : 0;
  const points = useMemo(() => {
    const changes = data?.changes ?? [];
    const series = daily ? dailySeries(changes, utcOffset) : cumulativeSeries(changes);
    return series.filter((point) => point.at >= cutoff);
  }, [data, days, daily]);
  const marks = useMemo(() => (data?.videos ?? []).filter((video) => video.at >= cutoff), [data, days]);
  // The running total's last day already holds everything; separate days have to be added up.
  let summary: SeriesPoint | null = null;
  if (points.length) summary = daily ? addUp(points) : points.at(-1)!;
  const period = days ? `in the last ${days} days` : "so far";
  const title = daily ? "Daily views" : "Cumulative views";
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
        <div className="publisher-analytics-controls">
          <div className="publisher-analytics-view" role="group" aria-label="Chart view">
            <button type="button" aria-pressed={!daily} onClick={() => setDaily(false)}>
              Cumulative
            </button>
            <button type="button" aria-pressed={daily} onClick={() => setDaily(true)}>
              Daily
            </button>
          </div>
          <select aria-label="Period" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <PeriodOptions />
          </select>
        </div>
      </div>
      <div className="publisher-analytics-total">
        <strong>{number(summary?.value ?? null)}</strong>
        <span className="publisher-note">
          {label} {daily ? `${period}, ` : ""}across every post
        </span>
      </div>
      <figure
        className="publisher-analytics-trend"
        aria-label={points.length ? `${title}: ${number(points[0].value)} to ${number(points.at(-1)!.value)}` : title}
      >
        <div className="publisher-analytics-chart">{plot}</div>
        {summary && <Contributions point={summary} busy={false} />}
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
  metric,
  days,
  loading,
  failed,
  onRetry,
}: {
  samples: Sample[];
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
      <figcaption className="publisher-note">
        Counts are cumulative, stacked by platform. Hourly for the last three days, daily before that; a platform's band
        starts when it first reports.
      </figcaption>
      {!!points.length && <Observations points={points} label={label} />}
    </figure>
  );
}

export default function PublisherAnalytics({ request, online }: Props) {
  const [loaded, setLoaded] = useState<{ cursor: string | null; page: Page } | null>(null);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [selected, setSelected] = useState<string | null>(null);
  const [series, setSeries] = useState<{ post: string; samples: Sample[] } | null>(null);
  const [seriesFailed, setSeriesFailed] = useState(false);
  const [platform, setPlatform] = useState("all");
  const [metric, setMetric] = useState<Metric>("exposure");
  const [days, setDays] = useState(30);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [requesting, setRequesting] = useState(false);
  const [refresh, setRefresh] = useState<Refresh | null>(null);
  const layout = useRef<HTMLDivElement>(null);
  const cursor = cursors.at(-1) ?? null;
  const page = loaded?.page;
  const paging = Boolean(loaded) && loaded?.cursor !== cursor && !error;
  const post = page?.posts.find((p) => p.id === selected) || page?.posts[0];
  const postId = post?.id;
  const refreshing = Boolean(refresh);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const value = await request(`analytics${cursor ? `?before=${encodeURIComponent(cursor)}` : ""}`);
        if (active) {
          setLoaded({ cursor, page: value });
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
  }, [cursor, request, refreshing, attempt]);
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
    setPlatform("all");
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
  function openPost(id: string) {
    setSelected(id);
    layout.current?.scrollIntoView({ block: "start" });
  }
  const targets = post?.targets.filter((t) => platform === "all" || t.platform === platform) || [];
  const reported = (key: keyof Metrics) => Boolean(post?.targets.some((t) => t.metrics?.[key] !== undefined));
  const metricOptions = (Object.keys(metricNames) as Metric[]).filter((key) => {
    if (key === "views") return reported("views") && reported("impressions");
    if (key === "impressions") return reported("impressions");
    if (key === "reach") return platform !== "all" && reported("reach");
    return true;
  });
  const activeMetric = metricOptions.includes(metric) ? metric : "exposure";
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
  const refreshBusy = requesting || refreshing;
  let refreshLabel = "Refresh metrics";
  if (refresh) refreshLabel = `Reading ${refresh.queued.length - checking.size} of ${refresh.queued.length}…`;
  else if (requesting) refreshLabel = "Requesting…";
  let placeholder = <Loading />;
  if (page) placeholder = <p className="publisher-analytics-empty">Publish a post to start tracking performance.</p>;
  else if (error) placeholder = <button onClick={() => setAttempt((n) => n + 1)}>Try again</button>;
  const observations = page?.posts.flatMap((p) => p.targets.map((t) => t.observed_at ?? 0)) ?? [];
  const lastObserved = Math.max(0, ...observations);
  const updated = lastObserved ? `Updated ${timeAgo(lastObserved, Date.now())}` : "No observations yet";
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
      {!!page?.posts.length && (
        <Overview
          request={request}
          observed={observations.join()}
          canOpen={(id) => page.posts.some((p) => p.id === id)}
          onOpen={openPost}
        />
      )}
      {page?.posts.length ? (
        <div className="publisher-analytics-layout" ref={layout}>
          <aside aria-label="Choose a post" aria-busy={paging}>
            <div className="publisher-analytics-posts" data-busy={paging}>
              {page.posts.map((p) => (
                <button key={p.id} aria-pressed={post?.id === p.id} onClick={() => setSelected(p.id)}>
                  <strong>{postLabel(p.post)}</strong>
                  <span>{new Date(p.created_at).toLocaleDateString()}</span>
                  <span>
                    {number(combined(p.targets.map((t) => metricValue(t.metrics, "exposure"))))} views / impressions
                  </span>
                </button>
              ))}
            </div>
            <div className="publisher-history-pagination">
              {paging && <Spinner />}
              <button disabled={cursors.length === 1 || paging} onClick={() => setCursors((v) => v.slice(0, -1))}>
                Newer
              </button>
              <button disabled={!page.next || paging} onClick={() => setCursors((v) => [...v, page.next])}>
                Older
              </button>
            </div>
          </aside>
          {post && (
            <div className="publisher-analytics-detail">
              <div className="publisher-heading">
                <h2>{postLabel(post.post)}</h2>
                <button disabled={!online || refreshBusy} aria-busy={refreshBusy} onClick={startRefresh}>
                  {refreshBusy && <Spinner />}
                  {refreshLabel}
                </button>
              </div>
              <div className="publisher-analytics-filters">
                <label>
                  Platform
                  <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
                    <option value="all">All platforms</option>
                    {post.targets.map((t) => (
                      <option key={t.id} value={t.platform}>
                        {platformNames[t.platform]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Metric
                  <select value={activeMetric} onChange={(e) => setMetric(e.target.value as Metric)}>
                    {metricOptions.map((key) => (
                      <option key={key} value={key}>
                        {metricNames[key]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Chart period
                  <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
                    <PeriodOptions />
                  </select>
                </label>
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
                metric={activeMetric}
                days={days}
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
                        <td>{t.observed_at ? dateTime(t.observed_at) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      ) : (
        placeholder
      )}
    </section>
  );
}
