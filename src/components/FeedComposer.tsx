import type { ComposerAttachment } from "@/lib/bluesky/media";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import BlueskyComposer from "./BlueskyComposer";
import {
  getBlueskyAgent,
  getBlueskyAuthSnapshot,
  getBlueskyAuthServerSnapshot,
  subscribeBlueskyAuth,
} from "@/lib/bluesky/auth";
import { rememberPublishedPost } from "@/lib/bluesky/published-feed";
import siteIdentity from "../../atproto.config.json";
import { publishProfilePost } from "@/lib/bluesky/compose";

export default function FeedComposer() {
  const auth = useSyncExternalStore(subscribeBlueskyAuth, getBlueskyAuthSnapshot, getBlueskyAuthServerSnapshot);
  const [text, setText] = useState("");
  const [images, setImages] = useState<ComposerAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState("");

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
    try {
      const agent = await getBlueskyAgent();
      if (!agent) throw new Error("Log in with Bluesky to publish your post.");
      if (!auth.profile || auth.profile.did !== siteIdentity.did)
        throw new Error("Sign in as kualta to publish to this feed.");
      const result = await publishProfilePost(agent, text, images);
      rememberPublishedPost(result, auth.profile, images);
      updateDraft("");
      setImages([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not publish your post. Please try again.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  if (auth.profile && auth.profile.did !== siteIdentity.did) return null;

  return (
    <BlueskyComposer
      images={images}
      onImagesChange={setImages}
      className=""
      text={text}
      onChange={updateDraft}
      onSubmit={publish}
      busy={busy}
      label="Write a Bluesky post"
    >
      {error && (
        <p role="alert" className="text-sm">
          {error}
        </p>
      )}
    </BlueskyComposer>
  );
}
