import { CloseIcon, LoginIcon } from "@/components/icons";
import { type RefObject, useId, useRef, useState, useSyncExternalStore } from "react";
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
  icon = false,
  label,
}: {
  compact?: boolean;
  fullWidth?: boolean;
  /** a round button showing the signed-in account's picture, or a log-in arrow before signing in */
  icon?: boolean;
  label?: string;
}) {
  const auth = useSyncExternalStore(subscribeBlueskyAuth, getBlueskyAuthSnapshot, getBlueskyAuthServerSnapshot);
  const dialog = useRef<HTMLDialogElement>(null);
  if (icon)
    return (
      <div className="bluesky-login text-sm tracking-normal">
        <button
          type="button"
          className="grid size-11 place-items-center overflow-hidden rounded-full hover:opacity-80 disabled:opacity-50"
          aria-label={auth.profile ? `Bluesky account @${auth.profile.handle}` : "Log in with Bluesky"}
          onClick={() => dialog.current?.showModal()}
          disabled={auth.loading}
        >
          {auth.profile?.avatar ? (
            <img src={auth.profile.avatar} alt="" className="size-full object-cover" />
          ) : (
            <LoginIcon size={22} aria-hidden="true" />
          )}
        </button>
        <BlueskyLoginDialog ref={dialog} />
      </div>
    );
  return (
    <div className={`bluesky-login text-sm tracking-normal ${fullWidth ? "w-full" : ""}`}>
      <button
        type="button"
        className={`rounded-lg bg-secondary dark:bg-dark-secondary px-3 py-2 hover:opacity-80 disabled:opacity-50 ${
          fullWidth ? "w-full" : ""
        }`}
        onClick={() => dialog.current?.showModal()}
        disabled={auth.loading}
      >
        {auth.profile
          ? compact
            ? "Account"
            : `@${auth.profile.handle}`
          : label ?? (compact ? "Log in" : "Log in with Bluesky")}
      </button>
      <BlueskyLoginDialog ref={dialog} />
    </div>
  );
}

/** The sign-in dialog on its own, closed until its owner calls `showModal()` on `ref`. */
export function BlueskyLoginDialog({ ref }: { ref: RefObject<HTMLDialogElement | null> }) {
  const auth = useSyncExternalStore(subscribeBlueskyAuth, getBlueskyAuthSnapshot, getBlueskyAuthServerSnapshot);
  const id = useId();
  const [handle, setHandle] = useState("");
  return (
    <dialog
      ref={ref}
      aria-labelledby={`${id}-title`}
      className="m-auto text-sm tracking-normal w-[calc(100%-2rem)] max-w-sm rounded-2xl border border-[color:color-mix(in_srgb,currentColor_20%,transparent)] bg-secondary dark:bg-dark-primary p-6 text-text dark:text-dark-text shadow-xl backdrop:bg-[rgba(0,0,0,0.5)]"
    >
      <div className="flex items-center justify-between gap-4 mb-4">
        <h2 id={`${id}-title`} className="text-xl">
          {auth.profile ? "Your Bluesky account" : "Log in with Bluesky"}
        </h2>
        <button type="button" aria-label="Close sign-in" onClick={() => ref.current?.close()} className="p-2">
          <CloseIcon size={20} aria-hidden="true" />
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
              if (!getBlueskyAuthSnapshot().profile) ref.current?.close();
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
  );
}
