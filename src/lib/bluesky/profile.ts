import { asRecord, stringField } from "@/lib/activity/validation";

export interface BlueskyProfile {
  avatar?: string;
  description?: string;
}

const PROFILE_URL = "https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=kualta.dev";

/** keeps only what the page shows, and only an avatar served from Bluesky's own CDN */
export function parseBlueskyProfile(value: unknown): BlueskyProfile {
  const profile = asRecord(value);
  const avatar = stringField(profile, "avatar");
  return {
    avatar: avatar?.startsWith("https://cdn.bsky.app/") ? avatar : undefined,
    description: stringField(profile, "description")?.trim() || undefined,
  };
}

/**
 * Read once while the page is built. A slow or failed AppView costs the page
 * its avatar and bio, never the build.
 */
export async function loadBlueskyProfile(fetcher: typeof fetch = fetch, timeoutMs = 5_000): Promise<BlueskyProfile> {
  try {
    const response = await fetcher(PROFILE_URL, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok ? parseBlueskyProfile(await response.json()) : {};
  } catch {
    return {};
  }
}
