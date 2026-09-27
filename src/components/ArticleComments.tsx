import { AppBskyFeedPost, RichText } from "@atproto/api";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import BlueskyLogin from "./BlueskyLogin";
import {
  getBlueskyAgent,
  getBlueskyAuthSnapshot,
  getBlueskyAuthServerSnapshot,
  subscribeBlueskyAuth,
} from "@/lib/bluesky/auth";
import {
  publishArticleComment,
  linksToArticle,
  commentUrl,
  loadArticleComments,
  mergeComments,
  publicCommentsAgent,
  type CommentPost,
} from "@/lib/bluesky/comments";
import "@/styles/article-comments.css";

export default function ArticleComments({ url, title }: { url: string; title: string }) {
  const auth = useSyncExternalStore(subscribeBlueskyAuth, getBlueskyAuthSnapshot, getBlueskyAuthServerSnapshot);
  const [posts, setPosts] = useState<CommentPost[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [text, setText] = useState("");
  const [parent, setParent] = useState<CommentPost>();
  const [publishing, setPublishing] = useState(false);
  const [deleting, setDeleting] = useState<string>();
  const deleted = useRef(new Set<string>());
  const pending = useRef(new Map<string, CommentPost>());
  const textarea = useRef<HTMLTextAreaElement>(null);
  const generation = useRef(0);
  const length = new RichText({ text: text.trim() }).graphemeLength;

  async function load(more = false) {
    const request = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const result = await loadArticleComments(auth.agent ?? publicCommentsAgent, url, more ? cursor : undefined);
      if (request !== generation.current) return;
      for (const post of result.posts) pending.current.delete(post.uri);
      const incoming = mergeComments(
        [...pending.current.values()].filter((post) => linksToArticle(post, url)),
        result.posts,
      );
      setPosts((previous) =>
        (more ? mergeComments(previous, incoming) : incoming).filter((post) => !deleted.current.has(post.uri)),
      );
      setCursor(result.cursor);
      if (result.incomplete) setError("Some replies could not load. Retry loading to try again.");
    } catch {
      if (request === generation.current) setError("Comments could not load from Bluesky. Please try again.");
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    setPosts([]);
    setParent(undefined);
    setCursor(undefined);
    void load();
    return () => {
      generation.current += 1;
    };
  }, [url, auth.agent]);

  async function publish(event: React.FormEvent) {
    event.preventDefault();
    if (publishing) return;
    setPublishing(true);
    setError("");
    setNotice("");
    try {
      const agent = await getBlueskyAgent();
      if (!agent || !auth.profile) throw new Error("Sign in to Bluesky before posting.");
      const result = await publishArticleComment(agent, text, url, title, parent);
      const { record } = result;
      // The successful repo write is authoritative, even before search indexing catches up.
      const published: CommentPost = {
        uri: result.uri,
        cid: result.cid,
        record,
        author: auth.profile,
        indexedAt: record.createdAt,
      };
      pending.current.set(published.uri, published);
      setPosts((previous) => mergeComments([published], previous));
      setText("");
      setParent(undefined);
      setNotice("Posted publicly on Bluesky. It may take a moment to appear for other readers.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Your comment could not be posted. Try again.");
    } finally {
      setPublishing(false);
    }
  }

  async function deleteComment(post: CommentPost) {
    if (deleting || !window.confirm("Delete this comment from Bluesky? This cannot be undone.")) return;
    setDeleting(post.uri);
    setError("");
    try {
      const agent = await getBlueskyAgent();
      if (!agent || auth.profile?.did !== post.author.did)
        throw new Error("Sign in as the author to delete this comment.");
      await agent.deletePost(post.uri);
      deleted.current.add(post.uri);
      pending.current.delete(post.uri);
      setPosts((previous) => previous.filter((candidate) => candidate.uri !== post.uri));
      if (parent?.uri === post.uri) setParent(undefined);
      setNotice("Comment deleted from Bluesky.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete this comment.");
    } finally {
      setDeleting(undefined);
    }
  }

  return (
    <section className="article-comments" aria-labelledby="comments-heading">
      <div className="comments-heading-row">
        <h2 id="comments-heading">Comments</h2>
      </div>
      <BlueskyLogin label="Log in to comment" />
      {auth.agent && (
        <form onSubmit={publish} className="comment-form">
          {parent && (
            <div className="comment-reply-context">
              Replying to @{parent.author.handle}{" "}
              <button type="button" className="comments-text-button" onClick={() => setParent(undefined)}>
                Cancel reply
              </button>
            </div>
          )}
          <label htmlFor="article-comment">{parent ? "Your reply" : "Your comment"}</label>
          <textarea
            id="article-comment"
            ref={textarea}
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={3}
            placeholder="Join the conversation…"
            disabled={publishing}
            aria-describedby="comment-public-notice"
          />
          <div className="comment-form-footer">
            <span id="comment-public-notice">Public on Bluesky · {length}/300</span>
            <button type="submit" className="comment-submit" disabled={publishing || length < 1 || length > 300}>
              {publishing ? "Posting…" : parent ? "Post reply publicly" : "Post comment publicly"}
            </button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="comment-error">
          {error}{" "}
          <button type="button" className="comments-text-button" onClick={() => void load()} disabled={loading}>
            Retry loading
          </button>
        </p>
      )}
      {notice && (
        <p role="status" className="comments-description">
          {notice}
        </p>
      )}
      {loading && (
        <p role="status" className="comments-description">
          Loading comments…
        </p>
      )}
      <div className="comments-list" aria-busy={loading}>
        {posts.map((post) => {
          const record = AppBskyFeedPost.isRecord(post.record) ? (post.record as AppBskyFeedPost.Record) : null;
          if (!record) return null;
          const replyTo = record.reply?.parent.uri;
          const parentPost = posts.find((candidate) => candidate.uri === replyTo);
          return (
            <article key={post.uri} className="article-comment">
              <div className="comment-author-row">
                <a
                  href={`https://bsky.app/profile/${encodeURIComponent(post.author.did)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="comment-author"
                >
                  {post.author.avatar && <img src={post.author.avatar} width={28} height={28} alt="" loading="lazy" />}
                  <span>
                    {post.author.displayName || post.author.handle}{" "}
                    <span className="comment-handle">@{post.author.handle}</span>
                  </span>
                </a>
                <a href={commentUrl(post)} target="_blank" rel="noopener noreferrer" className="comment-date">
                  <time dateTime={record.createdAt}>
                    {new Date(record.createdAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </time>
                </a>
              </div>
              {parentPost && <p className="comment-reply-context">Reply to @{parentPost.author.handle}</p>}
              <p className="comment-body">{record.text}</p>
              <div className="comment-actions">
                {auth.agent && !post.viewer?.replyDisabled && (
                  <button
                    type="button"
                    className="comments-text-button"
                    onClick={() => {
                      setParent(post);
                      textarea.current?.focus();
                      textarea.current?.scrollIntoView({ block: "center", behavior: "smooth" });
                    }}
                  >
                    Reply
                  </button>
                )}
                <a href={commentUrl(post)} target="_blank" rel="noopener noreferrer">
                  View on Bluesky
                </a>
                {auth.profile?.did === post.author.did && (
                  <button
                    type="button"
                    className="comments-text-button"
                    onClick={() => void deleteComment(post)}
                    disabled={Boolean(deleting)}
                  >
                    {deleting === post.uri ? "Deleting…" : "Delete"}
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {cursor && (
        <button
          type="button"
          className="comments-text-button comments-load-more"
          onClick={() => void load(true)}
          disabled={loading}
        >
          Load more conversations
        </button>
      )}
    </section>
  );
}
