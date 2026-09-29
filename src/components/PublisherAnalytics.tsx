import { useEffect, useState } from "react";
import { combined, dailySeries, metricValue, type Metric, type Metrics, type Sample } from "@/lib/publisher/metrics";
import { platformNames, type Platform } from "@/lib/publisher/presets";

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
type Props = { request: (path: string, body?: unknown) => Promise<any>; online: boolean };
const number = (value: number | null) => (value === null ? "—" : new Intl.NumberFormat().format(value));
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
function Trend({ samples, metric, days }: { samples: Sample[]; metric: Metric; days: number }) {
  const all = dailySeries(samples, metric);
  const cutoff = days ? new Date(Date.now() - days * 86400000).toISOString().slice(0, 10) : "";
  const points = all.filter((point) => point.day >= cutoff);
  if (!points.length)
    return <div className="publisher-analytics-empty">No observations for this metric in this period.</div>;
  const max = Math.max(1, ...points.map((p) => p.value));
  const start = Date.parse(points[0].day),
    end = Date.parse(points.at(-1)!.day);
  const x = (day: string) => 40 + ((Date.parse(day) - start) / Math.max(86400000, end - start)) * 720;
  const y = (value: number) => 200 - (value / max) * 160;
  const path = points.map((p, i) => `${i ? "H" : "M"}${x(p.day)}${i ? " V" : ","}${y(p.value)}`).join(" ");
  return (
    <figure className="publisher-analytics-trend">
      <svg
        viewBox="0 0 800 245"
        role="img"
        aria-label={`${metricNames[metric]} over time: ${number(points[0].value)} to ${number(points.at(-1)!.value)}`}
      >
        <line x1="40" x2="760" y1="200" y2="200" className="chart-grid" />
        <line x1="40" x2="760" y1="40" y2="40" className="chart-grid" />
        <text x="40" y="26">
          {number(max)}
        </text>
        <text x="40" y="226">
          {points[0].day}
        </text>
        <text x="760" y="226" textAnchor="end">
          {points.at(-1)!.day}
        </text>
        <path d={path} fill="none" stroke="currentColor" strokeWidth="2.5" />
        {points.map((p) => (
          <circle key={p.day} cx={x(p.day)} cy={y(p.value)} r="3" fill="currentColor">
            <title>
              {p.day}: {number(p.value)} · {p.coverage} sources
            </title>
          </circle>
        ))}
      </svg>
      <figcaption className="publisher-note">
        Daily closing observations (UTC). Counts are cumulative; coverage can change as platforms report data.
      </figcaption>
      <details>
        <summary>View observations</summary>
        <div className="publisher-analytics-table">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>{metricNames[metric]}</th>
                <th>Sources</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.day}>
                  <td>{p.day}</td>
                  <td>{number(p.value)}</td>
                  <td>{p.coverage}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
export default function PublisherAnalytics({ request, online }: Props) {
  const [page, setPage] = useState<Page>({ posts: [], next: null });
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [selected, setSelected] = useState<string | null>(null);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [platform, setPlatform] = useState("all");
  const [metric, setMetric] = useState<Metric>("exposure");
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const cursor = cursors.at(-1);
  const post = page.posts.find((p) => p.id === selected) || page.posts[0];
  useEffect(() => {
    let active = true;
    setLoading(true);
    const load = async () => {
      try {
        const value = await request(`analytics${cursor ? `?before=${encodeURIComponent(cursor)}` : ""}`);
        if (active) {
          setPage(value);
          setError("");
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    const timer = setInterval(load, 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [cursor, request]);
  useEffect(() => {
    let active = true;
    setSamples([]);
    setPlatform("all");
    setNotice("");
    if (!post) return;
    const load = async () => {
      try {
        const data = await request(`analytics/${post.id}`);
        if (active) setSamples(data.samples);
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    };
    void load();
    const timer = setInterval(load, 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [post?.id, request]);
  const targets = post?.targets.filter((t) => platform === "all" || t.platform === platform) || [];
  const published = targets.filter((t) => t.state === "succeeded");
  const values = published.map((t) => metricValue(t.metrics, metric));
  const total = combined(values);
  const ids = new Set(targets.map((t) => t.id));
  return (
    <section className="publisher-analytics" aria-label="Post analytics">
      <div className="publisher-heading">
        <h1>Analytics</h1>
        <span className="publisher-note">
          {online ? "Hourly while your helper runs" : "Helper offline · showing saved observations"}
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
      {loading ? (
        <p className="publisher-analytics-empty">Loading analytics…</p>
      ) : !page.posts.length ? (
        <p className="publisher-analytics-empty">Publish a post to start tracking performance.</p>
      ) : (
        <div className="publisher-analytics-layout">
          <aside aria-label="Choose a post">
            <div className="publisher-analytics-posts">
              {page.posts.map((p) => (
                <button key={p.id} aria-pressed={post?.id === p.id} onClick={() => setSelected(p.id)}>
                  <strong>{p.post.title}</strong>
                  <span>{new Date(p.created_at).toLocaleDateString()}</span>
                  <span>
                    {number(combined(p.targets.map((t) => metricValue(t.metrics, "exposure"))))} views / impressions
                  </span>
                </button>
              ))}
            </div>
            <div className="publisher-history-pagination">
              <button disabled={cursors.length === 1} onClick={() => setCursors((v) => v.slice(0, -1))}>
                Newer
              </button>
              <button disabled={!page.next} onClick={() => setCursors((v) => [...v, page.next])}>
                Older
              </button>
            </div>
          </aside>
          {post && (
            <div className="publisher-analytics-detail">
              <div className="publisher-heading">
                <h2>{post.post.title}</h2>
                <button
                  disabled={!online || refreshing}
                  onClick={async () => {
                    setRefreshing(true);
                    setNotice("");
                    try {
                      await request("analytics/refresh", { job: post.id });
                      setNotice(
                        "Refresh requested. The helper checks each destination at most once every five minutes.",
                      );
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setRefreshing(false);
                    }
                  }}
                >
                  Refresh metrics
                </button>
              </div>
              <div className="publisher-analytics-filters">
                <label>
                  Platform
                  <select
                    value={platform}
                    onChange={(e) => {
                      setPlatform(e.target.value);
                      if (e.target.value === "all" && metric === "reach") setMetric("exposure");
                    }}
                  >
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
                  <select value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
                    {Object.entries(metricNames)
                      .filter(([key]) => key !== "reach" || platform !== "all")
                      .map(([key, label]) => (
                        <option key={key} value={key}>
                          {label}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Chart period
                  <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
                    <option value={7}>7 days</option>
                    <option value={30}>30 days</option>
                    <option value={90}>90 days</option>
                    <option value={0}>All time</option>
                  </select>
                </label>
              </div>
              <div className="publisher-analytics-total">
                <span className="publisher-note">
                  Latest {platform === "all" ? "combined " : ""}
                  {metricNames[metric].toLowerCase()}
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
              <Trend samples={samples.filter((s) => ids.has(s.target_id))} metric={metric} days={days} />
              <div className="publisher-analytics-table">
                <table>
                  <thead>
                    <tr>
                      <th>Platform</th>
                      <th>Views / impressions</th>
                      <th>Reach</th>
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
                          {t.url && t.deletion_state !== "deleted" ? (
                            <a href={t.url} target="_blank" rel="noreferrer">
                              {platformNames[t.platform]}
                            </a>
                          ) : (
                            platformNames[t.platform]
                          )}
                          <small>
                            {t.deletion_state === "deleted"
                              ? "Deleted · history retained"
                              : t.state !== "succeeded"
                                ? t.state
                                : t.analytics_error || (!t.observed_at ? "Waiting for first sample" : "")}
                          </small>
                        </th>
                        {(["exposure", "reach", "likes", "comments", "shares", "saves"] as Metric[]).map((key) => (
                          <td key={key}>
                            {number(metricValue(t.metrics, key))}
                            {key === "exposure" && metricValue(t.metrics, key) !== null && (
                              <small>{t.metrics?.impressions !== undefined ? "impressions" : "views"}</small>
                            )}
                          </td>
                        ))}
                        <td>{t.observed_at ? new Date(t.observed_at).toLocaleString() : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
