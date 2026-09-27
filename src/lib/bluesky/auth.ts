import type { Agent } from "@atproto/api";
import type { BrowserOAuthClient } from "@atproto/oauth-client-browser";
import { BLUESKY_SCOPE, blueskyClientMetadata } from "./metadata";

export interface BlueskyAuthSnapshot {
  agent: Agent | null;
  canUploadMedia?: boolean;
  loading: boolean;
  error: string | null;
  profile: { did: string; handle: string; displayName?: string; avatar?: string } | null;
}
const initial: BlueskyAuthSnapshot = { agent: null, loading: true, error: null, profile: null };
let snapshot = initial;
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
  return url.origin === "https://kualta.dev" && url.pathname !== "/auth/bluesky"
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
        if (snapshot.profile?.did === did) update({ agent: null, profile: null, loading: false });
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
    const result = await client.init();
    if (result) {
      const agent = new Agent(result.session);
      const profile = await agent
        .getProfile({ actor: result.session.sub })
        .then(({ data }) => data)
        .catch(() => ({ did: result.session.sub, handle: result.session.sub }));
      const { scope } = await result.session.getTokenInfo();
      const permissions = scope.split(" ");
      const canUploadMedia =
        permissions.includes("blob:*/*") ||
        ["blob:image/png", "blob:video/mp4"].every((value) => permissions.includes(value));
      update({ agent, profile, canUploadMedia, loading: false, error: null });
      if (window.location.pathname === "/auth/bluesky") {
        window.location.replace(safeReturnPath(result.state));
      }
    } else update({ loading: false });
  } catch (error) {
    update({
      loading: false,
      error: error instanceof Error ? error.message : "Bluesky sign-in failed. Please try again.",
    });
  }
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
    update({ agent: null, profile: null, loading: false });
  } catch (error) {
    update({ loading: false, error: error instanceof Error ? error.message : "Unable to sign out. Please try again." });
  }
}
