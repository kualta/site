import { useEffect, useState } from "react";
import { ChevronDownIcon, TrashIcon } from "@/components/icons";
import {
  kindNames,
  platformNames,
  platforms,
  postLabel,
  needsTitle as titleFor,
  unsupported,
  type Platform,
  type PostKind,
} from "@/lib/publisher/presets";
import { publicationLink } from "@/lib/publisher/links";
import { parseTags } from "@/lib/publisher/variants";
import type { DraftSummary } from "@/lib/publisher/drafts";
import PublisherChinese, { type ChineseDraft } from "./PublisherChinese";

type Target = {
  id: string;
  platform: Platform;
  state: string;
  url: string | null;
  message: string | null;
  deletion_state: string | null;
  deletion_message: string | null;
  started_at: number | null;
  /** When it publishes, if it was scheduled. */
  scheduled_at?: number | null;
  /** Missing on posts published before it was recorded; started_at is close. */
  finished_at?: number | null;
  deleted_at: number | null;
  /** 1 when the owner published it themselves and linked it here. */
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
    datesTaken?: (string | null)[];
    alt: string;
    alts?: string[];
    tags?: string[];
    zh?: { title: string; text: string; topics: string[] };
  };
  targets: Target[];
};
type Page = { posts: Post[]; next: string | null };
type Props = {
  request: (path: string, body?: unknown, method?: string) => Promise<any>;
  onError: (message: string) => void;
  /** The draft open in the composer, if any. */
  openDraft?: string | null;
  /** Changes when a draft has been posted, so the list is read again. */
  draftsVersion?: number;
  /** Changes when the composer queues a post, so the list shows it at once. */
  postsVersion?: number;
};
type Tone = "ok" | "busy" | "bad" | "warn" | "gone";

/** Whether a destination is still waiting for its scheduled time. */
function waiting(target: Target): boolean {
  return target.state === "queued" && (target.scheduled_at ?? 0) > Date.now();
}
/**
 * Whether a destination is about to change: publishing, being deleted, or queued and due. One waiting for its time
 * isn't, so the list doesn't poll fast for days.
 */
function changing(target: Target): boolean {
  return (
    (["queued", "working"].includes(target.state) && !waiting(target)) ||
    ["queued", "working"].includes(target.deletion_state || "")
  );
}
/** One destination's state in a word or two, deletion first since it follows publishing. */
function status(target: Target): { label: string; tone: Tone } {
  switch (target.deletion_state) {
    case "deleted":
      return { label: "Deleted", tone: "gone" };
    case "queued":
    case "working":
      return { label: "Deleting…", tone: "busy" };
    case "failed":
      return { label: "Deletion failed", tone: "bad" };
    case "uncertain":
      return { label: "Check deletion", tone: "warn" };
  }
  switch (target.state) {
    case "succeeded":
      return { label: target.linked ? "Linked" : "Published", tone: "ok" };
    case "queued":
      return waiting(target)
        ? { label: `Scheduled · ${when(target.scheduled_at as number)}`, tone: "busy" }
        : { label: "Queued", tone: "busy" };
    case "working":
      return { label: "Publishing…", tone: "busy" };
    case "failed":
      return { label: "Failed", tone: "bad" };
    default:
      return { label: "Check platform", tone: "warn" };
  }
}
/** When the destination reached its current state, if it has settled. */
function settledAt(target: Target): number | null {
  if (target.deletion_state) return target.deletion_state === "deleted" ? target.deleted_at : null;
  if (!["succeeded", "failed", "uncertain"].includes(target.state)) return null;
  return target.finished_at ?? target.started_at;
}
function when(time: number): string {
  const date = new Date(time);
  const today = date.toDateString() === new Date().toDateString();
  return date.toLocaleString(undefined, {
    ...(today ? {} : { month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
}
function day(time: number): string {
  const date = new Date(time);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
}
/** "Expires in 6 days", "Expires in 5 hours", "Expires within the hour". */
function expiresIn(at: number): string {
  const hours = Math.floor((at - Date.now()) / 3_600_000);
  if (hours < 1) return "Expires within the hour";
  if (hours < 48) return `Expires in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  return `Expires in ${Math.floor(hours / 24)} days`;
}
/** Posts arrive newest first, so each day's posts are consecutive. */
function byDay(posts: Post[]): { day: string; posts: Post[] }[] {
  const groups: { day: string; posts: Post[] }[] = [];
  for (const post of posts) {
    const label = day(post.created_at);
    if (groups.at(-1)?.day === label) groups.at(-1)?.posts.push(post);
    else groups.push({ day: label, posts: [post] });
  }
  return groups;
}
function Thumbnail({ post }: { post: Post["post"] }) {
  const [expired, setExpired] = useState(false);
  if (post.kind === "text") return null;
  const src = `/api/publisher/media/${post.media[0]}`;
  let preview: React.ReactNode;
  // Uploads expire after seven days; the history stays.
  if (expired || !post.media.length) preview = <span>{kindNames[post.kind]}</span>;
  else if ((post.mediaKinds?.[0] ?? post.kind) === "photo")
    preview = <img src={src} alt={post.alts?.[0] || post.alt || ""} loading="lazy" onError={() => setExpired(true)} />;
  else preview = <video src={`${src}#t=0.1`} preload="metadata" muted onError={() => setExpired(true)} />;
  return (
    <div className="publisher-history-thumb">
      {preview}
      {post.media.length > 1 && <small>{post.media.length}</small>}
    </div>
  );
}
/**
 * Where the post can go out now: destinations it hasn't reached, and ones it reached only under an earlier sign-in,
 * which may have been another account.
 */
function crosspostOptions(post: Post): Platform[] {
  return platforms.filter((p) => !post.targets.some((t) => t.platform === p && !t.earlier_sign_in));
}
/** Sends a post that already went out to destinations it hasn't reached yet. */
function Crosspost({ post, request, onDone, onError }: Props & { post: Post; onDone: () => Promise<void> }) {
  const [chosen, setChosen] = useState<Platform[]>([]);
  const [title, setTitle] = useState("");
  const [zh, setZh] = useState<ChineseDraft>({ title: "", text: "", topics: "" });
  const [translating, setTranslating] = useState(false);
  const [busy, setBusy] = useState(false);
  const { kind, media } = post.post;
  const options = crosspostOptions(post);
  // Asked only when the post went out without them.
  const needsTitle = !post.post.title.trim() && chosen.some((p) => titleFor(p, kind));
  const needsChinese = !post.post.zh && chosen.includes("xiaohongshu");
  async function translate() {
    setTranslating(true);
    onError("");
    try {
      const draft = await request("translate", {
        title: post.post.title,
        text: post.post.caption,
        tags: post.post.tags ?? [],
      });
      setZh({ title: draft.title, text: draft.text, topics: draft.topics.join(" ") });
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setTranslating(false);
    }
  }
  async function send() {
    setBusy(true);
    onError("");
    try {
      await request("crosspost", {
        job: post.id,
        platforms: chosen,
        ...(needsTitle ? { title } : {}),
        ...(needsChinese ? { zh: { title: zh.title, text: zh.text, topics: parseTags(zh.topics) } } : {}),
      });
      setChosen([]);
      await onDone();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!options.length) return null;
  return (
    <fieldset className="publisher-crosspost">
      <legend>Crosspost to</legend>
      <div className="publisher-crosspost-options">
        {options.map((platform) => {
          const reason = unsupported(platform, kind, media.length);
          const again = post.targets.some((t) => t.platform === platform);
          return (
            <label key={platform} data-unavailable={Boolean(reason)}>
              <span>
                {platformNames[platform]}
                {reason ? <small>{reason}</small> : again && <small>Again · earlier sign-in</small>}
              </span>
              <input
                type="checkbox"
                checked={chosen.includes(platform)}
                disabled={busy || Boolean(reason)}
                onChange={() =>
                  setChosen((list) =>
                    list.includes(platform) ? list.filter((p) => p !== platform) : [...list, platform],
                  )
                }
              />
            </label>
          );
        })}
      </div>
      {needsTitle && (
        <label>
          Title ·{" "}
          {chosen
            .filter((p) => titleFor(p, kind))
            .map((p) => platformNames[p])
            .join(", ")}
          <input value={title} maxLength={100} disabled={busy} onChange={(e) => setTitle(e.target.value)} />
        </label>
      )}
      {needsChinese && (
        <PublisherChinese
          value={zh}
          onChange={setZh}
          onTranslate={() => void translate()}
          translating={translating}
          canTranslate={Boolean(post.post.title.trim() || post.post.caption.trim())}
          disabled={busy}
        />
      )}
      <button disabled={busy || !chosen.length} onClick={() => void send()}>
        {busy
          ? "Queueing…"
          : chosen.length
            ? `Crosspost to ${chosen.length} ${chosen.length === 1 ? "place" : "places"}`
            : "Crosspost"}
      </button>
    </fieldset>
  );
}
/** Adds a post the owner published themselves, such as a repost on a new account, so its stats count toward this one. */
function LinkPost({ post, request, onDone, onError }: Props & { post: Post; onDone: () => Promise<void> }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const link = url.trim() ? publicationLink(url) : null;
  const ready = link && !("error" in link) ? link : null;
  async function send() {
    setBusy(true);
    onError("");
    try {
      await request("link", { job: post.id, url: url.trim() });
      setUrl("");
      await onDone();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <fieldset className="publisher-crosspost">
      <legend>Link a post</legend>
      <label>
        Link
        <input
          type="url"
          value={url}
          placeholder="https://www.tiktok.com/@name/video/…"
          disabled={busy}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && ready && !busy) void send();
          }}
        />
      </label>
      {link && "error" in link && <p className="publisher-note">{link.error}</p>}
      <button disabled={busy || !ready} onClick={() => void send()}>
        {busy ? "Linking…" : ready ? `Link ${platformNames[ready.platform]} post` : "Link post"}
      </button>
    </fieldset>
  );
}
export default function PublisherHistory({ request, onError, openDraft, draftsVersion, postsVersion }: Props) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  // Sent from the terminal and waiting in Cloudflare to be opened and published.
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [deletingDraft, setDeletingDraft] = useState<string | null>(null);
  const [page, setPage] = useState<Page>({ posts: [], next: null });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const cursor = cursors[cursors.length - 1];
  const path = `history${cursor ? `?before=${encodeURIComponent(cursor)}` : ""}`;
  async function refresh() {
    setPage(await request(path));
  }
  // Every read counts against D1's daily cap. A destination that's publishing or being deleted changes within seconds,
  // so it's watched closely; otherwise the list changes only when the composer or this page changes it. A hidden tab
  // reads nothing and catches up when it's shown.
  const pending = page.posts.some((post) => post.targets.some(changing));
  useEffect(() => setLoading(true), [path]);
  useEffect(() => {
    let active = true;
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
    const poll = () => {
      if (!document.hidden) void load();
    };
    const timer = window.setInterval(poll, pending ? 5000 : 60_000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [path, request, onError, pending, postsVersion]);
  useEffect(() => {
    let active = true;
    let reported = false;
    const load = async () => {
      try {
        const result = await request("drafts");
        if (active) setDrafts(result.drafts);
      } catch (error) {
        // Said once; the list keeps what it last read and tries again.
        if (active && !reported) onError((error as Error).message);
        reported = true;
      }
    };
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [request, onError, draftsVersion]);
  async function deleteDraft(draft: DraftSummary) {
    if (
      !confirm(
        `Delete the draft “${draft.title || draft.caption}” and the videos uploaded with it? This can't be undone.`,
      )
    )
      return;
    setDeletingDraft(draft.id);
    onError("");
    try {
      await request(`drafts/${draft.id}`, undefined, "DELETE");
      setDrafts((list) => list.filter((item) => item.id !== draft.id));
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setDeletingDraft(null);
    }
  }
  async function remove(post: Post, target?: Target) {
    const destinations = target
      ? [target]
      : post.targets.filter((t) => t.state === "succeeded" && t.url && t.deletion_state !== "deleted");
    if (
      !confirm(
        `Delete “${postLabel(post.post)}” from ${destinations
          .map((t) => platformNames[t.platform])
          .join(", ")}? This can't be undone.`,
      )
    )
      return;
    setBusy(true);
    onError("");
    try {
      await request("delete-publications", { job: post.id, target: target?.id, confirmed: true });
      await refresh();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function stop(post: Post, target: Target) {
    setBusy(true);
    onError("");
    try {
      await request("stop", { job: post.id, target: target.id });
      await refresh();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function markPublished(post: Post, target: Target) {
    const url = prompt(`Paste the link to this post on ${platformNames[target.platform]}.`)?.trim();
    if (!url) return;
    setBusy(true);
    onError("");
    try {
      await request("mark-published", { job: post.id, target: target.id, url });
      await refresh();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function retry(post: Post, target: Target) {
    if (!confirm(`Publish again? Check it isn't already on ${platformNames[target.platform]}.`)) return;
    setBusy(true);
    try {
      await request("retry", { job: post.id, target: target.id, checked: true });
      await refresh();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function unlink(post: Post, target: Target) {
    if (
      !confirm(
        `Unlink this ${platformNames[target.platform]} post from “${postLabel(post.post)}”? It stays up on ${
          platformNames[target.platform]
        }.`,
      )
    )
      return;
    setBusy(true);
    onError("");
    try {
      await request("unlink", { job: post.id, target: target.id });
      await refresh();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function item(post: Post) {
    const { title, caption } = post.post;
    const pending = post.targets.some(changing);
    const removable = post.targets.some((t) => t.state === "succeeded" && t.url && t.deletion_state !== "deleted");
    const deleted = post.targets.every((t) => t.deletion_state === "deleted");
    const problems = post.targets.filter((t) => ["bad", "warn"].includes(status(t).tone));
    const dates = (post.post.datesTaken ?? []).flatMap((date, index) => (date ? [{ date, index }] : []));
    const crosspostable = !deleted && crosspostOptions(post).length > 0;
    const stoppable = post.targets.some((t) => ["queued", "working"].includes(t.state));
    const manageable = !deleted || removable || problems.length > 0 || dates.length > 0 || stoppable;
    const expanded = open === post.id;
    return (
      <li key={post.id} className="publisher-history-item" data-deleted={deleted}>
        <Thumbnail post={post.post} />
        <div className="publisher-history-body">
          <div className="publisher-history-head">
            <p className="publisher-history-text" data-title={Boolean(title)}>
              {title || caption}
            </p>
            <time dateTime={new Date(post.created_at).toISOString()}>
              {new Date(post.created_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
            </time>
          </div>
          {title && caption && <p className="publisher-history-caption">{caption}</p>}
          <ul className="publisher-history-pills" aria-label="Destinations">
            {post.targets.map((target) => {
              const { label, tone } = status(target);
              const name = platformNames[target.platform];
              return (
                <li key={target.id} className="publisher-history-pill" data-tone={tone}>
                  {tone === "ok" && target.url ? (
                    <a href={target.url} target="_blank" rel="noreferrer" title={`View on ${name}`}>
                      {name}
                    </a>
                  ) : (
                    <span>{name}</span>
                  )}
                  {tone !== "ok" && <small>{label}</small>}
                </li>
              );
            })}
            {manageable && (
              <li>
                <button
                  className="publisher-history-manage"
                  aria-expanded={expanded}
                  aria-controls={`manage-${post.id}`}
                  onClick={() => setOpen(expanded ? null : post.id)}
                >
                  {expanded ? "Close" : "Manage"}
                  <ChevronDownIcon size={14} />
                </button>
              </li>
            )}
          </ul>
          {problems.map((target) => (
            <p key={target.id} className="publisher-history-problem">
              {platformNames[target.platform]}: {target.deletion_message || target.message || status(target).label}
            </p>
          ))}
          {manageable && (
            // Stays mounted so opening and closing can animate; inert keeps it out of reach while closed.
            <div id={`manage-${post.id}`} className="publisher-history-panel" data-open={expanded} inert={!expanded}>
              <div>
                <div className="publisher-history-panel-body">
                  {post.targets.map((target) => {
                    const name = platformNames[target.platform];
                    const at = settledAt(target);
                    const summary = (
                      <>
                        <span>{name}</span>
                        <span className="publisher-note" role="status">
                          {status(target).label}
                          {at && <time dateTime={new Date(at).toISOString()}> · {when(at)}</time>}
                          {!!target.earlier_sign_in && !target.deletion_state && " · earlier sign-in"}
                        </span>
                      </>
                    );
                    return (
                      <div key={target.id} className="publisher-history-panel-row">
                        {target.url && target.deletion_state !== "deleted" ? (
                          <a href={target.url} target="_blank" rel="noreferrer" title={`View on ${name}`}>
                            {summary}
                          </a>
                        ) : (
                          <div>{summary}</div>
                        )}
                        {target.state === "succeeded" &&
                          target.url &&
                          !["queued", "working", "deleted"].includes(target.deletion_state || "") && (
                            <button
                              className="publisher-history-icon"
                              disabled={busy}
                              aria-label={target.deletion_state ? `Retry deleting from ${name}` : `Delete from ${name}`}
                              title={target.deletion_state ? "Retry deletion" : "Delete"}
                              onClick={() => void remove(post, target)}
                            >
                              <TrashIcon size={16} />
                            </button>
                          )}
                        {["queued", "working"].includes(target.state) && (
                          <button
                            disabled={busy}
                            aria-label={`Stop publishing to ${name}`}
                            onClick={() => void stop(post, target)}
                          >
                            Stop
                          </button>
                        )}
                        {!!target.linked && !["queued", "working"].includes(target.deletion_state || "") && (
                          <button
                            disabled={busy}
                            aria-label={`Unlink this ${name} post`}
                            onClick={() => void unlink(post, target)}
                          >
                            Unlink
                          </button>
                        )}
                        {target.state === "uncertain" && !target.deletion_state && (
                          <button disabled={busy} onClick={() => void markPublished(post, target)}>
                            Mark as published
                          </button>
                        )}
                        {["failed", "uncertain"].includes(target.state) && !target.deletion_state && (
                          <button disabled={busy} onClick={() => void retry(post, target)}>
                            Retry publishing
                          </button>
                        )}
                      </div>
                    );
                  })}
                  {dates.map(({ date, index }) => (
                    <p key={index} className="publisher-note">
                      Photo {index + 1} · taken {new Date(date).toLocaleString()}
                    </p>
                  ))}
                  {crosspostable && <Crosspost post={post} request={request} onDone={refresh} onError={onError} />}
                  {!deleted && <LinkPost post={post} request={request} onDone={refresh} onError={onError} />}
                  {removable && (
                    <button disabled={busy || pending} onClick={() => void remove(post)}>
                      Delete everywhere
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </li>
    );
  }
  function draftItem(draft: DraftSummary) {
    const inComposer = draft.id === openDraft;
    return (
      <li key={draft.id} className="publisher-history-item" data-draft={draft.id}>
        <Thumbnail
          post={{
            title: draft.title,
            caption: draft.caption,
            kind: "video",
            media: [draft.cover ?? draft.video],
            mediaKinds: [draft.cover ? "photo" : "video"],
            alt: "",
          }}
        />
        <div className="publisher-history-body">
          <div className="publisher-history-head">
            <p className="publisher-history-text">{draft.title || draft.caption}</p>
            <time dateTime={new Date(draft.created).toISOString()}>{when(draft.created)}</time>
          </div>
          {draft.title && draft.caption && <p className="publisher-history-caption">{draft.caption}</p>}
          <ul className="publisher-history-pills" aria-label="Status">
            <li>
              {inComposer ? (
                <span className="publisher-history-here">In the composer</span>
              ) : (
                <a className="publisher-history-open" href={`?draft=${draft.id}`}>
                  Open
                </a>
              )}
            </li>
            {!inComposer && (
              <li>
                <button
                  className="publisher-history-icon"
                  disabled={deletingDraft !== null}
                  aria-label={`Delete the draft ${draft.title || draft.caption}`}
                  title="Delete draft"
                  onClick={() => void deleteDraft(draft)}
                >
                  <TrashIcon size={16} />
                </button>
              </li>
            )}
            <li className="publisher-history-meta">
              {expiresIn(draft.expires)}
              {draft.chinese && " · Chinese version"}
            </li>
          </ul>
        </div>
      </li>
    );
  }
  return (
    <section className="publisher-history" id="history" aria-label="Posting history">
      <h2>History</h2>
      {cursors.length === 1 && !!drafts.length && (
        <section aria-label="Drafts">
          <h3 className="publisher-history-day">Drafts</h3>
          <ul className="publisher-history-list">{drafts.map(draftItem)}</ul>
        </section>
      )}
      {loading ? (
        <p className="publisher-note">Loading history…</p>
      ) : !page.posts.length ? (
        <p className="publisher-history-empty">No posts yet.</p>
      ) : (
        byDay(page.posts).map((group) => (
          <section key={group.day} aria-label={group.day}>
            <h3 className="publisher-history-day">{group.day}</h3>
            <ul className="publisher-history-list">{group.posts.map(item)}</ul>
          </section>
        ))
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
