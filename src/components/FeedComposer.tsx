import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { RichText } from "@atproto/api";
import BlueskyLogin from "./BlueskyLogin";
import {
  getBlueskyAgent,
  getBlueskyAuthSnapshot,
  getBlueskyAuthServerSnapshot,
  subscribeBlueskyAuth,
} from "@/lib/bluesky/auth";
import { publishProfilePost } from "@/lib/bluesky/compose";

export default function FeedComposer() {
  const auth = useSyncExternalStore(subscribeBlueskyAuth, getBlueskyAuthSnapshot, getBlueskyAuthServerSnapshot);
  const id = useId();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState("");
  const [publishedUrl, setPublishedUrl] = useState("");
  const length = new RichText({ text: text.trim() }).graphemeLength;

  useEffect(() => {
    try {
      setText(sessionStorage.getItem("bluesky-post-draft") ?? "");
    } catch {
      /* Storage may be unavailable. */
    }
  }, []);

  function updateDraft(value: string) {
    setText(value);
    try {
      if (value) sessionStorage.setItem("bluesky-post-draft", value);
      else sessionStorage.removeItem("bluesky-post-draft");
    } catch {
      /* Keep the editable draft in memory. */
    }
  }

  async function publish(event: React.FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    setPublishedUrl("");
    try {
      const agent = await getBlueskyAgent();
      if (!agent) throw new Error("Log in with Bluesky to publish your post.");
      const post = await publishProfilePost(agent, text);
      const [, , did, , rkey] = post.uri.split("/");
      setPublishedUrl(`https://bsky.app/profile/${encodeURIComponent(did)}/post/${encodeURIComponent(rkey)}`);
      updateDraft("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not publish your post. Please try again.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="mb-6 rounded-xl bg-secondary p-4 dark:bg-dark-secondary" aria-label="Write a Bluesky post">
      <div className="mb-4 flex min-h-10 items-center gap-3" aria-label="Post author">
        {auth.profile ? (
          <a
            className="flex min-w-0 items-center gap-3"
            href={`https://bsky.app/profile/${encodeURIComponent(auth.profile.did)}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {auth.profile.avatar ? (
              <img
                src={auth.profile.avatar}
                alt=""
                width={40}
                height={40}
                className="h-10 w-10 shrink-0 rounded-full object-cover"
              />
            ) : (
              <span
                aria-hidden="true"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-bg dark:bg-dark-bg"
              >
                {(auth.profile.displayName || auth.profile.handle).slice(0, 1).toUpperCase()}
              </span>
            )}
            <span className="min-w-0">
              <span className="block truncate text-sm font-bold">
                {auth.profile.displayName || auth.profile.handle}
              </span>
              <span className="block truncate text-xs text-secondary-text">@{auth.profile.handle}</span>
            </span>
          </a>
        ) : (
          <BlueskyLogin />
        )}
      </div>
      <form id={`${id}-form`} onSubmit={publish} className="space-y-3">
        <label htmlFor={id} className="sr-only">
          Your post
        </label>
        <textarea
          id={id}
          rows={3}
          placeholder="What's on your mind?"
          value={text}
          onChange={(event) => updateDraft(event.target.value)}
          disabled={busy}
          aria-describedby={`${id}-notice`}
          style={{ background: "transparent", color: "inherit" }}
          className="block w-full resize-y rounded-lg border-0 p-3 text-base leading-relaxed focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2"
        />
      </form>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p id={`${id}-notice`} className="text-xs text-secondary-text">
          {auth.profile && <span className="mr-2">Public on @{auth.profile.handle}</span>}
          <span className="tabular-nums">{length}/300</span>
        </p>
        {auth.agent && (
          <button
            type="submit"
            form={`${id}-form`}
            disabled={busy || length === 0 || length > 300}
            className="rounded-lg border border-[color:color-mix(in_srgb,currentColor_20%,transparent)] px-4 py-2 text-sm disabled:opacity-50"
          >
            {busy ? "Posting…" : "Post"}
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm">
          {error}
        </p>
      )}
      {publishedUrl && (
        <p role="status" className="text-sm">
          Posted to your profile.{" "}
          <a className="underline" href={publishedUrl} target="_blank" rel="noopener noreferrer">
            View post
          </a>
        </p>
      )}
    </section>
  );
}
