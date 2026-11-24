import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon, TrashIcon, VideoIcon } from "@/components/icons";
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
import { pieceNumber } from "@/lib/publisher/content";
import { publicationLink } from "@/lib/publisher/links";
import { localInput } from "@/lib/publisher/schedule";
import { coverPlatforms, STOPPED_BEFORE } from "@/lib/publisher/server";
import { parseTags } from "@/lib/publisher/variants";
import type { DraftSummary } from "@/lib/publisher/drafts";
import { frameAt } from "@/lib/publisher/frame";
import MediaButton from "./MediaButton";
import PlatformIcon from "./PlatformIcon";
import PublisherChinese, { type ChineseDraft } from "./PublisherChinese";
import PublisherCover, { type Cover } from "./PublisherCover";
import PublisherSteady from "./PublisherSteady";

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
  /** The number of the Pipeline piece it went out as, when that has one. */
  number?: number | null;
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
    zh?: { title: string; text: string; topics: string[]; video?: string };
  };
  targets: Target[];
  /** For a video post, the uploads the bucket has expired. */
  expired?: string[];
};
type Page = { posts: Post[]; next: string | null };
type Props = {
  request: (path: string, body?: unknown, method?: string) => Promise<any>;
  onError: (message: string) => void;
  /** The composer's path, where a draft opens. */
  composer: string;
  /** The draft open in the composer, if any. */
  openDraft?: string | null;
  /** Changes when a draft has been posted, so the list is read again. */
  draftsVersion?: number;
  /** Changes when the composer queues a post, so the list shows it at once. */
  postsVersion?: number;
};
/** What an action on one post in the list needs. */
type PostActionProps = Pick<Props, "request" | "onError"> & { post: Post; onDone: () => Promise<void> };
type Tone = "ok" | "busy" | "bad" | "warn" | "gone";

/** Whether a destination was stopped before it published, so it can be scheduled again. */
function stopped(target: Target): boolean {
  return target.state === "failed" && target.message === STOPPED_BEFORE;
}
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
      // Stopped before it published, it never reached the platform: nothing went wrong.
      return stopped(target) ? { label: "Stopped", tone: "gone" } : { label: "Failed", tone: "bad" };
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
  // Uploads expire after 31 days; the history stays.
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
function Crosspost({ post, request, onDone, onError }: PostActionProps) {
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
/** Which of a video post's videos the bucket has expired: its own, and its Chinese version's. */
function expiredVideos(post: Post): { video: boolean; zh: boolean } {
  const expired = post.post.kind === "video" ? post.expired ?? [] : [];
  const zh = post.post.zh?.video;
  return { video: expired.includes(post.post.media[0]), zh: Boolean(zh && expired.includes(zh)) };
}
/** One video, up to the upload limit, or a reason it can't go up. */
function videoProblem(file: File): string | null {
  return file.type.startsWith("video/") && file.size <= 90e6 ? null : "Choose one video, up to 90 MB.";
}
async function upload(file: File): Promise<string> {
  const response = await fetch("/api/publisher/media", {
    method: "POST",
    headers: { "Content-Type": file.type },
    body: file,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Upload failed");
  return result.id;
}
/** Puts a video post's expired video back, so its destinations can be retried and it can be crossposted. */
function Reupload({ post, request, onDone, onError }: PostActionProps) {
  const [video, setVideo] = useState<File>();
  const [zhVideo, setZhVideo] = useState<File>();
  const [cover, setCover] = useState<Cover>();
  const [busy, setBusy] = useState(false);
  const expired = expiredVideos(post);
  function choose(file: File | undefined, set: (file: File) => void) {
    if (!file) return;
    const problem = videoProblem(file);
    if (problem) return onError(problem);
    onError("");
    set(file);
  }
  async function send() {
    setBusy(true);
    onError("");
    try {
      const ids: Record<string, string> = {};
      if (video) ids.video = await upload(video);
      if (cover) ids.cover = await upload(cover.file);
      if (zhVideo) ids.zhVideo = await upload(zhVideo);
      // Xiaohongshu's Chinese version gets its own cover: its frame at the chosen moment.
      if (cover && zhVideo) ids.zhCover = await upload(await frameAt(zhVideo, cover.at ?? 0, "cover-zh.jpg"));
      await request("replace-media", { job: post.id, ...ids });
      setVideo(undefined);
      setZhVideo(undefined);
      setCover(undefined);
      await onDone();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <fieldset className="publisher-crosspost publisher-reupload">
      <legend>Upload again</legend>
      <p className="publisher-note">The {expired.video ? "video" : "Chinese video"} expired.</p>
      {expired.video && (
        <div className="publisher-reupload-file">
          <MediaButton
            accept="video/*"
            label={video ? "Choose another video" : "Video"}
            hint="Up to 90 MB"
            Icon={VideoIcon}
            disabled={busy}
            onFiles={([file]) =>
              choose(file, (next) => {
                setVideo(next);
                setCover(undefined);
              })
            }
          />
          {video && <span className="publisher-note">{video.name}</span>}
        </div>
      )}
      {expired.zh && (
        <div className="publisher-reupload-file">
          <MediaButton
            accept="video/*"
            label={zhVideo ? "Choose another Chinese video" : "Chinese video"}
            hint="Up to 90 MB"
            Icon={VideoIcon}
            disabled={busy}
            onFiles={([file]) => choose(file, setZhVideo)}
          />
          {zhVideo && <span className="publisher-note">{zhVideo.name}</span>}
        </div>
      )}
      {video && (
        <PublisherCover
          video={video}
          value={cover}
          onChange={setCover}
          platforms={coverPlatforms.map((p) => platformNames[p]).join(", ")}
          disabled={busy}
          onError={onError}
        />
      )}
      <button disabled={busy || (!video && !zhVideo)} onClick={() => void send()}>
        {busy ? "Uploading…" : "Upload"}
      </button>
    </fieldset>
  );
}
function LinkPost({ post, request, onDone, onError }: PostActionProps) {
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
      {/* Beside the button, in a place of its own, so what's wrong with a link moves nothing as it's typed. */}
      <div className="publisher-link-send">
        <button disabled={busy || !ready} onClick={() => void send()}>
          <PublisherSteady among={[`Link ${platformNames.xiaohongshu} post`]}>
            {busy ? "Linking…" : ready ? `Link ${platformNames[ready.platform]} post` : "Link post"}
          </PublisherSteady>
        </button>
        <p className="publisher-note">{link && "error" in link && link.error}</p>
      </div>
    </fieldset>
  );
}
export default function PublisherHistory({
  request,
  onError,
  composer,
  openDraft,
  draftsVersion,
  postsVersion,
}: Props) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  // Sent from the terminal and waiting in Cloudflare to be opened and published.
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [draftsRead, setDraftsRead] = useState(false);
  const [deletingDraft, setDeletingDraft] = useState<string | null>(null);
  // The page shown, which stays until the next one is in, and the last one that couldn't be read.
  const [loaded, setLoaded] = useState<{ path: string; page: Page } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  // The destination whose time is being changed, and the time typed so far.
  const [retiming, setRetiming] = useState<{ target: string; value: string } | null>(null);
  const cursor = cursors[cursors.length - 1];
  const path = `history${cursor ? `?before=${encodeURIComponent(cursor)}` : ""}`;
  const page: Page = loaded?.page ?? { posts: [], next: null };
  const turning = loaded !== null && loaded.path !== path && failed !== path;
  async function refresh() {
    setLoaded({ path, page: await request(path) });
  }
  // Posts seen on their way out since the tab opened: each keeps a line for what comes of it, so it moves nothing.
  const watched = useRef(new Set<string>());
  for (const post of page.posts)
    if (post.targets.some((target) => changing(target) || waiting(target))) watched.current.add(post.id);
  // Every read counts against D1's daily cap. A destination that's publishing or being deleted changes within seconds,
  // so it's watched closely; otherwise the list changes only when the composer or this page changes it. A hidden tab
  // reads nothing and catches up when it's shown.
  const pending = page.posts.some((post) => post.targets.some(changing));
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const result = await request(path);
        if (!active) return;
        setLoaded({ path, page: result });
        setFailed(null);
      } catch (error) {
        if (!active) return;
        onError((error as Error).message);
        setFailed(path);
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
      } finally {
        if (active) setDraftsRead(true);
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
  /** Moves a scheduled destination to a new time, or schedules a stopped one again. */
  async function reschedule(post: Post, target: Target, value: string) {
    const at = new Date(value).getTime();
    if (!Number.isFinite(at)) return onError("Choose a day and time.");
    setBusy(true);
    onError("");
    try {
      await request("reschedule", { job: post.id, target: target.id, at });
      setRetiming(null);
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
    const { video: videoExpired, zh: zhExpired } = expiredVideos(post);
    const reuploadable = !deleted && (videoExpired || zhExpired);
    const stoppable = post.targets.some((t) => ["queued", "working"].includes(t.state));
    const manageable = !deleted || removable || problems.length > 0 || dates.length > 0 || stoppable;
    const expanded = open === post.id;
    const watching = watched.current.has(post.id);
    const said = problems.map(
      (target) =>
        `${platformNames[target.platform]}: ${target.deletion_message || target.message || status(target).label}`,
    );
    const underWay = post.targets
      .filter((target) => status(target).tone === "busy")
      .map((target) => `${platformNames[target.platform]}: ${status(target).label}`);
    const progress = (said.length ? said : underWay).join(" · ");
    return (
      <li key={post.id} className="publisher-history-item" data-deleted={deleted}>
        <Thumbnail post={post.post} />
        <div className="publisher-history-body">
          <div className="publisher-history-head">
            <p className="publisher-history-text" data-title={Boolean(title)}>
              {post.number ? `${pieceNumber(post.number)} · ` : ""}
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
              // Only the mark shows, so its name and state are what's read out and shown on hover.
              const described = `${name}: ${label}`;
              const icon = <PlatformIcon platform={target.platform} size={16} />;
              return (
                <li key={target.id} className="publisher-history-pill" data-tone={tone}>
                  {tone === "ok" && target.url ? (
                    <a
                      href={target.url}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={described}
                      title={`View on ${name}`}
                    >
                      {icon}
                    </a>
                  ) : (
                    <span role="img" aria-label={described} title={described}>
                      {icon}
                    </span>
                  )}
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
                  <PublisherSteady among={["Manage"]}>{expanded ? "Close" : "Manage"}</PublisherSteady>
                  <ChevronDownIcon size={14} />
                </button>
              </li>
            )}
          </ul>
          {watching ? (
            // One line whatever it says, which opens to the rest of it.
            <details
              className="publisher-history-progress"
              data-problem={said.length > 0 || undefined}
              inert={!progress}
            >
              <summary>{progress}</summary>
            </details>
          ) : (
            said.map((line, i) => (
              <p key={problems[i].id} className="publisher-history-problem">
                {line}
              </p>
            ))
          )}
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
                        {retiming?.target === target.id ? (
                          <form
                            className="publisher-history-retime"
                            onSubmit={(event) => {
                              event.preventDefault();
                              void reschedule(post, target, retiming.value);
                            }}
                          >
                            <input
                              type="datetime-local"
                              aria-label={`New time for ${name}`}
                              value={retiming.value}
                              min={localInput(Date.now())}
                              max={localInput(Date.now() + 7 * 86_400_000)}
                              onChange={(event) => setRetiming({ target: target.id, value: event.target.value })}
                            />
                            <button type="submit" disabled={busy}>
                              Save
                            </button>
                            <button type="button" onClick={() => setRetiming(null)}>
                              Cancel
                            </button>
                          </form>
                        ) : (
                          (target.state === "queued" || stopped(target)) && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                setRetiming({
                                  target: target.id,
                                  value: localInput(
                                    target.state === "queued" && target.scheduled_at
                                      ? target.scheduled_at
                                      : Date.now() + 3_600_000,
                                  ),
                                })
                              }
                            >
                              {target.state === "queued" ? "Change time" : "Schedule again"}
                            </button>
                          )
                        )}
                        {["queued", "working"].includes(target.state) && retiming?.target !== target.id && (
                          <button
                            disabled={busy}
                            aria-label={`${waiting(target) ? "Cancel" : "Stop"} publishing to ${name}`}
                            onClick={() => void stop(post, target)}
                          >
                            {waiting(target) ? "Cancel" : "Stop"}
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
                  {reuploadable && <Reupload post={post} request={request} onDone={refresh} onError={onError} />}
                  {crosspostable && <Crosspost post={post} request={request} onDone={refresh} onError={onError} />}
                  {!deleted && <LinkPost post={post} request={request} onDone={refresh} onError={onError} />}
                  {(removable || watching) && (
                    <button
                      data-unsaid={!removable || undefined}
                      disabled={busy || pending}
                      onClick={() => void remove(post)}
                    >
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
                <a className="publisher-history-open" href={`${composer}?draft=${draft.id}`}>
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
  // Drafts come above the posts, so nothing shows until both are in or can't be read.
  const shown = draftsRead && (loaded !== null || failed !== null);
  return (
    <section className="publisher-history" aria-label="Posting history" aria-busy={!shown || turning}>
      <h1 className="publisher-hidden">History</h1>
      {shown && (loaded?.path ?? path) === "history" && !!drafts.length && (
        <section aria-label="Drafts">
          <h3 className="publisher-history-day">Drafts</h3>
          <ul className="publisher-history-list">{drafts.map(draftItem)}</ul>
        </section>
      )}
      {!shown && <p className="publisher-note">Loading history…</p>}
      {shown && !loaded && <p className="publisher-history-empty">History didn't load. Trying again…</p>}
      {shown && loaded && !page.posts.length && <p className="publisher-history-empty">No posts yet.</p>}
      {shown &&
        byDay(page.posts).map((group) => (
          <section key={group.day} aria-label={group.day}>
            <h3 className="publisher-history-day">{group.day}</h3>
            <ul className="publisher-history-list">{group.posts.map(item)}</ul>
          </section>
        ))}
      {shown && loaded && (
        <div className="publisher-history-pagination">
          <button
            disabled={turning || busy || cursors.length === 1}
            onClick={() => setCursors((values) => values.slice(0, -1))}
          >
            Newer
          </button>
          <button
            disabled={turning || busy || !page.next}
            onClick={() => setCursors((values) => [...values, page.next])}
          >
            Older
          </button>
        </div>
      )}
    </section>
  );
}
