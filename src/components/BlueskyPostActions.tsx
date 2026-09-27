import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { RichText, type AppBskyFeedDefs } from "@atproto/api";
import { FiHeart, FiMessageCircle, FiRepeat } from "react-icons/fi";
import { getBlueskyAgent, getBlueskyAuthSnapshot, subscribeBlueskyAuth } from "@/lib/bluesky/auth";
import { fetchInteractionPost, replyToPost, togglePostLike, togglePostRepost } from "@/lib/bluesky/interactions";

const reactionClass =
  "inline-flex h-8 min-w-[2.75rem] items-center justify-center gap-1 text-xs hover:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50";

const buttonClass =
  "inline-flex min-h-10 min-w-10 justify-center items-center gap-1.5 rounded-lg px-2 text-xs hover:bg-primary focus-visible:outline focus-visible:outline-2 disabled:opacity-50 dark:hover:bg-dark-primary";

export default function BlueskyPostActions({ uri }: { uri: string }) {
  const auth = useSyncExternalStore(subscribeBlueskyAuth, getBlueskyAuthSnapshot, getBlueskyAuthSnapshot);
  const [post, setPost] = useState<AppBskyFeedDefs.PostView | null>(null);
  const [busy, setBusy] = useState(false);
  const acting = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [replyOpen, setReplyOpen] = useState(false);
  const [text, setText] = useState("");
  const inputId = useId();
  const length = new RichText({ text }).graphemeLength;

  useEffect(() => {
    let active = true;
    setPost(null);
    setError("");
    if (auth.agent) {
      fetchInteractionPost(auth.agent, uri)
        .then((value) => {
          if (active) setPost(value);
        })
        .catch(() => {
          if (active) setError("Could not load your reactions. You can retry an action.");
        });
    }
    return () => {
      active = false;
    };
  }, [auth.agent, uri]);

  async function act(action: "like" | "repost" | "reply") {
    if (acting.current || (action !== "reply" && !post)) return;
    acting.current = true;
    const previous = post;
    if (action !== "reply" && post) {
      const field = action === "like" ? "like" : "repost";
      const count = action === "like" ? "likeCount" : "repostCount";
      const selected = Boolean(post.viewer?.[field]);
      setPost({
        ...post,
        [count]: Math.max(0, (post[count] ?? 0) + (selected ? -1 : 1)),
        viewer: { ...post.viewer, [field]: selected ? undefined : "pending" },
      });
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const agent = await getBlueskyAgent();
      if (!agent) throw new Error("Log in again to update your reaction.");
      if (action === "reply") {
        await replyToPost(agent, uri, text);
        setText("");
        setReplyOpen(false);
        setNotice("Reply published on Bluesky.");
        setPost((value) => (value ? { ...value, replyCount: (value.replyCount ?? 0) + 1 } : value));
      } else {
        setPost(await (action === "like" ? togglePostLike : togglePostRepost)(agent, uri));
      }
    } catch (cause) {
      if (action !== "reply") setPost(previous);
      setError(cause instanceof Error ? cause.message : "Could not complete this action. Please try again.");
    } finally {
      acting.current = false;
      setBusy(false);
    }
  }

  if (!auth.agent) return null;

  return (
    <div className="px-3 pb-3" aria-label="Bluesky post actions">
      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          className={reactionClass}
          aria-label={post?.viewer?.like ? "Unlike post" : "Like post"}
          title={post?.viewer?.like ? "Unlike post" : "Like post"}
          aria-pressed={!!post?.viewer?.like}
          disabled={busy || auth.loading || !post}
          onClick={() => void act("like")}
        >
          <FiHeart size={18} aria-hidden="true" className={post?.viewer?.like ? "fill-current text-rose-500" : ""} />{" "}
          {post?.likeCount ? ` ${post.likeCount}` : ""}
        </button>
        <button
          type="button"
          className={reactionClass}
          aria-label={post?.viewer?.repost ? "Undo repost" : "Repost"}
          title={post?.viewer?.repost ? "Undo repost" : "Repost"}
          aria-pressed={!!post?.viewer?.repost}
          disabled={busy || auth.loading || !post}
          onClick={() => void act("repost")}
        >
          <FiRepeat size={18} aria-hidden="true" className={post?.viewer?.repost ? "text-[#16a34a]" : ""} />
          {post?.repostCount ? ` ${post.repostCount}` : ""}
        </button>
        <button
          type="button"
          className={reactionClass}
          aria-label="Reply"
          title="Reply"
          aria-expanded={replyOpen}
          aria-controls={`${inputId}-form`}
          disabled={busy || auth.loading || post?.viewer?.replyDisabled}
          onClick={() => setReplyOpen(!replyOpen)}
        >
          <FiMessageCircle size={18} aria-hidden="true" />
          {post?.replyCount ? ` ${post.replyCount}` : ""}
        </button>
      </div>
      {replyOpen && auth.agent && (
        <form
          id={`${inputId}-form`}
          className="space-y-2 pt-2"
          onSubmit={(event) => {
            event.preventDefault();
            void act("reply");
          }}
        >
          <label htmlFor={inputId} className="block text-sm">
            Your reply
          </label>
          <textarea
            id={inputId}
            className="w-full rounded-lg bg-primary p-3 text-sm dark:bg-dark-primary"
            rows={3}
            value={text}
            onChange={(event) => setText(event.target.value)}
            disabled={busy}
            aria-describedby={`${inputId}-help`}
            required
          />
          <p id={`${inputId}-help`} className="text-xs text-secondary-text">
            Your reply will be public on Bluesky. {length}/300
          </p>
          <div className="flex gap-2">
            <button className={buttonClass} disabled={busy || !text.trim() || length > 300} type="submit">
              Publish reply
            </button>
            <button className={buttonClass} disabled={busy} type="button" onClick={() => setReplyOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="pt-2 text-xs text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="pt-2 text-xs text-secondary-text" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}
