import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUpRightIcon, CloseIcon, PlusIcon, TrashIcon } from "@/components/icons";
import {
  MAX_CONTENT_NOTES,
  MAX_CONTENT_TITLE,
  stageNames,
  stages,
  type Content,
  type PiecePost,
  type Stage,
} from "@/lib/publisher/content";
import { dayOf, type FootageLink, footageLine, type Ledger, linkedClips } from "@/lib/publisher/ledger";
import { combined, metricValue, type Metric } from "@/lib/publisher/metrics";
import { platformNames } from "@/lib/publisher/presets";
import { previewSources, storedThumbnail } from "@/lib/publisher/preview";
import PlatformIcon from "./PlatformIcon";

type Props = {
  request: (path: string, body?: unknown, method?: string) => Promise<any>;
  onError: (message: string) => void;
  /** Opens the composer for a piece, so the post it queues moves the piece to Posted. */
  onCompose: (id: string) => void;
  /** Where a posted piece's numbers are. */
  statsHref: (job: string) => string;
  /** Changes when the composer queues a post, which can move a piece to Posted. */
  postsVersion?: number;
};

const DAY = 86_400_000;
/** When a piece reached its stage, as the card says it. */
function since(at: number, now = Date.now()) {
  const days =
    Math.floor(new Date(now).setHours(0, 0, 0, 0) / DAY) - Math.floor(new Date(at).setHours(0, 0, 0, 0) / DAY);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 14) return `${days} days ago`;
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
const newestFirst = (items: Content[]) => [...items].sort((a, b) => b.stage_at - a.stage_at);
const count = new Intl.NumberFormat();
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
/** A column of counts added up across destinations, or null when none has been read. */
const total = (post: PiecePost, metric: Metric) =>
  combined(post.targets.map((target) => metricValue(target.metrics, metric)));
const statColumns: [Metric, string][] = [
  ["exposure", "Views"],
  ["likes", "Likes"],
  ["comments", "Comments"],
  ["shares", "Shares"],
];
const YOUTUBE_STILL = "https://i.ytimg.com/";

/** A piece's footage, as its card and editor say it: the film's or the day's clips, how many graded and at risk. */
function footageText(link: FootageLink | undefined, ledger: Ledger | null) {
  if (!link) return null;
  const clips = linkedClips(link, ledger);
  if (clips === null) return link.project ? `${link.project} · not seen yet` : null;
  return `${link.project ?? dayName(link.day ?? "")} · ${footageLine(clips)}`;
}
const dayName = (day: string) =>
  new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
/** The value of the editor's Footage choice for a link, and back. */
const choiceOf = (link: FootageLink | undefined) => {
  if (link?.project) return `project:${link.project}`;
  if (link?.day) return `day:${link.day}`;
  return "";
};
function linkOf(choice: string): FootageLink {
  if (choice.startsWith("project:")) return { project: choice.slice("project:".length) };
  if (choice.startsWith("day:")) return { day: choice.slice("day:".length) };
  return {};
}

/**
 * A piece on the board. Once posted it's its post's picture (kept thumbnail, cover, YouTube still or first upload,
 * whichever loads) with what it is over the top; until then, or without a picture, its title and notes.
 */
function Card({
  piece,
  footage,
  carried,
  onOpen,
  onDragStart,
  onDragEnd,
}: {
  piece: Content;
  /** Its footage in a line, until it's posted. */
  footage: string | null;
  carried: boolean;
  onOpen: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const post = piece.post;
  const sources =
    post && piece.job_id
      ? previewSources(
          post,
          post.targets.filter((target) => !target.deleted).map((target) => target.url),
          piece.thumbnail !== null ? storedThumbnail(piece.job_id, piece.thumbnail) : null,
        )
      : [];
  const [failed, setFailed] = useState(0);
  const source = sources[failed];
  const next = () => setFailed((n) => n + 1);
  const views = post && total(post, "exposure");
  let picture = null;
  if (source?.video) picture = <video src={source.src} preload="metadata" muted playsInline onError={next} />;
  else if (source)
    picture = (
      <img
        src={source.src}
        alt=""
        loading="lazy"
        draggable={false}
        onError={next}
        // YouTube answers a missing still with a 120×90 placeholder rather than an error.
        onLoad={(event) => {
          if (source.src.startsWith(YOUTUBE_STILL) && event.currentTarget.naturalWidth === 120) next();
        }}
      />
    );
  return (
    <li
      className="publisher-pipeline-card"
      data-picture={Boolean(picture) || undefined}
      data-kind={post?.kind}
      data-carried={carried || undefined}
    >
      <button
        type="button"
        className="publisher-pipeline-open"
        aria-haspopup="dialog"
        draggable
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = "move";
          // Firefox starts a drag only with something to carry.
          event.dataTransfer.setData("text/plain", piece.title);
          onDragStart();
        }}
        onDragEnd={onDragEnd}
        onClick={onOpen}
      >
        {picture}
        <span className="publisher-pipeline-info">
          <strong>{piece.title}</strong>
          <small>
            <time dateTime={new Date(piece.stage_at).toISOString()}>{since(piece.stage_at)}</time>
            {views !== null && ` · ${compact.format(views)} views`}
          </small>
          {footage && !post && <small className="publisher-pipeline-footage">{footage}</small>}
        </span>
        {!picture && piece.notes && <span className="publisher-pipeline-notes">{piece.notes}</span>}
      </button>
    </li>
  );
}

/** Each destination a piece's post went out to, with its latest counts and a link to it there. */
function Stats({ post, href }: { post: PiecePost; href: string }) {
  const cell = (value: number | null) => (value === null ? "—" : count.format(value));
  return (
    <section className="publisher-pipeline-stats" aria-label="Stats">
      <div className="publisher-pipeline-stats-head">
        <h3>Stats</h3>
        <a href={href}>
          Analytics
          <ArrowUpRightIcon size={14} />
        </a>
      </div>
      {post.targets.length ? (
        <table>
          <thead>
            <tr>
              <th scope="col">Platform</th>
              {statColumns.map(([metric, name]) => (
                <th key={metric} scope="col">
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {post.targets.map((target) => {
              const name = (
                <>
                  <PlatformIcon platform={target.platform} size={14} />
                  {platformNames[target.platform]}
                </>
              );
              return (
                <tr key={target.id} data-deleted={target.deleted || undefined}>
                  <th scope="row">
                    {target.url ? (
                      <a href={target.url} target="_blank" rel="noreferrer">
                        {name}
                      </a>
                    ) : (
                      <span>{name}</span>
                    )}
                    {target.deleted && <small> · deleted</small>}
                  </th>
                  {statColumns.map(([metric]) => (
                    <td key={metric}>{cell(metricValue(target.metrics, metric))}</td>
                  ))}
                </tr>
              );
            })}
          </tbody>
          {post.targets.length > 1 && (
            <tfoot>
              <tr>
                <th scope="row">Total</th>
                {statColumns.map(([metric]) => (
                  <td key={metric}>{cell(total(post, metric))}</td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      ) : (
        <p className="publisher-note">It isn't out anywhere.</p>
      )}
    </section>
  );
}

/** A piece's stats once posted, then its title, notes and stage, with ways to compose or delete it. */
function PieceEditor({
  piece,
  request,
  onError,
  onClose,
  onSaved,
  onDeleted,
  onCompose,
  statsHref,
  ledger,
  link,
  onLinked,
}: Pick<Props, "request" | "onError" | "statsHref" | "onCompose"> & {
  piece: Content;
  onClose: () => void;
  onSaved: (piece: Content) => void;
  onDeleted: (id: string) => void;
  /** The footage ledger, for the films and shoot days a piece can name; null until read. */
  ledger: Ledger | null;
  link: FootageLink | undefined;
  onLinked: (links: Record<string, FootageLink>) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const [title, setTitle] = useState(piece.title);
  const [notes, setNotes] = useState(piece.notes);
  const [stage, setStage] = useState<Stage>(piece.stage);
  const [footage, setFootage] = useState(choiceOf(link));
  const [busy, setBusy] = useState(false);
  const edited = title.trim() !== piece.title || notes !== piece.notes || stage !== piece.stage;
  const relinked = footage !== choiceOf(link);
  const changed = edited || relinked;
  // Films newest first (their names start with a number), the one named kept even before the ledger has it; then
  // the days clips were shot on, newest first.
  const films = [...new Set([...Object.keys(ledger?.projects ?? {}), ...(link?.project ? [link.project] : [])])].sort(
    (a, b) => b.localeCompare(a),
  );
  const days = new Map<string, number>();
  for (const clip of Object.values(ledger?.clips ?? {})) {
    const day = dayOf(clip);
    if (day) days.set(day, (days.get(day) ?? 0) + 1);
  }
  if (link?.day && !days.has(link.day)) days.set(link.day, 0);
  /** Saves what changed; false when it couldn't. */
  async function save() {
    setBusy(true);
    onError("");
    try {
      if (edited) onSaved(await request(`content/${piece.id}`, { title, notes, stage }, "PATCH"));
      if (relinked) onLinked((await request(`footage/links/${piece.id}`, linkOf(footage), "PUT")).links);
      return true;
    } catch (error) {
      onError((error as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!confirm(`Delete “${piece.title}” from the pipeline? Its notes go with it. Any post it went out as stays.`))
      return;
    setBusy(true);
    onError("");
    try {
      await request(`content/${piece.id}`, undefined, "DELETE");
      onDeleted(piece.id);
      dialog.current?.close();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="publisher-pipeline-editor"
      aria-labelledby="publisher-piece-title"
      onClose={onClose}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (await save()) dialog.current?.close();
        }}
      >
        <div className="publisher-pipeline-editor-head">
          <h2 id="publisher-piece-title">{piece.title}</h2>
          <button type="button" aria-label="Close" onClick={() => dialog.current?.close()}>
            <CloseIcon size={16} />
          </button>
        </div>
        {piece.post && piece.job_id && <Stats post={piece.post} href={statsHref(piece.job_id)} />}
        <label>
          Title
          <input
            value={title}
            maxLength={MAX_CONTENT_TITLE}
            required
            disabled={busy}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label>
          Notes
          <textarea
            value={notes}
            maxLength={MAX_CONTENT_NOTES}
            rows={8}
            disabled={busy}
            placeholder="Script, shots, links"
            onChange={(event) => setNotes(event.target.value)}
          />
        </label>
        <label>
          Stage
          <select value={stage} disabled={busy} onChange={(event) => setStage(event.target.value as Stage)}>
            {stages.map((value) => (
              <option key={value} value={value}>
                {stageNames[value]}
              </option>
            ))}
          </select>
          {piece.job_id && stage !== "posted" && (
            <small className="publisher-note">Moving it lets go of the post it went out as, and its stats.</small>
          )}
        </label>
        <label>
          Footage
          <select value={footage} disabled={busy} onChange={(event) => setFootage(event.target.value)}>
            <option value="">None</option>
            {films.length > 0 && (
              <optgroup label="Films">
                {films.map((film) => (
                  <option key={film} value={`project:${film}`}>
                    {film}
                  </option>
                ))}
              </optgroup>
            )}
            {days.size > 0 && (
              <optgroup label="Shoot days">
                {[...days]
                  .sort(([a], [b]) => b.localeCompare(a))
                  .map(([day, clips]) => (
                    <option key={day} value={`day:${day}`}>
                      {dayName(day)} · {clips} {clips === 1 ? "clip" : "clips"}
                    </option>
                  ))}
              </optgroup>
            )}
          </select>
          {footage && <small className="publisher-note">{footageText(linkOf(footage), ledger)}</small>}
        </label>
        <div className="publisher-pipeline-editor-foot">
          <button type="button" disabled={busy} onClick={() => void remove()}>
            <TrashIcon size={16} />
            Delete
          </button>
          {/* Edits go with it, saved on the way. */}
          {stage === "edit" && (
            <button
              type="button"
              disabled={busy || !title.trim()}
              onClick={async () => {
                if (await save()) onCompose(piece.id);
              }}
            >
              Compose
            </button>
          )}
          <button type="submit" className="publish-button" disabled={busy || !title.trim() || !changed}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export default function PublisherPipeline({ request, onError, onCompose, statsHref, postsVersion }: Props) {
  const [items, setItems] = useState<Content[]>([]);
  const [loading, setLoading] = useState(true);
  const [idea, setIdea] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Content | null>(null);
  // The piece being dragged, and the column it's over that would take it.
  const [drag, setDrag] = useState<Content | null>(null);
  const [over, setOver] = useState<Stage | null>(null);
  // The board reaches the bottom of the window, and each column scrolls on its own.
  const board = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: the board appears once loading ends, and is measured then
  useLayoutEffect(() => {
    const fit = () => {
      const top = board.current?.getBoundingClientRect().top;
      if (top !== undefined) setHeight(Math.max(420, Math.floor(innerHeight - (top + scrollY) - 24)));
    };
    fit();
    addEventListener("resize", fit);
    return () => removeEventListener("resize", fit);
  }, [loading]);
  // Only this page changes the pipeline, besides queueing a post; a tab shown again reads it once in case another
  // device did. Nothing polls, since every read counts against D1's daily cap.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new post is the trigger to read it again
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const result = await request("content");
        if (active) setItems(result.items);
      } catch (error) {
        if (active) onError((error as Error).message);
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    const shown = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", shown);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", shown);
    };
  }, [request, onError, postsVersion]);
  // Each piece's footage (a film or a shoot day) and the ledger saying how it stands; the board works without them.
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [links, setLinks] = useState<Record<string, FootageLink>>({});
  useEffect(() => {
    let active = true;
    const load = () => {
      if (document.hidden) return;
      request("footage/ledger")
        .then((next: Ledger) => active && setLedger(next))
        .catch(() => {});
      request("footage/links")
        .then((next: { links: Record<string, FootageLink> }) => active && setLinks(next.links))
        .catch(() => {});
    };
    load();
    document.addEventListener("visibilitychange", load);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", load);
    };
  }, [request]);
  const put = (piece: Content) => setItems((list) => newestFirst([piece, ...list.filter((p) => p.id !== piece.id)]));
  async function add() {
    if (!idea.trim()) return;
    setAdding(true);
    onError("");
    try {
      put(await request("content", { title: idea }));
      setIdea("");
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setAdding(false);
    }
  }
  function endDrag() {
    setDrag(null);
    setOver(null);
  }
  /** Moves a dropped piece to its new column at once, then saves it there; back where it was if that fails. */
  async function move(piece: Content, stage: Stage) {
    if (
      piece.job_id &&
      stage !== "posted" &&
      !confirm(`Move “${piece.title}” to ${stageNames[stage]}? It lets go of the post it went out as, and its stats.`)
    )
      return;
    put({ ...piece, stage, stage_at: Date.now(), ...(stage === "posted" ? {} : { job_id: null, post: null }) });
    onError("");
    try {
      put(await request(`content/${piece.id}`, { stage }, "PATCH"));
    } catch (error) {
      put(piece);
      onError((error as Error).message);
    }
  }
  return (
    <section className="publisher-pipeline" aria-label="Pipeline">
      <h1 className="publisher-hidden">Pipeline</h1>
      <form
        className="publisher-pipeline-new"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <input
          aria-label="New idea"
          placeholder="New idea"
          value={idea}
          maxLength={MAX_CONTENT_TITLE}
          disabled={adding}
          onChange={(event) => setIdea(event.target.value)}
        />
        <button type="submit" disabled={adding || !idea.trim()}>
          <PlusIcon size={16} />
          Add
        </button>
      </form>
      {loading ? (
        <p className="publisher-note">Loading pipeline…</p>
      ) : (
        <div ref={board} className="publisher-pipeline-board" style={{ height }}>
          {stages.map((stage) => {
            const here = items.filter((piece) => piece.stage === stage);
            const droppable = drag !== null && drag.stage !== stage;
            return (
              <section
                key={stage}
                className="publisher-pipeline-stage"
                aria-label={stageNames[stage]}
                data-droppable={droppable || undefined}
                data-drop={(droppable && over === stage) || undefined}
                onDragOver={(event) => {
                  if (!droppable) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setOver(stage);
                }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                    setOver((current) => (current === stage ? null : current));
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (drag && droppable) void move(drag, stage);
                  endDrag();
                }}
              >
                <h2>
                  {stageNames[stage]}
                  <small>{here.length}</small>
                </h2>
                {here.length ? (
                  <ul>
                    {here.map((piece) => (
                      <Card
                        key={`${piece.id}:${piece.job_id}`}
                        piece={piece}
                        footage={footageText(links[piece.id], ledger)}
                        carried={drag?.id === piece.id}
                        onOpen={() => setEditing(piece)}
                        // After the browser has its picture of the card, so the picture isn't the faded original.
                        onDragStart={() => setTimeout(() => setDrag(piece))}
                        onDragEnd={endDrag}
                      />
                    ))}
                  </ul>
                ) : (
                  <p className="publisher-pipeline-empty">{stage === "idea" ? "Add an idea above" : "Drop here"}</p>
                )}
              </section>
            );
          })}
        </div>
      )}
      {editing && (
        <PieceEditor
          key={editing.id}
          piece={editing}
          request={request}
          onError={onError}
          statsHref={statsHref}
          onCompose={onCompose}
          onClose={() => setEditing(null)}
          onSaved={put}
          onDeleted={(id) => setItems((list) => list.filter((piece) => piece.id !== id))}
          ledger={ledger}
          link={links[editing.id]}
          onLinked={setLinks}
        />
      )}
    </section>
  );
}
