import { useEffect, useRef, useState } from "react";
import BlueskyComposer from "./BlueskyComposer";
import { getBlueskyAgent } from "@/lib/bluesky/auth";
import { publishProfilePost } from "@/lib/bluesky/compose";

export default function FeedComposer() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState("");
  const [publishedUrl, setPublishedUrl] = useState("");

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
    <BlueskyComposer text={text} onChange={updateDraft} onSubmit={publish} busy={busy} label="Write a Bluesky post">
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
    </BlueskyComposer>
  );
}
