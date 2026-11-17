import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { AppBskyFeedDefs } from "@atproto/api";
import { CommentIcon, HeartIcon, RepeatIcon } from "@/components/icons";
import { getBlueskyAgent, getBlueskyAuthSnapshot, subscribeBlueskyAuth } from "@/lib/bluesky/auth";
import {
  fetchInteractionPost,
  fetchPublicPost,
  replyToPost,
  RepostRemovedError,
  repostAgain,
  togglePostLike,
  togglePostRepost,
} from "@/lib/bluesky/interactions";
import { usePopoverMenu } from "@/lib/popover-menu";

import BlueskyComposer from "./BlueskyComposer";
import { BlueskyLoginDialog } from "./BlueskyLogin";
import type { ComposerAttachment } from "@/lib/bluesky/media";

// icons sit at the start of equal slots, and the row is pulled back by the
// slot's inset, so the first icon lines up with the post text above it
const reactionClass =
  "inline-flex h-8 min-w-[3.25rem] items-center justify-start gap-1.5 rounded-lg border border-[color:transparent] px-[7px] text-sm hover:opacity-60 focus-visible:border-[color:currentColor] focus-visible:outline-none disabled:opacity-50";
const reactionIconSize = 17;

// the palette pink is a background tint, so light mode keeps its hue at ink depth
const pressedClass = "text-[color:oklch(from_var(--primary)_0.62_0.14_h)] dark:text-primary";
const reactionStroke = 2.5;

const buttonClass =
  "inline-flex min-h-10 min-w-10 justify-center items-center gap-1.5 rounded-lg border border-[color:transparent] px-2 text-xs hover:bg-primary focus-visible:border-[color:currentColor] focus-visible:outline-none disabled:opacity-50 dark:hover:bg-dark-primary";

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
  const [images, setImages] = useState<ComposerAttachment[]>([]);
  const login = useRef<HTMLDialogElement>(null);
  const [loginMounted, setLoginMounted] = useState(false);
  // a remembered account is still restoring: wait for its own counts and viewer state
  const restoringAccount = auth.restoring && !!auth.profile;
  const signedOut = !auth.agent && !restoringAccount;

  useEffect(() => {
    let active = true;
    const agent = auth.agent;
    setPost(null);
    setError("");
    if (!restoringAccount) {
      (agent ? fetchInteractionPost(agent, uri) : fetchPublicPost(uri))
        .then((value) => {
          if (active) setPost(value);
        })
        .catch(() => {
          // signed out, the row just goes without counts
          if (active && agent) setError("Could not load your reactions. You can retry an action.");
        });
    }
    return () => {
      active = false;
    };
  }, [auth.agent, restoringAccount, uri]);

  // the dialog mounts on the first signed-out click, so rows nobody touches carry none
  useEffect(() => {
    if (loginMounted) login.current?.showModal();
  }, [loginMounted]);

  async function askToLogIn() {
    // a session restored from storage after the click needs no login
    if (await getBlueskyAgent()) return;
    if (login.current) login.current.showModal();
    else setLoginMounted(true);
  }

  async function act(action: "like" | "repost" | "repost-again" | "reply") {
    if (acting.current || (action !== "reply" && !post)) return;
    acting.current = true;
    const previous = post;
    if (action !== "reply" && post) {
      const field = action === "like" ? "like" : "repost";
      const count = action === "like" ? "likeCount" : "repostCount";
      const selected = Boolean(post.viewer?.[field]);
      let delta = selected ? -1 : 1;
      if (action === "repost-again") delta = 0;
      setPost({
        ...post,
        [count]: Math.max(0, (post[count] ?? 0) + delta),
        viewer: { ...post.viewer, [field]: delta < 0 ? undefined : "pending" },
      });
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const agent = await getBlueskyAgent();
      if (!agent) throw new Error("Log in again to update your reaction.");
      if (action === "reply") {
        await replyToPost(agent, uri, text, images);
        window.dispatchEvent(new Event("bluesky:reply-published"));
        setImages([]);
        setText("");
        setReplyOpen(false);
        setNotice("Reply published on Bluesky.");
        setPost((value) => (value ? { ...value, replyCount: (value.replyCount ?? 0) + 1 } : value));
      } else if (action === "like") {
        setPost(await togglePostLike(agent, uri));
      } else {
        // The menu acts on the repost shown here, which the AppView may not have indexed yet.
        const known = previous?.viewer?.repost ?? null;
        setPost(await (action === "repost" ? togglePostRepost : repostAgain)(agent, uri, known));
      }
    } catch (cause) {
      if (cause instanceof RepostRemovedError) setPost(cause.post);
      else if (action !== "reply") setPost(previous);
      setError(cause instanceof Error ? cause.message : "Could not complete this action. Please try again.");
    } finally {
      acting.current = false;
      setBusy(false);
    }
  }

  const reactionDisabled = !signedOut && (busy || auth.loading || !post);

  return (
    <div className="px-4 pb-3" aria-label="Bluesky post actions">
      <div className="-ml-2 flex flex-wrap items-center gap-4">
        <button
          type="button"
          className={reactionClass}
          aria-label={post?.viewer?.like ? "Unlike post" : "Like post"}
          title={post?.viewer?.like ? "Unlike post" : "Like post"}
          aria-pressed={!!post?.viewer?.like}
          disabled={reactionDisabled}
          onClick={() => void (signedOut ? askToLogIn() : act("like"))}
        >
          <HeartIcon
            size={reactionIconSize}
            strokeWidth={reactionStroke}
            aria-hidden="true"
            className={post?.viewer?.like ? `fill-current ${pressedClass}` : ""}
          />
          <ReactionCount value={post?.likeCount} />
        </button>
        <RepostButton
          reposted={!!post?.viewer?.repost}
          count={post?.repostCount}
          disabled={reactionDisabled}
          onRepost={() => void (signedOut ? askToLogIn() : act("repost"))}
          onRepostAgain={() => void act("repost-again")}
        />
        <button
          type="button"
          className={reactionClass}
          aria-label="Reply"
          title="Reply"
          aria-expanded={replyOpen}
          aria-controls={`${inputId}-form`}
          disabled={!signedOut && (busy || auth.loading || post?.viewer?.replyDisabled)}
          onClick={() => (signedOut ? void askToLogIn() : setReplyOpen(!replyOpen))}
        >
          <CommentIcon size={reactionIconSize} strokeWidth={reactionStroke} aria-hidden="true" />
          <ReactionCount value={post?.replyCount} />
        </button>
      </div>
      {loginMounted && <BlueskyLoginDialog ref={login} />}
      {replyOpen && auth.agent && (
        <div id={`${inputId}-form`} className="pt-2">
          <BlueskyComposer
            className=""
            text={text}
            onChange={setText}
            images={images}
            onImagesChange={setImages}
            busy={busy}
            label="Your reply"
            placeholder="Write a reply…"
            submitLabel="Reply"
            onSubmit={(event) => {
              event.preventDefault();
              void act("reply");
            }}
          >
            <button className={buttonClass} disabled={busy} type="button" onClick={() => setReplyOpen(false)}>
              Cancel
            </button>
          </BlueskyComposer>
        </div>
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

function RepostButton({
  reposted,
  count,
  disabled,
  onRepost,
  onRepostAgain,
}: {
  reposted: boolean;
  count?: number;
  disabled: boolean;
  onRepost: () => void;
  onRepostAgain: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const open = usePopoverMenu(trigger, panel, "start");

  function choose(action: () => void) {
    panel.current?.hidePopover();
    trigger.current?.focus();
    action();
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={reactionClass}
        aria-label={reposted ? "Repost options" : "Repost"}
        title={reposted ? "Repost options" : "Repost"}
        aria-pressed={reposted}
        aria-expanded={reposted ? open : undefined}
        aria-controls={reposted ? id : undefined}
        popoverTarget={reposted ? id : undefined}
        disabled={disabled}
        onClick={reposted ? undefined : onRepost}
      >
        <RepeatIcon
          size={reactionIconSize}
          strokeWidth={reactionStroke}
          aria-hidden="true"
          className={reposted ? pressedClass : ""}
        />
        <ReactionCount value={count} />
      </button>
      <div ref={panel} id={id} popover="auto" className="post-menu-panel" role="group" aria-label="Repost options">
        <button type="button" onClick={() => choose(onRepostAgain)}>
          Repost again
        </button>
        <button type="button" onClick={() => choose(onRepost)}>
          Undo repost
        </button>
      </div>
    </>
  );
}

function ReactionCount({ value }: { value?: number }) {
  return value ? <span className="font-semibold tabular-nums">{value}</span> : null;
}
