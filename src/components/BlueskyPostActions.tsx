import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { RichText, type AppBskyFeedDefs } from "@atproto/api";
import { FiHeart, FiMessageCircle, FiRepeat } from "react-icons/fi";
import BlueskyLogin from "./BlueskyLogin";
import { getBlueskyAgent, getBlueskyAuthSnapshot, subscribeBlueskyAuth } from "@/lib/bluesky/auth";
import { fetchInteractionPost, replyToPost, togglePostLike, togglePostRepost } from "@/lib/bluesky/interactions";

const buttonClass =
  "inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2 text-xs hover:bg-primary focus-visible:outline focus-visible:outline-2 disabled:opacity-50 dark:hover:bg-dark-primary";

export default function BlueskyPostActions({ uri }: { uri: string }) {
  const auth = useSyncExternalStore(subscribeBlueskyAuth, getBlueskyAuthSnapshot, getBlueskyAuthSnapshot);
  const [post, setPost] = useState<AppBskyFeedDefs.PostView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showLogin, setShowLogin] = useState(false);
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
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const agent = await getBlueskyAgent();
      if (!agent) {
        setShowLogin(true);
        return;
      }
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
      setError(cause instanceof Error ? cause.message : "Could not complete this action. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="px-3 pb-3" aria-label="Bluesky post actions">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={buttonClass}
          aria-label={post?.viewer?.like ? "Unlike post" : "Like post"}
          aria-pressed={!!post?.viewer?.like}
          disabled={busy || auth.loading}
          onClick={() => void act("like")}
        >
          <FiHeart aria-hidden="true" className={post?.viewer?.like ? "fill-current text-rose-500" : ""} />{" "}
          {post?.viewer?.like ? "Liked" : "Like"}
          {post?.likeCount ? ` ${post.likeCount}` : ""}
        </button>
        <button
          type="button"
          className={buttonClass}
          aria-label={post?.viewer?.repost ? "Undo repost" : "Repost"}
          aria-pressed={!!post?.viewer?.repost}
          disabled={busy || auth.loading}
          onClick={() => void act("repost")}
        >
          <FiRepeat aria-hidden="true" /> {post?.viewer?.repost ? "Reposted" : "Repost"}
          {post?.repostCount ? ` ${post.repostCount}` : ""}
        </button>
        <button
          type="button"
          className={buttonClass}
          aria-expanded={replyOpen}
          aria-controls={`${inputId}-form`}
          disabled={busy || auth.loading || post?.viewer?.replyDisabled}
          onClick={() => {
            if (!auth.agent) setShowLogin(true);
            else setReplyOpen(!replyOpen);
          }}
        >
          <FiMessageCircle aria-hidden="true" /> Reply{post?.replyCount ? ` ${post.replyCount}` : ""}
        </button>
        {busy && (
          <span className="text-xs text-secondary-text" role="status">
            Saving…
          </span>
        )}
      </div>
      {showLogin && !auth.agent && (
        <div className="pt-2">
          <BlueskyLogin />
        </div>
      )}
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
