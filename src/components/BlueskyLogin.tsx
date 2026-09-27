import { useId, useRef, useState, useSyncExternalStore } from "react";
import {
  getBlueskyAuthSnapshot,
  getBlueskyAuthServerSnapshot,
  signIn,
  signOut,
  subscribeBlueskyAuth,
} from "@/lib/bluesky/auth";

export default function BlueskyLogin({
  compact = false,
  fullWidth = false,
}: { compact?: boolean; fullWidth?: boolean }) {
  const auth = useSyncExternalStore(subscribeBlueskyAuth, getBlueskyAuthSnapshot, getBlueskyAuthServerSnapshot);
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [handle, setHandle] = useState("");
  return (
    <div className={`bluesky-login text-sm tracking-normal ${fullWidth ? "w-full" : ""}`}>
      <button
        type="button"
        className={`rounded-lg border border-[color:color-mix(in_srgb,currentColor_20%,transparent)] px-3 py-2 hover:bg-secondary disabled:opacity-50 ${
          fullWidth ? "w-full" : ""
        }`}
        onClick={() => dialog.current?.showModal()}
        disabled={auth.loading}
      >
        {auth.profile ? (compact ? "Account" : `@${auth.profile.handle}`) : compact ? "Log in" : "Log in with Bluesky"}
      </button>
      <dialog
        ref={dialog}
        aria-labelledby={`${id}-title`}
        className="m-auto w-[calc(100%-2rem)] max-w-sm rounded-2xl border border-[color:color-mix(in_srgb,currentColor_20%,transparent)] bg-secondary dark:bg-dark-primary p-6 text-text dark:text-dark-text shadow-xl backdrop:bg-[rgba(0,0,0,0.5)]"
      >
        <div className="flex items-center justify-between gap-4 mb-4">
          <h2 id={`${id}-title`} className="text-xl">
            {auth.profile ? "Your Bluesky account" : "Log in with Bluesky"}
          </h2>
          <button type="button" aria-label="Close sign-in" onClick={() => dialog.current?.close()} className="p-2">
            ×
          </button>
        </div>
        {auth.profile ? (
          <div className="flex flex-col gap-4">
            <p className="break-words">Signed in as @{auth.profile.handle}</p>
            <button
              type="button"
              disabled={auth.loading}
              className="rounded-lg border border-[color:color-mix(in_srgb,currentColor_20%,transparent)] p-2"
              onClick={async () => {
                await signOut();
                if (!getBlueskyAuthSnapshot().profile) dialog.current?.close();
              }}
            >
              Log out
            </button>
          </div>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={async (event) => {
              event.preventDefault();
              try {
                await signIn(handle);
              } catch {
                /* The auth store presents the error. */
              }
            }}
          >
            <label htmlFor={`${id}-handle`}>Bluesky handle</label>
            <input
              id={`${id}-handle`}
              autoFocus
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              style={{ background: "transparent", color: "inherit" }}
              placeholder="you.bsky.social"
              value={handle}
              onChange={(event) => setHandle(event.target.value)}
              className="w-full rounded-lg border border-[color:color-mix(in_srgb,currentColor_30%,transparent)] bg-transparent p-3"
            />
            <p className="text-sm text-secondary-text">
              Your account provider will ask you to authorize this site. Likes, reposts, and comments are public on
              Bluesky.
            </p>
            <button
              type="submit"
              disabled={auth.loading || !handle.trim()}
              className="rounded-lg border border-[color:color-mix(in_srgb,currentColor_20%,transparent)] p-3 disabled:opacity-50"
            >
              {auth.loading ? "Connecting…" : "Continue"}
            </button>
          </form>
        )}
        {auth.error && (
          <p role="alert" className="mt-3 text-sm">
            {auth.error}
          </p>
        )}
      </dialog>
    </div>
  );
}
