import { useEffect, useState } from "react";
import { platformNames, type Platform } from "@/lib/publisher/presets";

type Target = {
  id: string;
  platform: Platform;
  state: string;
  url: string | null;
  message: string | null;
  deletion_state: string | null;
  deletion_message: string | null;
};
type Post = {
  id: string;
  created_at: number;
  post: {
    title: string;
    caption: string;
    kind: "photo" | "video";
    media: string[];
    datesTaken?: (string | null)[];
    alt: string;
  };
  targets: Target[];
};
type Page = { posts: Post[]; next: string | null };
type Props = {
  request: (path: string, body?: unknown) => Promise<any>;
  onError: (message: string) => void;
};
const labels: Record<string, string> = {
  queued: "Queued",
  working: "Publishing",
  succeeded: "Published",
  failed: "Failed",
  uncertain: "Check platform",
};
const deletionLabels: Record<string, string> = {
  queued: "Deletion queued",
  working: "Deleting",
  deleted: "Deleted",
  failed: "Deletion failed",
  uncertain: "Check deletion",
};
function Preview({ post }: { post: Post["post"] }) {
  const [expired, setExpired] = useState(false);
  if (expired || !post.media.length)
    return (
      <div className="publisher-history-preview publisher-note">
        {post.kind === "photo" ? "Photo" : "Video"} · Preview unavailable
      </div>
    );
  const src = `/api/publisher/media/${post.media[0]}`;
  return post.kind === "photo" ? (
    <img
      className="publisher-history-preview"
      src={src}
      alt={post.alt || post.title}
      loading="lazy"
      onError={() => setExpired(true)}
    />
  ) : (
    <video className="publisher-history-preview" src={src} controls preload="none" onError={() => setExpired(true)} />
  );
}
export default function PublisherHistory({ request, onError }: Props) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [page, setPage] = useState<Page>({ posts: [], next: null });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const cursor = cursors[cursors.length - 1];
  const path = `history${cursor ? `?before=${encodeURIComponent(cursor)}` : ""}`;
  async function refresh() {
    setPage(await request(path));
  }
  useEffect(() => {
    let active = true;
    setLoading(true);
    const load = async () => {
      try {
        const result = await request(path);
        if (active) setPage(result);
      } catch (error) {
        if (active) onError((error as Error).message);
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(load, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [path, request, onError]);
  async function remove(post: Post, target?: Target) {
    const destinations = target
      ? [target]
      : post.targets.filter((t) => t.state === "succeeded" && t.url && t.deletion_state !== "deleted");
    if (
      !confirm(
        `Permanently delete “${post.post.title}” from ${destinations
          .map((t) => platformNames[t.platform])
          .join(", ")}? This cannot be undone. History will be kept.`,
      )
    )
      return;
    setBusy(true);
    onError("");
    try {
      await request("delete-publications", {
        job: post.id,
        platform: target?.platform,
        confirmed: true,
      });
      await refresh();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function retry(post: Post, target: Target) {
    if (!confirm(`Confirm this post is absent from ${platformNames[target.platform]} before publishing again.`)) return;
    setBusy(true);
    try {
      await request("retry", { job: post.id, platform: target.platform, checked: true });
      await refresh();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="publisher-history" id="history" aria-label="Posting history">
      <div className="publisher-heading">
        <h2>History</h2>
        <span className="publisher-note">Posts sent through this app</span>
      </div>
      {loading ? (
        <p className="publisher-note">Loading history…</p>
      ) : !page.posts.length ? (
        <p className="publisher-history-empty">Your posts will appear here.</p>
      ) : (
        <div className="publisher-history-grid">
          {page.posts.map((post) => {
            const pending = post.targets.some(
              (t) => ["queued", "working"].includes(t.state) || ["queued", "working"].includes(t.deletion_state || ""),
            );
            const removable = post.targets.some(
              (t) => t.state === "succeeded" && t.url && t.deletion_state !== "deleted",
            );
            return (
              <article key={post.id}>
                <Preview post={post.post} />
                <div className="publisher-history-content">
                  <div className="publisher-history-title">
                    <h3>{post.post.title}</h3>
                    <span className="publisher-note">
                      {post.post.kind === "photo"
                        ? `${post.post.media.length} photo${post.post.media.length === 1 ? "" : "s"}`
                        : "Video"}
                    </span>
                  </div>
                  <time dateTime={new Date(post.created_at).toISOString()}>
                    {new Date(post.created_at).toLocaleString()}
                  </time>
                  {post.post.datesTaken?.map(
                    (date, index) =>
                      date && (
                        <p className="publisher-note" key={index}>
                          Photo {index + 1} · Taken {new Date(date).toLocaleString()}
                        </p>
                      ),
                  )}
                  {post.post.caption && <p className="publisher-history-caption">{post.post.caption}</p>}
                  {post.targets.map((target) => (
                    <div className="publisher-history-target" key={target.id}>
                      <div>
                        <span>{platformNames[target.platform]}</span>
                        <span className="publisher-note" role="status">
                          {target.deletion_state
                            ? deletionLabels[target.deletion_state]
                            : labels[target.state] || target.state}
                        </span>
                      </div>
                      <div className="publisher-history-controls">
                        {target.url && target.deletion_state !== "deleted" && (
                          <a href={target.url} target="_blank" rel="noreferrer">
                            View post
                          </a>
                        )}
                        {target.state === "succeeded" &&
                          target.url &&
                          !["queued", "working", "deleted"].includes(target.deletion_state || "") && (
                            <button disabled={busy} onClick={() => void remove(post, target)}>
                              {target.deletion_state ? "Retry deletion" : "Delete"}
                            </button>
                          )}
                        {["failed", "uncertain"].includes(target.state) && !target.deletion_state && (
                          <button disabled={busy} onClick={() => void retry(post, target)}>
                            Retry publishing
                          </button>
                        )}
                      </div>
                      {(target.deletion_message || target.message) && (
                        <p className="publisher-note">{target.deletion_message || target.message}</p>
                      )}
                    </div>
                  ))}
                  {removable && (
                    <button disabled={busy || pending} onClick={() => void remove(post)}>
                      Delete everywhere
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
      <div className="publisher-history-pagination">
        <button
          disabled={loading || busy || cursors.length === 1}
          onClick={() => setCursors((values) => values.slice(0, -1))}
        >
          Newer
        </button>
        <button disabled={loading || busy || !page.next} onClick={() => setCursors((values) => [...values, page.next])}>
          Older
        </button>
      </div>
    </section>
  );
}
