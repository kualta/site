import { useEffect, useRef, useState } from "react";
import { ChevronRightIcon, CloseIcon, PlusIcon, TrashIcon } from "@/components/icons";
import {
  MAX_CONTENT_NOTES,
  MAX_CONTENT_TITLE,
  stageNames,
  stages,
  type Content,
  type Stage,
} from "@/lib/publisher/content";
import { storedThumbnail } from "@/lib/publisher/preview";

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

/** A piece's title, notes and stage, with a way to delete it. */
function PieceEditor({
  piece,
  request,
  onError,
  onClose,
  onSaved,
  onDeleted,
  statsHref,
}: Pick<Props, "request" | "onError" | "statsHref"> & {
  piece: Content;
  onClose: () => void;
  onSaved: (piece: Content) => void;
  onDeleted: (id: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const [title, setTitle] = useState(piece.title);
  const [notes, setNotes] = useState(piece.notes);
  const [stage, setStage] = useState<Stage>(piece.stage);
  const [busy, setBusy] = useState(false);
  const changed = title.trim() !== piece.title || notes !== piece.notes || stage !== piece.stage;
  async function save() {
    setBusy(true);
    onError("");
    try {
      onSaved(await request(`content/${piece.id}`, { title, notes, stage }, "PATCH"));
      dialog.current?.close();
    } catch (error) {
      onError((error as Error).message);
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
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="publisher-pipeline-editor-head">
          <h2 id="publisher-piece-title">{piece.title}</h2>
          <button type="button" aria-label="Close" onClick={() => dialog.current?.close()}>
            <CloseIcon size={16} />
          </button>
        </div>
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
            rows={10}
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
          {piece.job_id && stage === "posted" && (
            <small className="publisher-note">
              Queued from the composer · <a href={statsHref(piece.job_id)}>See its numbers</a>
            </small>
          )}
          {piece.job_id && stage !== "posted" && (
            <small className="publisher-note">Moving it lets go of the post it went out as.</small>
          )}
        </label>
        <div className="publisher-pipeline-editor-foot">
          <button type="button" disabled={busy} onClick={() => void remove()}>
            <TrashIcon size={16} />
            Delete
          </button>
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
  // The piece being moved on, so its button waits for the answer.
  const [moving, setMoving] = useState<string | null>(null);
  const [editing, setEditing] = useState<Content | null>(null);
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
  async function move(piece: Content, stage: Stage) {
    setMoving(piece.id);
    onError("");
    try {
      put(await request(`content/${piece.id}`, { stage }, "PATCH"));
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setMoving(null);
    }
  }
  /** What a card offers next: composing it once its edit is ready, its numbers once posted, else the next stage. */
  function action(piece: Content) {
    if (piece.stage === "edit")
      return (
        <button type="button" aria-label={`Compose “${piece.title}”`} onClick={() => onCompose(piece.id)}>
          Compose
        </button>
      );
    if (piece.stage === "posted") return piece.job_id && <a href={statsHref(piece.job_id)}>Stats</a>;
    const next = stages[stages.indexOf(piece.stage) + 1];
    return (
      <button
        type="button"
        disabled={moving !== null}
        aria-label={`Move “${piece.title}” to ${stageNames[next]}`}
        title={`Move to ${stageNames[next]}`}
        onClick={() => void move(piece, next)}
      >
        {moving === piece.id ? "Moving…" : stageNames[next]}
        <ChevronRightIcon size={14} />
      </button>
    );
  }
  function card(piece: Content) {
    return (
      <li key={piece.id} className="publisher-pipeline-card">
        {piece.job_id && piece.thumbnail !== null && (
          <img src={storedThumbnail(piece.job_id, piece.thumbnail)} alt="" loading="lazy" />
        )}
        <button
          type="button"
          className="publisher-pipeline-open"
          aria-haspopup="dialog"
          onClick={() => setEditing(piece)}
        >
          {piece.title}
        </button>
        {piece.notes && <p className="publisher-pipeline-notes">{piece.notes}</p>}
        <div className="publisher-pipeline-foot">
          <time dateTime={new Date(piece.stage_at).toISOString()}>{since(piece.stage_at)}</time>
          {action(piece)}
        </div>
      </li>
    );
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
        <div className="publisher-pipeline-board">
          {stages.map((stage) => {
            const here = items.filter((piece) => piece.stage === stage);
            return (
              <section key={stage} className="publisher-pipeline-stage" aria-label={stageNames[stage]}>
                <h2>
                  {stageNames[stage]}
                  <small>{here.length}</small>
                </h2>
                {here.length ? (
                  <ul>{here.map(card)}</ul>
                ) : (
                  <p className="publisher-pipeline-empty">{stage === "idea" ? "Add an idea above" : "Nothing here"}</p>
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
          onClose={() => setEditing(null)}
          onSaved={put}
          onDeleted={(id) => setItems((list) => list.filter((piece) => piece.id !== id))}
        />
      )}
    </section>
  );
}
