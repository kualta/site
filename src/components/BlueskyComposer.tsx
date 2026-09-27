import { blueskyProfileUrl } from "@/lib/bluesky/urls";
import { useId, useSyncExternalStore, type FormEvent, type ReactNode, type Ref } from "react";
import { RichText } from "@atproto/api";
import BlueskyLogin from "./BlueskyLogin";
import { getBlueskyAuthSnapshot, getBlueskyAuthServerSnapshot, subscribeBlueskyAuth } from "@/lib/bluesky/auth";

export default function BlueskyComposer({
  text,
  onChange,
  onSubmit,
  busy,
  label = "Your post",
  placeholder = "What's on your mind?",
  loginLabel = "Log in to post",
  submitLabel = "Post",
  textareaRef,
  context,
  children,
}: {
  text: string;
  onChange: (text: string) => void;
  onSubmit: (event: FormEvent) => void;
  busy: boolean;
  label?: string;
  placeholder?: string;
  loginLabel?: string;
  submitLabel?: string;
  textareaRef?: Ref<HTMLTextAreaElement>;
  context?: ReactNode;
  children?: ReactNode;
}) {
  const auth = useSyncExternalStore(subscribeBlueskyAuth, getBlueskyAuthSnapshot, getBlueskyAuthServerSnapshot);
  const id = useId();
  const length = new RichText({ text: text.trim() }).graphemeLength;
  if (!auth.agent) {
    return (
      <div className="mb-6">
        <BlueskyLogin fullWidth label={loginLabel} />
      </div>
    );
  }

  return (
    <section className="mb-6 rounded-xl bg-secondary p-4 dark:bg-dark-secondary" aria-label={label}>
      <div className={`flex min-h-10 items-center gap-3 ${auth.agent ? "mb-4" : ""}`} aria-label="Post author">
        {auth.profile ? (
          <a
            className="flex min-w-0 items-center gap-3"
            href={blueskyProfileUrl(auth.profile.did)}
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
          <BlueskyLogin fullWidth label={loginLabel} />
        )}
      </div>
      {auth.agent && context}
      {auth.agent && (
        <form id={`${id}-form`} onSubmit={onSubmit} className="relative">
          <label htmlFor={id} className="sr-only">
            {label}
          </label>
          <textarea
            id={id}
            ref={textareaRef}
            rows={3}
            placeholder={placeholder}
            value={text}
            onChange={(event) => onChange(event.target.value)}
            disabled={busy}
            aria-describedby={`${id}-count`}
            style={{ background: "transparent", color: "inherit" }}
            className="block w-full resize-y rounded-lg border-0 p-3 pb-10 text-base leading-relaxed focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2"
          />
          <span
            id={`${id}-count`}
            className="pointer-events-none absolute bottom-3 right-5 text-xs tabular-nums text-secondary-text"
          >
            {length}/300
          </span>
        </form>
      )}
      {auth.agent && (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-3">
          {auth.agent && (
            <button
              type="submit"
              form={`${id}-form`}
              disabled={busy || length === 0 || length > 300}
              className="rounded-lg border border-[color:color-mix(in_srgb,currentColor_20%,transparent)] px-4 py-2 text-sm disabled:opacity-50"
            >
              {busy ? "Posting…" : submitLabel}
            </button>
          )}
        </div>
      )}
      {children}
    </section>
  );
}
