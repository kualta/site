import { type Account, accounts } from "./presets";
import type { MediaBucket } from "./server";

/**
 * Which connected browser accounts the laptop last found signed out: their Chrome profile has lost the sign-in cookie,
 * as every one did when a Chrome update emptied their cookie stores. The laptop sends it when it changes and hourly, and
 * it's kept in the media bucket (R2 Standard, with a free allowance), not D1, whose daily read cap the composer's polling
 * has reached before; being rewritten, it outlasts the bucket's expiry.
 */
const SESSIONS = "helper/sessions.json";

/** The accounts named in `value`, each once, in the composer's order; nothing for anything else. */
export function signedOutOf(value: unknown): Account[] {
  return Array.isArray(value) ? accounts.filter((account) => value.includes(account)) : [];
}

/** What the laptop last said is signed out; nothing when it hasn't said, or that can't be read. */
export async function readSignedOut(media: Pick<MediaBucket, "get">): Promise<Account[]> {
  try {
    const object = await media.get(SESSIONS);
    if (!object) return [];
    return signedOutOf((JSON.parse(await new Response(object.body).text()) as { signedOut?: unknown }).signedOut);
  } catch {
    return [];
  }
}

/** Keeps what the laptop sent, `{ signedOut }`, and returns what was kept. */
export async function saveSignedOut(media: Pick<MediaBucket, "put">, sent: unknown): Promise<Account[]> {
  const signedOut = signedOutOf((sent as { signedOut?: unknown } | null)?.signedOut);
  await media.put(SESSIONS, JSON.stringify({ signedOut }), { httpMetadata: { contentType: "application/json" } });
  return signedOut;
}
