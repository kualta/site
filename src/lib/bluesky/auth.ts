import type { Agent } from "@atproto/api";
import type { BrowserOAuthClient } from "@atproto/oauth-client-browser";
import { BLUESKY_SCOPE, blueskyClientMetadata } from "./metadata";

export interface BlueskyAuthSnapshot {
  agent: Agent | null;
  canUploadMedia?: boolean;
  loading: boolean;
  /** The stored session has not been checked yet, so signed-out is not known. */
  restoring: boolean;
  error: string | null;
  profile: { did: string; handle: string; displayName?: string; avatar?: string } | null;
}
type BlueskyProfile = NonNullable<BlueskyAuthSnapshot["profile"]>;
interface RememberedAccount {
  profile: BlueskyProfile;
  canUploadMedia: boolean;
}
const ACCOUNT_KEY = "bluesky-account:v1";
/** The last signed-in account, read back from storage that anything on the origin could have written. */
export function parseRememberedAccount(value: string | null): RememberedAccount | null {
  try {
    const stored = JSON.parse(value ?? "null");
    const profile = stored?.profile;
    if (typeof profile?.did !== "string" || !profile.did.startsWith("did:") || typeof profile.handle !== "string")
      return null;
    return {
      profile: {
        did: profile.did,
        handle: profile.handle,
        displayName: typeof profile.displayName === "string" ? profile.displayName : undefined,
        avatar: typeof profile.avatar === "string" && profile.avatar.startsWith("https://") ? profile.avatar : undefined,
      },
      canUploadMedia: stored.canUploadMedia === true,
    };
  } catch {
    return null;
  }
}
function storedAccount(): string | null {
  try {
    return localStorage.getItem(ACCOUNT_KEY);
  } catch {
    return null;
  }
}
function rememberAccount(account: RememberedAccount | null) {
  try {
    if (!account) localStorage.removeItem(ACCOUNT_KEY);
    else {
      const { did, handle, displayName, avatar } = account.profile;
      const profile = { did, handle, displayName, avatar };
      localStorage.setItem(ACCOUNT_KEY, JSON.stringify({ profile, canUploadMedia: account.canUploadMedia }));
    }
  } catch {
    /* Storage may be unavailable; the session still restores, only later. */
  }
}
const initial: BlueskyAuthSnapshot = { agent: null, loading: true, restoring: true, error: null, profile: null };
// A reload shows the remembered account straight away; `agent` stays null, so
// nothing can be posted until the stored session has actually been restored.
const remembered = typeof window === "undefined" ? null : parseRememberedAccount(storedAccount());
let snapshot: BlueskyAuthSnapshot = remembered ? { ...initial, ...remembered } : initial;
let client: BrowserOAuthClient | undefined;
let initialization: Promise<void> | undefined;
const listeners = new Set<() => void>();
function update(value: Partial<BlueskyAuthSnapshot>) {
  snapshot = { ...snapshot, ...value };
  for (const listener of listeners) listener();
}
export const getBlueskyAuthSnapshot = () => snapshot;
export const getBlueskyAuthServerSnapshot = () => initial;
export function subscribeBlueskyAuth(listener: () => void) {
  listeners.add(listener);
  void initializeBlueskyAuth();
  return () => {
    listeners.delete(listener);
  };
}
export function normalizeBlueskyCallbackUrl(location: Pick<Location, "pathname" | "search" | "hash">, history: Pick<History, "replaceState" | "state">) {
  // Cloudflare adds a trailing slash to this static page. The SDK matches
  // redirect_uri paths exactly, so fix the URL without another HTTP redirect.
  if (location.pathname === "/auth/bluesky/")
    history.replaceState(history.state, "", `/auth/bluesky${location.search}${location.hash}`);
}
export function safeReturnPath(value: string | null | undefined): string {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\u0000-\u0020\u007f]/.test(value)
  )
    return "/";
  const url = new URL(value, "https://kualta.dev");
  return url.origin === "https://kualta.dev" && !/^\/auth\/bluesky\/?$/.test(url.pathname)
    ? `${url.pathname}${url.search}${url.hash}`
    : "/";
}
export function initializeBlueskyAuth(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  return (initialization ??= initialize());
}
async function initialize() {
  try {
    // This module uses browser globals at import time; keep it out of SSR.
    const [{ BrowserOAuthClient }, { Agent }] = await Promise.all([
      import("@atproto/oauth-client-browser"),
      import("@atproto/api"),
    ]);
    const { origin, hostname } = window.location;
    const options = {
      handleResolver: "https://bsky.social",
      onSessionDeleted: (did: string) => {
        if (snapshot.profile?.did !== did) return;
        rememberAccount(null);
        update({ agent: null, profile: null, loading: false });
      },
    };
    if (["localhost", "127.0.0.1", "[::1]"].includes(hostname)) {
      if (hostname === "localhost") {
        const url = new URL(window.location.href);
        url.hostname = "127.0.0.1";
        window.location.replace(url.href);
        return;
      }
      const params = new URLSearchParams({ redirect_uri: `${origin}/auth/bluesky`, scope: BLUESKY_SCOPE });
      client = await BrowserOAuthClient.load({ clientId: `http://localhost?${params}`, ...options });
    } else {
      client = new BrowserOAuthClient({ clientMetadata: blueskyClientMetadata(origin), ...options });
    }
    normalizeBlueskyCallbackUrl(window.location, window.history);
    // Restore from storage alone: a stale access token is refreshed by the
    // first request that needs it rather than holding up every page load.
    const result = await client.init(false);
    if (result) {
      const { session } = result;
      const agent = new Agent(session);
      const { scope } = await session.getTokenInfo(false);
      const permissions = scope.split(" ");
      const canUploadMedia =
        permissions.includes("blob:*/*") ||
        ["blob:image/png", "blob:video/mp4"].every((value) => permissions.includes(value));
      const known = snapshot.profile?.did === session.sub ? snapshot.profile : null;
      const profile = known ?? (await fetchProfile(agent, session.sub)) ?? { did: session.sub, handle: session.sub };
      update({ agent, profile, canUploadMedia, loading: false, restoring: false, error: null });
      rememberAccount({ profile, canUploadMedia });
      // A remembered profile is shown first and brought up to date afterwards.
      if (known)
        void fetchProfile(agent, session.sub).then((fresh) => {
          if (!fresh || snapshot.agent !== agent) return;
          update({ profile: fresh });
          rememberAccount({ profile: fresh, canUploadMedia });
        });
      if (window.location.pathname === "/auth/bluesky") {
        window.location.replace(safeReturnPath(result.state));
      }
    } else {
      rememberAccount(null);
      update({ loading: false, restoring: false, profile: null });
    }
  } catch (error) {
    rememberAccount(null);
    update({
      agent: null,
      profile: null,
      loading: false,
      restoring: false,
      error: error instanceof Error ? error.message : "Bluesky sign-in failed. Please try again.",
    });
  }
}
function fetchProfile(agent: Agent, actor: string): Promise<BlueskyProfile | null> {
  return agent
    .getProfile({ actor })
    .then(({ data }) => data)
    .catch(() => null);
}
export async function getBlueskyAgent(): Promise<Agent | null> {
  await initializeBlueskyAuth();
  return snapshot.agent;
}
export async function signIn(handle: string) {
  await initializeBlueskyAuth();
  if (!client) {
    initialization = undefined;
    await initializeBlueskyAuth();
  }
  const input = handle.trim().replace(/^@/, "");
  if (!input) throw new Error("Enter your Bluesky handle.");
  update({ loading: true, error: null });
  try {
    if (!client) throw new Error("Unable to initialize Bluesky sign-in.");
    await client.signInRedirect(input, {
      scope: BLUESKY_SCOPE,
      state: safeReturnPath(`${window.location.pathname}${window.location.search}${window.location.hash}`),
    });
  } catch (error) {
    update({ loading: false, error: error instanceof Error ? error.message : "Unable to sign in." });
    throw error;
  }
}
export async function signOut() {
  const did = snapshot.profile?.did;
  update({ loading: true, error: null });
  try {
    if (did && client) await client.revoke(did);
    rememberAccount(null);
    update({ agent: null, profile: null, loading: false });
  } catch (error) {
    update({ loading: false, error: error instanceof Error ? error.message : "Unable to sign out. Please try again." });
  }
}
